<?php

namespace App\Console\Commands;

use App\Geo\GreatCircle;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Build the road graph the route router will search: road_nodes and
 * road_edges out of the roads table.
 *
 * This is the piece the street lookups have always been missing, and the
 * gap is stated in the code that feels it most — RoadsController::continue
 * documents that "there is no graph in this table", which is why the walk it
 * serves is a one-corner guess. The graph is what turns the roads table from
 * drawn geometry into answered questions: a node is a junction (a coordinate
 * two or more ways share exactly) and an edge is the stretch of one way
 * between two of them, with a length and the directions it may be walked.
 *
 * Two things keep this command honest.
 *
 * Derived, not a copy. Truncating and rebuilding is the whole repair story —
 * a stale graph is fixed by running this again, never by editing it — which
 * is why the tables carry no timestamps and every insert here is bulk and
 * unconditional.
 *
 * Driver-gated, and that is the same trade as the import it follows. The
 * source geometry is PostGIS-only, so building is too; but the product is
 * plain numeric columns, which is what lets the router built on top run in
 * the SQLite test suite — the one thing pgRouting or an external engine
 * could never offer here.
 */
class RoadsBuildGraph extends Command
{
    protected $signature = 'roads:build-graph';

    protected $description = 'Build the road graph (road_nodes, road_edges) from the imported streets';

    /**
     * Coordinate key → node id, the dedup across ways that makes a junction.
     *
     * @var array<string, int>
     */
    private array $nodeIds = [];

    private int $nextNodeId = 1;

    /** @var list<array{id: int, lat: float, lng: float}> */
    private array $nodeRows = [];

    /** @var list<array<string, mixed>> */
    private array $edgeRows = [];

    /**
     * The highest node id known to be in the table.
     *
     * An edge may only be inserted once both of its endpoints are — the FKs
     * say so — so the edge buffer holds the ones whose nodes are still
     * pending and writes the rest at every node flush.
     */
    private int $flushedThrough = 0;

    /** How many rows one insert statement carries. */
    private const CHUNK_SIZE = 2000;

