<?php

namespace App\Console\Commands;

use App\Models\Line;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Restore one line's geometry from the source GeoJSON.
 *
 * The counterpart to lines:refresh-geometry's UI button, and the deliberate way
 * to take a geometry update from a new source file. The import will never do
 * it on its own: an import that overwrote existing geometry would discard every
 * manual direction correction the moment anyone ran it, silently and by
 * default. Refreshing is therefore one code at a time, with the loss stated.
 *
 * Restoring resets geometry_adjusted because the row is once again exactly
 * what the source produced. A line with no counterpart, and therefore nothing
 * to re-orient, is left alone: the geometry is still restored, but the flag
 * stays false because there is no paired correction to invalidate.
 */
class LinesRefreshGeometry extends Command
{
    protected $signature = 'lines:refresh-geometry
        {code : The line code to restore, e.g. "4" or "66 azul"}
        {--path= : Path to the GeoJSON file}';

    protected $description = 'Restore one line\'s geometry from the source GeoJSON, discarding manual corrections';

    public function handle(): int
    {
        $code = (string) $this->argument('code');
        $path = $this->option('path') ?: database_path('data/rutas_scz.geojson');

        if (! file_exists($path)) {
            $this->error("GeoJSON file not found: {$path}");

            return self::FAILURE;
        }

        $lines = Line::query()->where('code', $code)->get();

        if ($lines->isEmpty()) {
            $this->error("No line found with code '{$code}'.");

            return self::FAILURE;
        }

        $features = $this->featuresBySense($path, $code);

        if ($features === []) {
            $this->error("The source has no line with code '{$code}'.");

            return self::FAILURE;
        }

        $refreshed = 0;

        DB::transaction(function () use ($lines, $features, $code, &$refreshed): void {
            foreach ($lines as $line) {
                $feature = $features[$line->sense->value] ?? null;

                if ($feature === null) {
                    $this->warn("The source has no {$line->sense->value} for code '{$code}'. Left untouched.");

                    continue;
                }

                $line->geo_json = Line::geometryFromSourceFeature($feature);
                $line->geometry_adjusted = false;
                $line->save();
                $line->syncGeometry();

                $refreshed++;
            }
        });

        $this->info("Restored {$refreshed} ".Str::plural('record', $refreshed).' from the source.');

        $ids = $lines->pluck('id')->all();

        $transfers = DB::table('line_transfers')
            ->whereIn('line_a_id', $ids)
            ->orWhereIn('line_b_id', $ids)
            ->count();

        if ($transfers > 0) {
            $this->warn(sprintf(
                '%d %s now hold stale point indexes. Re-run transfers:compute before shipping the offline bundle.',
                $transfers,
                Str::plural('transfer', $transfers),
            ));
        }

        return self::SUCCESS;
    }

    /**
     * Source features for one code, keyed by the sense they map to.
     *
     * @return array<string, array<string, mixed>>
     */
    private function featuresBySense(string $path, string $code): array
    {
        $data = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);

        $bySense = [];

        foreach ($data['features'] ?? [] as $feature) {
            if (! is_array($feature)) {
                continue;
            }

            if ((string) (data_get($feature, 'properties.nombre') ?? '') !== $code) {
                continue;
            }

            $sense = Line::senseFromSourceSentido((int) (data_get($feature, 'properties.sentido') ?? 1));

            $bySense[$sense->value] = $feature;
        }

        return $bySense;
    }
}
