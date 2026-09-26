<?php

namespace App\Console\Commands;

use Carbon\CarbonInterface;
use Illuminate\Console\Command;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Schema;
use RuntimeException;
use Throwable;

/**
 * Import the street network from OpenStreetMap via Overpass.
 *
 * This is the enabler for the route editor. Snapping a dragged vertex onto a
 * street, and checking that a route does not run against a one-way, both need
 * the road network locally. Without it, "move the nearby vertices along this
 * street" is interpolation and the direction of a street is unknown.
 *
 * Two decisions shape the implementation.
 *
 * The bounding box defaults to the extent of the lines table rather than a
 * hardcoded city. There is no reason to download roads that no line can be
 * routed through, and it self-maintains as lines are added or moved.
 *
 * The box is queried in tiles. A single Overpass request for every road class
 * across a metropolitan area is large enough to exhaust the public instance's
 * memory. Tiling keeps each request small and makes the run resumable: ways
 * that straddle a boundary are upserted on their OSM id, so the overlap costs
 * a duplicate lookup rather than a duplicate row, and a re-run repairs gaps
 * instead of starting over.
 */
class RoadsImportOverpass extends Command
{
    protected $signature = 'roads:import-overpass
        {--bbox= : Area to import, as west,south,east,north. Defaults to the extent of the lines table, padded}
        {--pad=0.02 : Degrees of padding around the lines extent, roughly 2km}
        {--tile=0.1 : Tile size in degrees}
        {--truncate : Empty the table before importing}
        {--dry-run : Query and report without writing}
        {--sample=1500 : Line vertices to sample for the coverage report}';

    protected $description = 'Import the street network from OpenStreetMap for route snapping and oneway checks';

    /**
     * Road classes a bus can legally and usefully run on.
     *
     * Excluded on purpose: footway, path, steps, pedestrian, cycleway and track
     * are not drivable, and `service` is overwhelmingly driveways, parking
     * aisles and alleys — a large share of OSM volume with no value here. Link
     * roads are excluded because a vertex snapped onto an intersection slip
     * road is a mistake, not an edit.
     */
    private const HIGHWAY_CLASSES = [
        'motorway',
        'trunk',
        'primary',
        'secondary',
        'tertiary',
        'residential',
        'unclassified',
        'living_street',
        'road',
    ];

    /** One-way against the way's own node order. */
    private const ONEWAY_BACKWARD = 'backward';

    /** One-way along the way's own node order. */
    private const ONEWAY_FORWARD = 'forward';

    private const ONEWAY_NO = 'no';

    /**
     * Public Overpass instances, tried in order.
     *
     * They rate-limit and occasionally time out, and a run spanning dozens of
     * tiles will meet that. Abandoning the import because one mirror had a bad
     * minute is not useful.
     */
    private const MIRRORS = [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://overpass.private.coffee/api/interpreter',
        'https://lz4.overpass-api.de/api/interpreter',
    ];

    /**
     * Overpass answers 406 to clients that do not identify themselves, and the
     * policy asks for a contact a human can use.
     */
    private const USER_AGENT = 'tu-cromi-admin/1.0 (route editor street import)';

    /** Overpass-side budget, deliberately below the client timeout. */
    private const SERVER_TIMEOUT_SECONDS = 180;

    private const CLIENT_TIMEOUT_SECONDS = 240;

    private const MIRROR_ATTEMPTS = 2;

    public function handle(): int
    {
        if (Schema::getConnection()->getDriverName() !== 'pgsql') {
            $this->error('The roads table only exists on PostgreSQL, so there is nothing to import into.');

            return self::FAILURE;
        }

        $dryRun = (bool) $this->option('dry-run');

        if (! $dryRun && $this->option('truncate')) {
            $this->warn('Truncating roads...');
            DB::statement('TRUNCATE TABLE roads');
        }

        try {
            [$west, $south, $east, $north] = $this->resolveBbox();
        } catch (Throwable $e) {
            $this->error($e->getMessage());

            return self::FAILURE;
        }

        $this->info(sprintf(
            'Area: %.4f,%.4f to %.4f,%.4f — about %.0f x %.0f km.',
            $south,
            $west,
            $north,
            $east,
            ($east - $west) * 111.32,
            ($north - $south) * 110.57,
        ));

        $tiles = $this->tileBbox($west, $south, $east, $north, (float) $this->option('tile'));

        $this->info(sprintf('Querying %d tile(s)...', count($tiles)));

        $totalWays = 0;
        $totalPoints = 0;
        $failed = 0;

        foreach ($tiles as $index => [$tileWest, $tileSouth, $tileEast, $tileNorth]) {
            $elements = $this->fetchTile($index, $tileWest, $tileSouth, $tileEast, $tileNorth);

            if ($elements === null) {
                $failed++;
                $this->newLine();
                $this->warn(sprintf('  tile %d/%d could not be fetched, skipping', $index + 1, count($tiles)));
                $this->output->write('  ');

                continue;
            }

            $points = $this->persist($elements, $dryRun);

            $totalWays += count($elements);
            $totalPoints += $points;

            $this->output->write(sprintf(
                "\r  tile %d/%d | %d ways | %s points        ",
                $index + 1,
                count($tiles),
                $totalWays,
                number_format($totalPoints),
            ));
        }

        $this->newLine(2);

        if ($totalWays === 0) {
            $this->error('No roads retrieved. Either the area is unmapped in OSM or every mirror is refusing the request.');

            return self::FAILURE;
        }

        $this->info(sprintf(
            '%s %d ways covering %s points across %d tiles.',
            $dryRun ? 'Would import' : 'Imported',
            $totalWays,
            number_format($totalPoints),
            count($tiles) - $failed,
        ));

        if ($failed > 0) {
            $this->warn(sprintf(
                '%d tile(s) failed. Re-run to fill the gaps: already-imported ways are upserted, not duplicated.',
                $failed,
            ));
        }

        $this->reportCoverage((int) $this->option('sample'), $dryRun);

        return self::SUCCESS;
    }

