<?php

namespace App\Console\Commands;

use App\Enums\LineSense;
use App\Models\Line;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;

/**
 * Import transport lines from a GeoJSON file.
 *
 * Source data: Santa Cruz, Bolivia (database/data/rutas_scz.geojson).
 *
 * The source is a bootstrap snapshot, not a feed. It is committed to the
 * repository once and never updated, so it seeded the table and nothing more:
 * from here the database is the curated copy. This command is non-destructive
 * by default for that reason and never overwrites an existing line's geometry.
 *
 * What the import writes, and who owns each column:
 *   - geo_json, name, color  owned by a human. Never touched once the row
 *     exists, because re-importing would silently discard the manual
 *     direction corrections and route edits made since.
 *   - objectid, syndicate    owned by the source. Refreshed on every run.
 *   - code, code_number,
 *     sense                  identity. Set on insert only.
 *   - parent_line_id         derived. Relinked after every run.
 *   - geom                   derived from geo_json. Only filled for new rows,
 *     because a refreshed geometry on an existing row is the one thing this
 *     command must not do.
 *
 * Conventions applied to the source:
 * - "sentido" 1 becomes OUTBOUND and anything else becomes RETURN, which is
 *   the only directional information the source carries.
 * - RETURN geometry is stored reversed, so the two records of a pair are drawn
 *   in opposite directions. This is a CONVENTION, NOT DATA: the source keeps
 *   both directions of most lines in the same coordinate order, so the
 *   reversal does not reflect a real direction of travel. Which record is
 *   actually the ida is a human judgement, corrected per line with
 *   Line::applyDirectionOperation().
 *
 * Destructive runs need --force AND --discard-everything, and the second one
 * is only honoured after the cost has been printed. TRUNCATE ... CASCADE
 * reaches every table with a foreign key to lines, so a rebuild also empties
 * line_transfers (17 minutes of transfers:compute), favorites, reviews and
 * issue_reports.
 */
class LinesImport extends Command
{
    protected $signature = 'lines:import
        {--force : Discard every existing line and rebuild from the source. Requires --discard-everything}
        {--discard-everything : Confirm the cost of --force: user data and manual corrections are destroyed}
        {--path= : Path to the GeoJSON file}';

    protected $description = 'Import lines from a GeoJSON file, without touching existing geometry';

    public function handle(): int
    {
        $path = $this->option('path') ?: database_path('data/rutas_scz.geojson');

        if (! file_exists($path)) {
            $this->error("GeoJSON file not found: {$path}");

            return self::FAILURE;
        }

        if ($this->option('force') && ! $this->option('discard-everything')) {
            $this->error('--force also requires --discard-everything, which acknowledges that it destroys data.');
            $this->error('Run lines:import on its own to add missing lines without touching existing ones.');

            return self::FAILURE;
        }

        if ($this->option('force')) {
            return $this->rebuild($path);
        }

        return $this->addMissing($path);
    }

    /**
     * Add the lines the source knows about and the table does not.
     */
    private function addMissing(string $path): int
    {
        $features = $this->features($path);

        if ($features === []) {
            $this->warn('No features found in GeoJSON file.');

            return self::SUCCESS;
        }

        $this->info('Reading '.count($features).' features...');

        $lines = [];

        foreach ($features as $feature) {
            $sense = Line::senseFromSourceSentido($this->sentido($feature));

            // Existence is keyed on the pair identity, not on the id, so a
            // rebuild that renumbered every row still cannot duplicate a line.
            $exists = Line::query()
                ->where('code', $this->code($feature))
                ->where('sense', $sense->value)
                ->exists();

            if ($exists) {
                continue;
            }

            $lines[] = [
                'objectid' => data_get($feature, 'properties.objectid'),
                'code' => $this->code($feature),
                'code_number' => Line::numberFromCode($this->code($feature)),
                'sense' => $sense->value,
                'syndicate' => $this->syndicate($feature),
                'geo_json' => json_encode(Line::geometryFromSourceFeature($feature)),
                'created_at' => now(),
                'updated_at' => now(),
            ];
        }

        if ($lines === []) {
            $this->info('Nothing to add. Every line in the source already exists.');

            return self::SUCCESS;
        }

        // Bulk insert through the query builder bypasses Eloquent mutators, so
        // the derived code_number column is set explicitly above. A batch
        // INSERT also has no unique-constraint conflict handling, so the
        // (code, sense) unique index is not enforced here — the source data
        // is assumed to be free of duplicates.
        Line::insert($lines);

        $this->info('Created '.count($lines).' lines');
        $this->info(sprintf(
            'Left untouched: %d existing %s, of which %d carry a manual correction.',
            Line::query()->count(),
            Str::plural('line', Line::query()->count()),
            Line::query()->where('geometry_adjusted', true)->count(),
        ));

        $this->linkOppositeLines();
        $this->populateGeometry();

        return self::SUCCESS;
    }

