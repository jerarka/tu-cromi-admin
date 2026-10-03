<?php

namespace App\Console\Commands;

use App\Geo\GreatCircle;
use App\Models\CommandExecution;
use App\Models\Line;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Precompute pedestrian transfer points between transport lines.
 *
 * 1. Materializes every coordinate from each line's MultiLineString into a
 *    temp table (line_points).
 * 2. Finds candidate line pairs whose geometries are within TRANSFER_RADIUS
 *    (300 m) via ST_DWithIn with geography cast.
 * 3. For each pair, finds the nearest pair of points (one per line) using a
 *    CROSS JOIN LATERAL with the <-> KNN operator.
 * 4. Deduplicates forward transfers using a spatial grid (MIN_SEPARATION = 100 m)
 *    to avoid storing dozens of nearly-identical transfer points.
 * 5. Generates reverse transfers by swapping line_a/line_b, then deduplicates again.
 * 6. Saves all transfers to the line_transfers table.
 *
 * Constants:
 * - TRANSFER_RADIUS: 300 m — maximum walk distance between lines.
 * - MIN_SEPARATION: 100 m — minimum distance between distinct transfer points
 *   on the same line pair (spatial grid cell size for dedup).
 *
 * Two different distance models, on purpose
 * -----------------------------------------
 * walk_distance is computed in PHP with App\Geo\GreatCircle, on the same sphere
 * of radius 6371000 that produces the bundle's cumulative_distance. It is not
 * taken from PostGIS. That is deliberate: the app adds a ride length to a walk
 * length to rank a transfer, and a spherical mean radius disagrees with the
 * spheroid geodesic by +0,38% on north-south legs and -0,05% on east-west ones
 * — about 33 m of phantom distance on a 25 km ride, against a median walk of
 * 46 m. A single scale on both terms is what keeps that from reordering close
 * options.
 *
 * The search, by contrast, stays geodesic: ST_DWithin at TRANSFER_RADIUS and
 * the <-> KNN ordering are PostGIS-only heuristics for finding candidate
 * vertex pairs, never published values. Changing them would silently change
 * which transfers exist at all, and at 300 m the two models differ by at most
 * 1,15 m. Leave them alone.
 */
class TransfersCompute extends Command
{
    protected $signature = 'transfers:compute
        {--batch=3000 : Number of candidate pairs per batch}
        {--limit= : Number of lines to process (for testing)}';

    protected $description = 'Precompute pedestrian transfer points between lines';

    private const TRANSFER_RADIUS = 300;

    private const MIN_SEPARATION = 100;