    /**
     * @return array{0: float, 1: float, 2: float, 3: float}
     */
    private function resolveBbox(): array
    {
        $explicit = $this->option('bbox');

        if (is_string($explicit) && trim($explicit) !== '') {
            return $this->parseBbox($explicit);
        }

        $extent = DB::selectOne(
            'SELECT ST_XMin(b) AS w, ST_YMin(b) AS s, ST_XMax(b) AS e, ST_YMax(b) AS n
             FROM (SELECT ST_Extent(geom) AS b FROM lines WHERE geom IS NOT NULL) t'
        );

        if ($extent === null || $extent->w === null) {
            throw new RuntimeException('No line geometry to derive an area from. Pass --bbox explicitly.');
        }

        $pad = (float) $this->option('pad');

        return [
            (float) $extent->w - $pad,
            (float) $extent->s - $pad,
            (float) $extent->e + $pad,
            (float) $extent->n + $pad,
        ];
    }

    /**
     * @return array{0: float, 1: float, 2: float, 3: float}
     */
    private function parseBbox(string $raw): array
    {
        $parts = array_map('trim', explode(',', $raw));

        if (count($parts) !== 4) {
            throw new RuntimeException(
                '--bbox needs four comma-separated numbers: west,south,east,north'
            );
        }

        foreach ($parts as $part) {
            if (! is_numeric($part)) {
                throw new RuntimeException(sprintf(
                    '--bbox value "%s" is not a number. Expected west,south,east,north.',
                    $part,
                ));
            }
        }

        $values = array_map('floatval', $parts);

        if ($values[0] >= $values[2] || $values[1] >= $values[3]) {
            throw new RuntimeException('--bbox west must be less than east, and south less than north.');
        }

        return $values;
    }

    /**
     * @return list<array{0: float, 1: float, 2: float, 3: float}>
     */
    private function tileBbox(float $west, float $south, float $east, float $north, float $size): array
    {
        $tiles = [];

        for ($y = $south; $y < $north; $y += $size) {
            for ($x = $west; $x < $east; $x += $size) {
                $tiles[] = [$x, $y, min($x + $size, $east), min($y + $size, $north)];
            }
        }

        return $tiles;
    }

    /**
     * Fetch one tile, rotating the starting mirror per tile.
     *
     * Rotating matters over a long run: without it every request retries the
     * same instance while that one recovers, and the run crawls.
     *
     * @return list<array<string, mixed>>|null Null when every mirror failed.
     */
    private function fetchTile(int $tileIndex, float $west, float $south, float $east, float $north): ?array
    {
        $query = $this->buildQuery($west, $south, $east, $north);
        $mirrors = self::MIRRORS;
        $rotate = $tileIndex % count($mirrors);

        $ordered = array_merge(
            array_slice($mirrors, $rotate),
            array_slice($mirrors, 0, $rotate),
        );

        foreach ($ordered as $mirror) {
            for ($attempt = 0; $attempt < self::MIRROR_ATTEMPTS; $attempt++) {
                try {
                    $response = Http::withUserAgent(self::USER_AGENT)
                        ->timeout(self::CLIENT_TIMEOUT_SECONDS)
                        ->get($mirror, ['data' => $query]);
                } catch (ConnectionException $e) {
                    $this->line(sprintf('      %s: %s', $mirror, $e->getMessage()));

                    continue;
                }

                if ($response->successful()) {
                    $decoded = json_decode($response->body(), true);

                    if (is_array($decoded) && is_array($decoded['elements'] ?? null)) {
                        return array_values(array_filter(
                            $decoded['elements'],
                            fn (mixed $element): bool => is_array($element),
                        ));
                    }

                    $this->line(sprintf('      %s: 200 but the body was not usable JSON', $mirror));
                } else {
                    $this->line(sprintf('      %s: HTTP %d', $mirror, $response->status()));
                }
            }
        }

        return null;
    }