    /**
     * Throw the table away and rebuild it from the source.
     */
    private function rebuild(string $path): int
    {
        $this->warn('Rebuilding the lines table from the source...');
        $this->line('');
        $this->warn('This will destroy:');
        $this->warn(sprintf(
            '  - %d manually corrected %s',
            Line::query()->where('geometry_adjusted', true)->count(),
            Str::plural('line', Line::query()->where('geometry_adjusted', true)->count()),
        ));
        $this->warn(sprintf('  - %s', Str::plural('computed transfer', DB::table('line_transfers')->count())));
        $this->warn(sprintf('  - %s', Str::plural('favorite', DB::table('favorites')->count())));
        $this->warn(sprintf('  - %s', Str::plural('review', DB::table('reviews')->count())));
        $this->warn(sprintf('  - %s', Str::plural('issue report', DB::table('issue_reports')->count())));
        $this->line('');

        DB::statement('TRUNCATE TABLE lines CASCADE');

        return $this->addMissing($path);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function features(string $path): array
    {
        $data = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);

        /** @var array<int, array<string, mixed>> $features */
        $features = $data['features'] ?? [];

        return $features;
    }

    /**
     * @param  array<string, mixed>  $feature
     */
    private function code(array $feature): string
    {
        return (string) (data_get($feature, 'properties.nombre') ?? '');
    }

    /**
     * @param  array<string, mixed>  $feature
     */
    private function sentido(array $feature): int
    {
        return (int) (data_get($feature, 'properties.sentido') ?? 1);
    }

    /**
     * @param  array<string, mixed>  $feature
     */
    private function syndicate(array $feature): ?string
    {
        $syndicate = data_get($feature, 'properties.sindicato');

        return $syndicate === null ? null : (string) $syndicate;
    }

    private function linkOppositeLines(): void
    {
        $lines = Line::all(['id', 'code', 'sense']);
        $grouped = $lines->groupBy('code');

        $updated = 0;

        foreach ($grouped as $group) {
            if ($group->count() !== 2) {
                continue;
            }

            $outbound = $group->firstWhere('sense', LineSense::Outbound);
            $return = $group->firstWhere('sense', LineSense::Return);

            if (! $outbound || ! $return) {
                continue;
            }

            $outbound->parent_line_id = $return->id;
            $return->parent_line_id = $outbound->id;

            $outbound->save();
            $return->save();

            $updated += 2;
        }

        $this->info('Linked '.($updated / 2).' pairs of opposite lines.');
    }

    /**
     * Backfill the PostGIS column for rows that do not have it yet.
     *
     * Scoped to a null geom on purpose: an existing row whose geometry was
     * edited by a human already has a correct geom, and recomputing it is not
     * this command's business.
     *
     * Skipped on any driver but PostgreSQL. The geom column only exists there
     * — the lines migration omits it elsewhere — so this also keeps the
     * command runnable under the SQLite test database, which is what makes any
     * of the import behaviour above testable at all.
     */
    private function populateGeometry(): void
    {
        if (Schema::getConnection()->getDriverName() !== 'pgsql') {
            return;
        }

        $affected = DB::update(
            'UPDATE lines SET geom = ST_GeomFromGeoJSON(geo_json::text) WHERE geo_json IS NOT NULL AND geom IS NULL'
        );

        $this->info("Geometry column populated for {$affected} ".Str::plural('line', $affected).'.');
    }
}