    public function handle(): int
    {
        if (Schema::getConnection()->getDriverName() !== 'pgsql') {
            $this->error('roads.geom only exists on PostgreSQL, so there is nothing to build from on this driver.');

            return self::FAILURE;
        }

        $totalRoads = (int) DB::selectOne('SELECT count(*) AS n FROM roads')->n;

        if ($totalRoads === 0) {
            $this->error('The roads table is empty. Run roads:import-overpass first.');

            return self::FAILURE;
        }

        $started = microtime(true);

        // Both are rebuilt wholesale, in one statement: Postgres refuses to
        // truncate a referenced table (road_edges points at road_nodes) unless
        // the referencing table goes with it in the same command.
        DB::statement('TRUNCATE TABLE road_edges, road_nodes');

        $skipped = 0;
        $edges = 0;
        $onewayEdges = 0;

        $this->output->progressStart($totalRoads);

        try {
            $lastId = 0;

            while (true) {
                $roads = DB::select(
                    'SELECT id, osm_id, oneway, ST_AsGeoJSON(geom) AS geo_json
                     FROM roads
                     WHERE id > ?
                     ORDER BY id
                     LIMIT 500',
                    [$lastId],
                );

                if ($roads === []) {
                    break;
                }

                foreach ($roads as $road) {
                    $lastId = (int) $road->id;

                    $decoded = json_decode((string) $road->geo_json, true);
                    $coordinates = is_array($decoded) ? ($decoded['coordinates'] ?? null) : null;

                    if (! is_array($coordinates)) {
                        $skipped++;

                        continue;
                    }

                    [$forwardOk, $backwardOk] = $this->directions((string) $road->oneway);

                    foreach ($coordinates as $part) {
                        if (! is_array($part) || count($part) < 2) {
                            continue;
                        }

                        $previousKey = null;
                        $previousPoint = null;

                        foreach ($part as $point) {
                            if (
                                ! is_array($point)
                                || count($point) < 2
                                || ! is_numeric($point[0])
                                || ! is_numeric($point[1])
                            ) {
                                // A malformed point breaks the chain rather
                                // than inventing an edge across the gap.
                                $previousKey = null;
                                $previousPoint = null;

                                continue;
                            }

                            $lng = (float) $point[0];
                            $lat = (float) $point[1];

                            // Node identity is the coordinate, at a rounding
                            // that is centimetre-scale and far below anything
                            // OSM can produce. Two ways that share a junction
                            // share the exact node, and this key is where they
                            // become one node instead of two.
                            $key = sprintf('%.7F,%.7F', $lng, $lat);

                            if (! isset($this->nodeIds[$key])) {
                                $this->nodeIds[$key] = $this->nextNodeId;
                                $this->nodeRows[] = [
                                    'id' => $this->nextNodeId,
                                    'lat' => $lat,
                                    'lng' => $lng,
                                ];
                                $this->nextNodeId++;

                                if (count($this->nodeRows) >= self::CHUNK_SIZE) {
                                    $this->flushNodes();
                                    $this->flushReadyEdges();
                                }
                            }

                            if (
                                $previousKey !== null
                                && $previousKey !== $key
                                && is_array($previousPoint)
                            ) {
                                $length = GreatCircle::metersBetween($previousPoint, [$lng, $lat]);

                                $this->edgeRows[] = [
                                    'from_node_id' => $this->nodeIds[$previousKey],
                                    'to_node_id' => $this->nodeIds[$key],
                                    'road_id' => (int) $road->id,
                                    'length_m' => $length,
                                    'forward_ok' => $forwardOk,
                                    'backward_ok' => $backwardOk,
                                ];
                                $edges++;

                                if ($forwardOk !== $backwardOk) {
                                    $onewayEdges++;
                                }

                                if (count($this->edgeRows) >= self::CHUNK_SIZE) {
                                    $this->flushReadyEdges();
                                }
                            }

                            $previousKey = $key;
                            $previousPoint = [$lng, $lat];
                        }
                    }
                }

                $this->output->progressAdvance(count($roads));
            }

            // Whatever is still buffered belongs to nodes that are all flushed
            // by now — flushNodes() above runs until the buffer is empty, and
            // the ready-edge filter reads that watermark.
            $this->flushNodes();
            $this->flushReadyEdges();
        } finally {
            $this->output->progressFinish();
        }

        $seconds = microtime(true) - $started;

        $nodeCount = (int) DB::selectOne('SELECT count(*) AS n FROM road_nodes')->n;
        $edgeCount = (int) DB::selectOne('SELECT count(*) AS n FROM road_edges')->n;
        $onewayCount = (int) DB::selectOne('SELECT count(*) AS n FROM road_edges WHERE forward_ok <> backward_ok')->n;

        $this->newLine(2);
        $this->info(sprintf(
            'Built the road graph in %.1fs: %s nodes, %s edges (%s one-way).',
            $seconds,
            number_format($nodeCount),
            number_format($edgeCount),
            number_format($onewayCount),
        ));

        if ($skipped > 0) {
            $this->warn(sprintf('%d road(s) had geometry that could not be parsed and were skipped.', $skipped));
        }

        if (Schema::hasTable('turn_restrictions')) {
            $unresolved = (int) DB::selectOne(
                'SELECT count(*) AS n FROM turn_restrictions tr
                 WHERE NOT EXISTS (SELECT 1 FROM roads r WHERE r.osm_id = tr.from_osm_way)
                    OR NOT EXISTS (SELECT 1 FROM roads r WHERE r.osm_id = tr.to_osm_way)'
            )->n;

            if ($unresolved > 0) {
                $this->warn(sprintf(
                    '%d turn restriction(s) name a way outside the imported area. Re-run the import with a wider --bbox to bind them.',
                    $unresolved,
                ));
            }
        }

        return self::SUCCESS;
    }

    /**
     * Which ways along a road's own node order its edges may be travelled.
     *
     * @return array{0: bool, 1: bool} forward first, backward second
     */
    private function directions(string $oneway): array
    {
        return match ($oneway) {
            'forward' => [true, false],
            'backward' => [false, true],
            // Anything else is treated as two-way. The import resolves OSM's
            // tokens into no/forward/backward before this ever runs, so an
            // unknown value here means the data drifted — assuming both ways
            // is the safe default for a route, and the self-test reports the
            // oneway share so the drift is visible.
            default => [true, true],
        };
    }

    private function flushNodes(): void
    {
        if ($this->nodeRows === []) {
            return;
        }

        foreach (array_chunk($this->nodeRows, self::CHUNK_SIZE) as $rows) {
            DB::table('road_nodes')->insert($rows);
        }

        $this->flushedThrough = $this->nodeRows[count($this->nodeRows) - 1]['id'];
        $this->nodeRows = [];
    }

    /**
     * Write the buffered edges whose endpoints are both already in the table.
     *
     * Within a way the nodes are numbered in order, so nearly every edge is
     * ready by the next node flush; only the tail of the last cycle waits,
     * and the final calls before the report take it.
     */
    private function flushReadyEdges(): void
    {
        if ($this->edgeRows === []) {
            return;
        }

        $ready = [];
        $deferred = [];

        foreach ($this->edgeRows as $row) {
            $row['from_node_id'] <= $this->flushedThrough && $row['to_node_id'] <= $this->flushedThrough
                ? $ready[] = $row
                : $deferred[] = $row;
        }

        $this->edgeRows = $deferred;

        if ($ready === []) {
            return;
        }

        foreach (array_chunk($ready, self::CHUNK_SIZE) as $rows) {
            DB::table('road_edges')->insert($rows);
        }
    }
}