    public function handle(): int
    {
        $startTime = microtime(true);

        $execution = CommandExecution::create([
            'command' => 'transfers:compute',
            'started_at' => now(),
            'status' => 'running',
            'options' => $this->options(),
        ]);

        try {
            DB::statement('CREATE EXTENSION IF NOT EXISTS postgis');

            $limit = $this->option('limit') ? (int) $this->option('limit') : null;
            $allLines = Line::count();
            $this->info('Lines found: '.($limit ? "{$limit} of {$allLines}" : $allLines));

            $this->info('Materializing route points...');
            $this->materializePoints($limit);

            // ── 1. Find candidate pairs (fast, PostGIS index only) ──────────
            $candidatePairs = $this->findCandidatePairs($limit);
            $totalPairs = count($candidatePairs);
            $this->info("Candidate pairs: {$totalPairs}");

            if ($totalPairs === 0) {
                DB::statement('TRUNCATE TABLE line_transfers CASCADE');

                $execution->update([
                    'status' => 'completed',
                    'finished_at' => now(),
                    'duration_ms' => (int) ((microtime(true) - $startTime) * 1000),
                    'result' => [
                        'success' => true,
                        'transfersCreated' => 0,
                        'duration' => '0.0s',
                    ],
                ]);

                $this->line(json_encode([
                    'success' => true,
                    'transfersCreated' => 0,
                    'duration' => '0.0s',
                ]) ?: '{}');

                return self::SUCCESS;
            }

            // ── 2. Process pairs in batches with progress ───────────────────
            $batchSize = max(1, (int) $this->option('batch'));
            $processedPairs = 0;
            $totalBatches = (int) ceil($totalPairs / $batchSize);

            $this->createTempTransferTable();
            $forwardCount = 0;

            foreach (array_chunk($candidatePairs, $batchSize) as $batchIdx => $batch) {
                $rows = $this->processPairBatch($batch);

                if (! empty($rows)) {
                    $forwardCount += count($rows);

                    foreach (array_chunk($rows, 500) as $chunk) {
                        DB::table('line_transfers_forward')->insert($chunk);
                    }
                }

                unset($rows);

                $processedPairs += count($batch);
                $elapsed = microtime(true) - $startTime;
                $fraction = $processedPairs / $totalPairs;
                $estimatedTotal = $fraction > 0 ? $elapsed / $fraction : 0;
                $remaining = max(0, $estimatedTotal - $elapsed);

                $this->output->write(sprintf(
                    "\rBatch %d/%d | pairs %d/%d | found %d transfers | elapsed %s | ETA %s      ",
                    $batchIdx + 1,
                    $totalBatches,
                    $processedPairs,
                    $totalPairs,
                    $forwardCount,
                    self::formatDuration($elapsed),
                    self::formatDuration($remaining),
                ));
            }

            $forwardCount = DB::table('line_transfers_forward')->count();
            $this->newLine();
            $this->info("Raw forward rows: {$forwardCount}");

            // ── 3. Deduplicate forwards ─────────────────────────────────────
            $cellSize = self::MIN_SEPARATION / 111320.0;

            DB::statement('
                CREATE TEMP TABLE line_transfers_deduped AS
                SELECT DISTINCT ON (line_a_id, line_b_id, grid_a, grid_b)
                    id,
                    line_a_id, line_b_id,
                    point_a_lng, point_a_lat, point_a_index,
                    point_b_lng, point_b_lat, point_b_index,
                    walk_distance
                FROM (
                    SELECT *,
                        FLOOR(point_a_lat / :cell_size)::text || \',\' || FLOOR(point_a_lng / :cell_size)::text AS grid_a,
                        FLOOR(point_b_lat / :cell_size)::text || \',\' || FLOOR(point_b_lng / :cell_size)::text AS grid_b
                    FROM line_transfers_forward
                ) sub
                ORDER BY line_a_id, line_b_id, grid_a, grid_b, id
            ', ['cell_size' => $cellSize]);

            $forwardDeduped = DB::table('line_transfers_deduped')->count();
            $this->info("After dedup: {$forwardDeduped} forward transfers");

            // ── 4. Generate inverse transfers ───────────────────────────────
            DB::statement('
                CREATE TEMP TABLE line_transfers_inverse AS
                SELECT
                    row_number() OVER (ORDER BY id) AS id,
                    line_b_id AS line_a_id,
                    line_a_id AS line_b_id,
                    point_b_lng AS point_a_lng,
                    point_b_lat AS point_a_lat,
                    point_b_index AS point_a_index,
                    point_a_lng AS point_b_lng,
                    point_a_lat AS point_b_lat,
                    point_a_index AS point_b_index,
                    walk_distance
                FROM line_transfers_deduped
            ');

            // ── 5. Deduplicate inverses ─────────────────────────────────────
            DB::statement('
                CREATE TEMP TABLE line_transfers_inverse_deduped AS
                SELECT DISTINCT ON (line_a_id, line_b_id, grid_a, grid_b)
                    id,
                    line_a_id, line_b_id,
                    point_a_lng, point_a_lat, point_a_index,
                    point_b_lng, point_b_lat, point_b_index,
                    walk_distance
                FROM (
                    SELECT *,
                        FLOOR(point_a_lat / :cell_size)::text || \',\' || FLOOR(point_a_lng / :cell_size)::text AS grid_a,
                        FLOOR(point_b_lat / :cell_size)::text || \',\' || FLOOR(point_b_lng / :cell_size)::text AS grid_b
                    FROM line_transfers_inverse
                ) sub
                ORDER BY line_a_id, line_b_id, grid_a, grid_b, id
            ', ['cell_size' => $cellSize]);

            // ── 6. Save ─────────────────────────────────────────────────────
            $forwardFinalCount = DB::table('line_transfers_deduped')->count();
            $inverseFinalCount = DB::table('line_transfers_inverse_deduped')->count();
            $allCount = $forwardFinalCount + $inverseFinalCount;
            $this->info("Total transfers to save: {$allCount}");

            DB::statement('TRUNCATE TABLE line_transfers CASCADE');

            DB::statement('
                INSERT INTO line_transfers
                    (line_a_id, line_b_id,
                     point_a_lng, point_a_lat, point_a_index,
                     point_b_lng, point_b_lat, point_b_index,
                     walk_distance)
                SELECT
                    line_a_id, line_b_id,
                    point_a_lng, point_a_lat, point_a_index,
                    point_b_lng, point_b_lat, point_b_index,
                    walk_distance
                FROM line_transfers_deduped
            ');

            DB::statement('
                INSERT INTO line_transfers
                    (line_a_id, line_b_id,
                     point_a_lng, point_a_lat, point_a_index,
                     point_b_lng, point_b_lat, point_b_index,
                     walk_distance)
                SELECT
                    line_a_id, line_b_id,
                    point_a_lng, point_a_lat, point_a_index,
                    point_b_lng, point_b_lat, point_b_index,
                    walk_distance
                FROM line_transfers_inverse_deduped
            ');

            $duration = number_format(microtime(true) - $startTime, 1);

            $execution->update([
                'status' => 'completed',
                'finished_at' => now(),
                'duration_ms' => (int) ((microtime(true) - $startTime) * 1000),
                'result' => [
                    'success' => true,
                    'transfersCreated' => $allCount,
                    'duration' => "{$duration}s",
                ],
            ]);

            $this->line(json_encode([
                'success' => true,
                'transfersCreated' => $allCount,
                'duration' => "{$duration}s",
            ]) ?: '{}');

            return self::SUCCESS;
        } catch (\Throwable $e) {
            $execution->update([
                'status' => 'failed',
                'finished_at' => now(),
                'duration_ms' => (int) ((microtime(true) - $startTime) * 1000),
                'error' => $e->getMessage()."\n\n".$e->getTraceAsString(),
            ]);

            $this->error($e->getMessage());

            return self::FAILURE;
        }
    }

    /** @return list<array{line_a_id: int, line_b_id: int}> */
    private function findCandidatePairs(?int $limit = null): array
    {
        $fromClause = $limit
            ? '(SELECT id, geom FROM lines ORDER BY id LIMIT :limit)'
            : 'lines';

        $params = ['radius' => self::TRANSFER_RADIUS];
        if ($limit) {
            $params['limit'] = $limit;
        }

        $rows = DB::select("
            SELECT DISTINCT a.id AS line_a_id, b.id AS line_b_id
            FROM {$fromClause} a
            JOIN {$fromClause} b ON a.id <> b.id
            WHERE ST_DWithin(a.geom::geography, b.geom::geography, :radius)
              AND a.id < b.id
        ", $params);

        return array_values(array_map(fn ($r) => [
            'line_a_id' => (int) $r->line_a_id,
            'line_b_id' => (int) $r->line_b_id,
        ], $rows));
    }

    private function materializePoints(?int $limit = null): void
    {
        DB::statement('DROP TABLE IF EXISTS pg_temp.line_points');

        $fromClause = $limit
            ? '(SELECT id, geom FROM lines ORDER BY id LIMIT :limit) l'
            : 'lines l';

        $params = $limit ? ['limit' => $limit] : [];

        DB::statement("
            CREATE TEMP TABLE line_points AS
            SELECT
                l.id AS line_id,
                (dp.path[1] - 1) AS point_index,
                dp.geom AS geom,
                dp.geom::geography AS geog
            FROM {$fromClause}
            CROSS JOIN LATERAL ST_DumpPoints(ST_GeometryN(l.geom, 1)) AS dp
        ", $params);

        DB::statement('CREATE INDEX idx_line_points_geog ON line_points USING GIST (geog)');
        DB::statement('CREATE INDEX idx_line_points_line ON line_points (line_id)');
        DB::statement('ANALYZE line_points');
    }

    private function createTempTransferTable(): void
    {
        DB::statement('DROP TABLE IF EXISTS line_transfers_forward');

        DB::statement('
            CREATE TEMP TABLE line_transfers_forward (
                id SERIAL PRIMARY KEY,
                line_a_id BIGINT NOT NULL,
                line_b_id BIGINT NOT NULL,
                point_a_lng DOUBLE PRECISION NOT NULL,
                point_a_lat DOUBLE PRECISION NOT NULL,
                point_a_index INT NOT NULL,
                point_b_lng DOUBLE PRECISION NOT NULL,
                point_b_lat DOUBLE PRECISION NOT NULL,
                point_b_index INT NOT NULL,
                walk_distance DOUBLE PRECISION NOT NULL
            )
        ');
    }

    /**
     * @param  list<array{line_a_id: int, line_b_id: int}>  $pairs
     * @return list<array{line_a_id: int, line_b_id: int, point_a_lng: float, point_a_lat: float, point_a_index: int, point_b_lng: float, point_b_lat: float, point_b_index: int, walk_distance: float}>
     */
    private function processPairBatch(array $pairs): array
    {
        if (empty($pairs)) {
            return [];
        }

        $valueRows = [];
        $params = [];

        foreach ($pairs as $i => $pair) {
            $aParam = "a_{$i}";
            $bParam = "b_{$i}";
            $valueRows[] = "(:{$aParam}::int, :{$bParam}::int)";
            $params[$aParam] = $pair['line_a_id'];
            $params[$bParam] = $pair['line_b_id'];
        }

        $params['radius'] = self::TRANSFER_RADIUS;

        // walk_distance is absent on purpose: it is derived in PHP from the two
        // coordinates below, so that the bundle's ride lengths and walk lengths
        // come from the same sphere. See the class docblock.
        $sql = '
            WITH pairs (a_id, b_id) AS (
                VALUES '.implode(', ', $valueRows).'
            )
            SELECT
                pairs.a_id AS line_a_id,
                pairs.b_id AS line_b_id,
                pa.point_index AS point_a_index,
                ST_X(pa.geom) AS point_a_lng,
                ST_Y(pa.geom) AS point_a_lat,
                nb.point_index AS point_b_index,
                ST_X(nb.geom) AS point_b_lng,
                ST_Y(nb.geom) AS point_b_lat
            FROM pairs
            JOIN line_points pa ON pa.line_id = pairs.a_id
            CROSS JOIN LATERAL (
                SELECT pb.geom, pb.point_index, pb.geog
                FROM line_points pb
                WHERE pb.line_id = pairs.b_id
                  AND ST_DWithin(pa.geog, pb.geog, :radius)
                ORDER BY pa.geog <-> pb.geog
                LIMIT 1
            ) AS nb
        ';

        $rows = DB::select($sql, $params);

        return array_values(array_map(fn ($r) => [
            'line_a_id' => (int) $r->line_a_id,
            'line_b_id' => (int) $r->line_b_id,
            'point_a_lng' => (float) $r->point_a_lng,
            'point_a_lat' => (float) $r->point_a_lat,
            'point_a_index' => (int) $r->point_a_index,
            'point_b_lng' => (float) $r->point_b_lng,
            'point_b_lat' => (float) $r->point_b_lat,
            'point_b_index' => (int) $r->point_b_index,
            'walk_distance' => GreatCircle::walkMeters(
                [(float) $r->point_a_lng, (float) $r->point_a_lat],
                [(float) $r->point_b_lng, (float) $r->point_b_lat],
            ),
        ], $rows));
    }

    private static function formatDuration(float $seconds): string
    {
        if ($seconds < 60) {
            return sprintf('%ds', (int) $seconds);
        }

        $m = floor($seconds / 60);
        $s = (int) ($seconds % 60);

        return sprintf('%dm %02ds', $m, $s);
    }
}