    private function buildQuery(float $west, float $south, float $east, float $north): string
    {
        return sprintf(
            '[out:json][timeout:%d];way["highway"~"^(%s)$"](%F,%F,%F,%F);out geom;',
            self::SERVER_TIMEOUT_SECONDS,
            implode('|', self::HIGHWAY_CLASSES),
            $south,
            $west,
            $north,
            $east,
        );
    }

    /**
     * Turn raw Overpass elements into rows and write them.
     *
     * Upsert rather than insert because a way straddling a tile boundary comes
     * back twice, and a partial re-run should repair rows instead of colliding
     * with them.
     *
     * @param  list<array<string, mixed>>  $elements
     * @return int Total point count across the accepted ways.
     */
    private function persist(array $elements, bool $dryRun): int
    {
        $now = now();
        $rows = [];

        foreach ($elements as $element) {
            $row = $this->toRow($element, $now);

            if ($row !== null) {
                $rows[] = $row;
            }
        }

        $pointCount = array_sum(array_column($rows, 'point_count'));

        if ($rows === [] || $dryRun) {
            return $pointCount;
        }

        foreach (array_chunk($rows, 400) as $chunk) {
            $this->upsertChunk($chunk);
        }

        return $pointCount;
    }

    /**
     * Insert a batch of roads, updating rows that already exist.
     *
     * Written by hand rather than through the query builder's upsert() because
     * geom has to be built by ST_GeomFromGeoJSON, and upsert() concatenates its
     * values into the statement instead of binding them. The only way to reach
     * that expression through the builder is DB::raw(), which means splicing
     * json_encode output into SQL text.
     *
     * That is safe here — the payload is nothing but floats — but "safe because
     * the data happens to be clean" is exactly how an injection lands later.
     * Bindings cost one loop and remove the question.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function upsertChunk(array $rows): void
    {
        $tuples = [];
        $bindings = [];

        foreach ($rows as $i => $row) {
            $suffix = $i;

            $tuples[] = "(:osm_{$suffix}, :name_{$suffix}, :highway_{$suffix}, :oneway_{$suffix}, :points_{$suffix}, ST_GeomFromGeoJSON(:geom_{$suffix}), :created_{$suffix}, :updated_{$suffix})";

            $bindings["osm_{$suffix}"] = $row['osm_id'];
            $bindings["name_{$suffix}"] = $row['name'];
            $bindings["highway_{$suffix}"] = $row['highway'];
            $bindings["oneway_{$suffix}"] = $row['oneway'];
            $bindings["points_{$suffix}"] = $row['point_count'];
            $bindings["geom_{$suffix}"] = $row['geo_json'];
            $bindings["created_{$suffix}"] = (string) $row['created_at'];
            $bindings["updated_{$suffix}"] = (string) $row['updated_at'];
        }

        DB::statement(
            'INSERT INTO roads
                 (osm_id, name, highway, oneway, point_count, geom, created_at, updated_at)
             VALUES '.implode(', ', $tuples).'
             ON CONFLICT (osm_id) DO UPDATE SET
                 name = EXCLUDED.name,
                 highway = EXCLUDED.highway,
                 oneway = EXCLUDED.oneway,
                 point_count = EXCLUDED.point_count,
                 geom = EXCLUDED.geom,
                 updated_at = EXCLUDED.updated_at',
            $bindings,
        );
    }

    /**
     * @param  array<string, mixed>  $element
     * @return array<string, mixed>|null Null when the way is unusable or not a
     *                                   class we keep.
     */
    private function toRow(array $element, CarbonInterface $now): ?array
    {
        if (($element['type'] ?? null) !== 'way' || ! isset($element['id'])) {
            return null;
        }

        $tags = is_array($element['tags'] ?? null) ? $element['tags'] : [];
        $highway = (string) ($tags['highway'] ?? '');

        if (! in_array($highway, self::HIGHWAY_CLASSES, true)) {
            return null;
        }

        $geometry = $element['geometry'] ?? null;

        if (! is_array($geometry) || count($geometry) < 2) {
            return null;
        }

        $coordinates = [];

        foreach ($geometry as $node) {
            if (! is_array($node) || ! isset($node['lat'], $node['lon'])) {
                return null;
            }

            // Overpass emits {lat, lon}; the project stores [lng, lat].
            $coordinates[] = [(float) $node['lon'], (float) $node['lat']];
        }

        $geoJson = json_encode(['type' => 'MultiLineString', 'coordinates' => [$coordinates]]);

        if ($geoJson === false) {
            return null;
        }

        return [
            'osm_id' => (int) $element['id'],
            'name' => isset($tags['name']) ? (string) $tags['name'] : null,
            'highway' => $highway,
            'oneway' => $this->resolveOneway($tags),
            'point_count' => count($coordinates),
            'geo_json' => $geoJson,
            'created_at' => $now,
            'updated_at' => $now,
        ];
    }

    /**
     * Resolve OSM's oneway into a direction an audit can compare against.
     *
     * `yes` and `-1` are genuinely opposite directions rather than a boolean
     * pair, and several things imply one-way without being tagged as such:
     * roundabouts are one-way by construction, and a motorway is one-way unless
     * something says otherwise.
     *
     * @param  array<string, mixed>  $tags
     */
    private function resolveOneway(array $tags): string
    {
        $explicit = isset($tags['oneway']) ? strtolower((string) $tags['oneway']) : null;

        if ($explicit === '-1') {
            return self::ONEWAY_BACKWARD;
        }

        if (in_array($explicit, ['yes', 'true', '1'], true)) {
            return self::ONEWAY_FORWARD;
        }

        if (in_array($explicit, ['no', 'false', '0', 'reversible'], true)) {
            return self::ONEWAY_NO;
        }

        $junction = strtolower((string) ($tags['junction'] ?? ''));

        if (in_array($junction, ['roundabout', 'circular'], true)) {
            return self::ONEWAY_FORWARD;
        }

        return (string) ($tags['highway'] ?? null) === 'motorway'
            ? self::ONEWAY_FORWARD
            : self::ONEWAY_NO;
    }

    /**
     * How much of the existing route network actually has a street under it.
     *
     * This is the number that decides whether the source is worth anything. A
     * sparse import still produces a plausible-looking table, so the only way
     * to know is to measure the routes against it.
     */
    private function reportCoverage(int $sample, bool $dryRun): void
    {
        $total = (int) DB::selectOne(
            'SELECT count(*) AS n
             FROM (SELECT (ST_DumpPoints(ST_GeometryN(geom, 1))).path[1] AS idx FROM lines WHERE geom IS NOT NULL) t'
        )->n;

        if ($total === 0) {
            $this->warn('No line geometry to measure coverage against.');

            return;
        }

        $step = max(1, (int) floor($total / max(1, $sample)));

        $near = (int) DB::selectOne(
            "WITH vertices AS (
                 SELECT (ST_DumpPoints(ST_GeometryN(l.geom, 1))).path[1] AS idx,
                        (ST_DumpPoints(ST_GeometryN(l.geom, 1))).geom AS p
                 FROM lines l
                 WHERE l.geom IS NOT NULL
             )
             SELECT count(*) AS n
             FROM vertices v
             WHERE v.p IS NOT NULL
               AND v.idx % $step = 0
               AND EXISTS (
                   SELECT 1 FROM roads r
                   WHERE ST_DWithin(r.geom::geography, v.p::geography, 40)
               )"
        )->n;

        $this->line('');
        $this->info(sprintf(
            'Coverage: %s of %s sampled line vertices sit within 40m of a road (%d%%).',
            number_format($near),
            number_format((int) floor($total / $step)),
            $near > 0 ? (int) round(100 * $near / floor($total / $step)) : 0,
        ));

        if ($dryRun) {
            return;
        }

        $stats = DB::selectOne(
            "SELECT count(*) AS ways,
                    count(*) FILTER (WHERE oneway <> 'no') AS oneway_ways,
                    count(DISTINCT name) AS named,
                    count(*) FILTER (WHERE name IS NOT NULL) AS named_ways
             FROM roads"
        );

        $this->info(sprintf(
            'Table: %s ways, %s of them one-way, %s distinct street names.',
            number_format((int) $stats->ways),
            number_format((int) $stats->oneway_ways),
            number_format((int) $stats->named),
        ));

        $onewayShare = $stats->ways > 0 ? (int) round(100 * $stats->oneway_ways / $stats->ways) : 0;
        $namedShare = $stats->ways > 0 ? (int) round(100 * $stats->named_ways / $stats->ways) : 0;

        $this->line(sprintf('  one-way tagged: %d%%   named: %d%%', $onewayShare, $namedShare));

        if ($onewayShare < 5) {
            $this->warn(
                'Fewer than 5% of roads are tagged one-way. OSM oneway coverage here is too thin to audit against: fine for snapping, not for direction checks.'
            );
        }

        if ($namedShare < 40) {
            $this->warn(
                'Fewer than 40% of roads carry a name. Useful as a review hint, but not enough to identify a terminal by hand.'
            );
        }
    }
}
