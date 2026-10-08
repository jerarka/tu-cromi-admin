<?php

namespace App\Geo;

/**
 * The A* search over the road graph, and nothing else.
 *
 * Contains no database and no HTTP: the graph arrives as plain arrays, which
 * is what makes this whole feature testable in the SQLite suite — the same
 * convention that put GreatCircle here. Picking which slice of the network a
 * tramo needs is the caller's half of the question, and it lives at the call
 * site.
 *
 * The search is edge-based: a state is (node, the leg it arrived on), because
 * the turn restrictions speak in exactly those terms — one relation says
 * "coming from way X, you may not enter way Y at this node" — and two
 * arrivals at one junction differ in what they may do next. Node-only states
 * would collapse those arrivals and make the forbidden turn look free.
 *
 * Costs are policy, not algorithm, and every figure is written rather than
 * implied:
 *
 * Length at a multiplier per OSM highway class — all 1.0 today. The spec is
 * explicit that a shortest path is a suggestion rather than the route, and
 * the reviewer corrects it by adding a control point; the multiplier stays a
 * declared knob, and its entries must keep >= 1.0 or the haversine heuristic
 * stops underestimating and the optimal-looking output stops being optimal.
 *
 * A turn penalty, because a raw shortest path cuts every corner it can:
 * continuing straight is free, a real turn costs metres of equivalent
 * distance, and doubling back is strongly discouraged — a U-turn is
 * occasionally the only way and therefore allowed, but never cheap.
 *
 * The queue is SplPriorityQueue with the insertion counter folded into the
 * priority, because equal-cost ties must fall out in insertion order: two
 * runs of the same input must return the same tramo, or the self-test whose
 * point is determinism starts flapping.
 */
final class Router
{
    /**
     * How many states one search may expand before giving up.
     *
     * A refusal here is data answering "this network does not connect the two
     * ends within a sane amount of work" — the caller reports that to the
     * reviewer instead of letting the request hang.
     */
    public const MAX_EXPANSIONS = 60_000;

    /** Turn penalty, in metres of equivalent distance, by change of heading. */
    private const STRAIGHT_MAX_DEGREES = 15;

    private const TURN_PENALTY_M = 20.0;

    private const UTURN_MIN_DEGREES = 150;

    /**
     * The doubling-back penalty, and why it is so large.
     *
     * A U-turn inside the graph means reversing direction across two edges of
     * the same street — which on a real street means crossing the median
     * mid-block, a movement traffic law does not offer. Where a legal
     * turnaround exists, it is mapped as its own carriageway or a separate
     * way, and the roads themselves charge for it; this penalty only exists
     * for the geometrically representable, physically illegal void. 120 was
     * once enough for the fixtures, and a 60-metre bounce-back beat a 600-m
     * loop because 240 of it stayed cheap — the cost model was lying about
     * what a U-turn is worth. 500 says: prices may win against reasonable
     * alternatives, never against doubling down on a street you came from.
     */
    private const UTURN_PENALTY_M = 500.0;

    /**
     * Cost multiplier per OSM highway class, all 1.0 today.
     *
     * A property rather than a constant so the value type is declared where
     * the offset lookup happens; kept even though it is empty so the knob and
     * its precondition are in one place instead of in a phase-2 diff that has
     * to rediscover them.
     *
     * @var array<string, float>
     */
    private array $classMultipliers = [];

    /**
     * A junction coordinate, keyed exactly as the graph builder keys nodes —
     * the one join key the turn restrictions have, because `out geom` carries
     * no node ids and the coordinate is all that exists end to end.
     *
     * @param  array{0: float, 1: float}  $position  [lng, lat]
     */
    public static function nodeKey(array $position): string
    {
        return sprintf('%.7F,%.7F', $position[0], $position[1]);
    }

    /**
     * The turn restrictions indexed by the junction node and the arriving
     * road — a different shape from the raw list this class is built with,
     * which is why indexRestrictions() exists rather than the assignment
     * happening inline.
     *
     * @var array<int, array<int, array{no: array<int, true>, only: array<int, bool>}>>
     */
    private array $restrictions;

    /**
     * @param  array<int, array{0: float, 1: float}>  $nodes  nodeId => [lng, lat]
     * @param  list<array{from: int, to: int, road_id: int, length_m: float, forward_ok: bool, backward_ok: bool}>  $edges
     * @param  array<int, array{osm_id: int, name: string|null, highway: string}>  $roads
     * @param  list<array{from_osm_way: int, to_osm_way: int, via: array{0: float, 1: float}, kind: string}>  $restrictions
     */
    public function __construct(
        private readonly array $nodes,
        private readonly array $edges,
        private readonly array $roads,
        array $restrictions,
        private readonly int $expansionBudget = self::MAX_EXPANSIONS,
    ) {
        $this->restrictions = $this->indexRestrictions($restrictions);
    }

    /**
     * The path between two graph nodes, or the reason there is none.
     *
     * Both node ids are the caller's choice — snapped, in-radius picks the
     * loader made — and an id that is not in the graph answers the same way
     * an unreachable destination does: the HTTP contract has one refusal
     * shape, and a bad id is not a fourth one.
     */
    public function route(int $originNode, int $destinationNode): RouterOutcome
    {
        if (
            ! isset($this->nodes[$originNode])
            || ! isset($this->nodes[$destinationNode])
        ) {
            return RouterOutcome::notFound('no-path');
        }

        if ($originNode === $destinationNode) {
            return RouterOutcome::foundPath([$this->nodes[$originNode]], [], 0.0);
        }

        $legs = $this->legTable();
        $outLegs = $this->outgoingByNode($legs);

        $startKey = $originNode.'|';
        $stateRecord = [$startKey => ['node' => $originNode, 'leg' => null]];
        $g = [$startKey => 0.0];
        $cameFrom = [];
        $closed = [];

        $open = new \SplPriorityQueue;
        $order = 0;

        $open->insert(
            $startKey,
            [-($g[$startKey] + $this->heuristic($originNode, $destinationNode)), -$order],
        );
        $order++;

        $expansions = 0;

        while (! $open->isEmpty()) {
            /** @var string $stateKey */
            $stateKey = $open->extract();

            if (isset($closed[$stateKey])) {
                continue;
            }

            $closed[$stateKey] = true;
            $expansions++;

            if ($expansions > $this->expansionBudget) {
                return RouterOutcome::notFound('budget');
            }

            $record = $stateRecord[$stateKey];
            $node = $record['node'];
            $incomingLeg = $record['leg'];

            if ($node === $destinationNode) {
                return $this->reconstruct($legs, $stateKey, $cameFrom, $startKey);
            }

            $fromRoadOsm = $incomingLeg === null
                ? null
                : $this->roads[$legs[$incomingLeg]['road_id']]['osm_id'];

            foreach ($outLegs[$node] ?? [] as $legIndex) {
                $leg = $legs[$legIndex];
                $toRoadOsm = $this->roads[$leg['road_id']]['osm_id'];

                if (
                    $fromRoadOsm !== null
                    && $this->forbidden($node, $fromRoadOsm, $toRoadOsm)
                ) {
                    continue;
                }

                $nextKey = $leg['to'].'|'.$legIndex;
                $cost = $g[$stateKey]
                    + $leg['length_m'] * $this->multiplier($leg['road_id'])
                    + $this->turnCost($incomingLeg, $legIndex, $legs);

                if (isset($g[$nextKey]) && $g[$nextKey] <= $cost) {
                    continue;
                }

                $g[$nextKey] = $cost;
                $stateRecord[$nextKey] = ['node' => $leg['to'], 'leg' => $legIndex];
                $cameFrom[$nextKey] = $stateKey;

                $open->insert(
                    $nextKey,
                    [-($cost + $this->heuristic($leg['to'], $destinationNode)), -$order],
                );
                $order++;
            }
        }

        return RouterOutcome::notFound('no-path');
    }

    /**
     * Directed legs: every edge becomes one or two, with its own heading.
     *
     * Computed once rather than per relaxation — the heading is where the
     * turn penalty reads direction, and a direction that has to be re-derived
     * at every expansion is a direction that drifts between readers.
     *
     * @return list<array{from: int, to: int, road_id: int, bearing: float, length_m: float}>
     */
    private function legTable(): array
    {
        $legs = [];

        foreach ($this->edges as $edge) {
            $from = $this->nodes[$edge['from']];
            $to = $this->nodes[$edge['to']];
            $forwardBearing = self::bearing($from, $to);
            $backwardBearing = self::bearing($to, $from);

            if ($edge['forward_ok']) {
                $legs[] = [
                    'from' => $edge['from'],
                    'to' => $edge['to'],
                    'road_id' => $edge['road_id'],
                    'bearing' => $forwardBearing,
                    'length_m' => $edge['length_m'],
                ];
            }

            if ($edge['backward_ok']) {
                $legs[] = [
                    'from' => $edge['to'],
                    'to' => $edge['from'],
                    'road_id' => $edge['road_id'],
                    'bearing' => $backwardBearing,
                    'length_m' => $edge['length_m'],
                ];
            }
        }

        return $legs;
    }

    /**
     * @param  list<array{from: int, to: int, road_id: int, bearing: float, length_m: float}>  $legs
     * @return array<int, list<int>>
     */
    private function outgoingByNode(array $legs): array
    {
        $outgoing = [];

        foreach ($legs as $index => $leg) {
            $outgoing[$leg['from']][] = $index;
        }

        return $outgoing;
    }

    /**
     * The turn restrictions, indexed by the node they sit on and the road
     * they bind to — the two things the expansion moment holds.
     *
     * A restriction attaches to a node by its coordinate key and to a from
     * road by its OSM id; `no_*` and `only_*` accumulate into the same
     * bucket, and either one alone already constrains the turn.
     *
     * @param  list<array{from_osm_way: int, to_osm_way: int, via: array{0: float, 1: float}, kind: string}>  $restrictions
     * @return array<int, array<int, array{no: array<int, true>, only: array<int, bool>}>>
     */
    private function indexRestrictions(array $restrictions): array
    {
        $keyToNode = [];

        foreach ($this->nodes as $id => $position) {
            $keyToNode[self::nodeKey($position)] = $id;
        }

        $index = [];

        foreach ($restrictions as $restriction) {
            $nodeId = $keyToNode[self::nodeKey($restriction['via'])] ?? null;

            if ($nodeId === null) {
                // A restriction whose via names no node in this corridor is
                // not wrong — the corridor is a slice and may simply not
                // contain the junction. Skipped, and the full graph's build
                // report is the place the unresolved count lives.
                continue;
            }

            $isOnly = str_starts_with($restriction['kind'], 'only_');

            $index[$nodeId][$restriction['from_osm_way']]['no'][$restriction['to_osm_way']] = true;
            $index[$nodeId][$restriction['from_osm_way']]['only'][$restriction['to_osm_way']] = $isOnly;
        }

        return $index;
    }

    /**
     * Whether arriving on one road, the next road is forbidden at this node.
     *
     * A node the corridor never sees a restriction for is unrestricted; below
     * that, `no_*` forbids its own pair outright and `only_*` forbids
     * everything that is not its pair — the union of the two being exactly
     * OSM's semantics for a junction that carries both kinds.
     */
    private function forbidden(int $nodeId, int $fromRoadOsm, int $toRoadOsm): bool
    {
        $entry = $this->restrictions[$nodeId][$fromRoadOsm] ?? null;

        if ($entry === null) {
            return false;
        }

        if (isset($entry['no'][$toRoadOsm])) {
            return true;
        }

        if ($entry['only'] === []) {
            return false;
        }

        // Any only_* binding from this road at this node: the turn is only
        // free onto the roads those relations name.
        $only = array_filter($entry['only'], fn (bool $bound): bool => $bound);

        return $only !== [] && ! isset($only[$toRoadOsm]);
    }

    private function heuristic(int $fromNode, int $toNode): float
    {
        return GreatCircle::metersBetween($this->nodes[$fromNode], $this->nodes[$toNode]);
    }

    /**
     * @param  list<array{from: int, to: int, road_id: int, bearing: float, length_m: float}>  $legs
     */
    private function turnCost(?int $incomingLeg, int $outgoingLeg, array $legs): float
    {
        if ($incomingLeg === null) {
            return 0.0;
        }

        // The angle the route bends through, folded to [0, 180] — 180 being a
        // full U-turn regardless of which way it turned.
        $difference = abs($legs[$incomingLeg]['bearing'] - $legs[$outgoingLeg]['bearing']);
        $angle = $difference > 180.0 ? 360.0 - $difference : $difference;

        if ($angle >= self::UTURN_MIN_DEGREES) {
            return self::UTURN_PENALTY_M;
        }

        return $angle > self::STRAIGHT_MAX_DEGREES ? self::TURN_PENALTY_M : 0.0;
    }

    private function multiplier(int $roadId): float
    {
        return $this->classMultipliers[$this->roads[$roadId]['highway']] ?? 1.0;
    }

    /**
     * The compass bearing from one position to the next, degrees clockwise
     * from north.
     *
     * Element-wise scaling on the east term the way the client does it
     * (longitude degrees shrink with latitude) — near enough for a turn-cost
     * decision and no further, which is all a heading ever needs.
     *
     * @param  array{0: float, 1: float}  $from
     * @param  array{0: float, 1: float}  $to
     */
    private static function bearing(array $from, array $to): float
    {
        $east = ($to[0] - $from[0]) * cos(deg2rad($from[1]));
        $north = $to[1] - $from[1];

        return fmod((atan2($east, $north) * 180.0 / M_PI + 360.0), 360.0);
    }

    /**
     * Walk the winning chain of states back to the origin and read the path
     * out of the legs.
     *
     * A state's key is "node|legIndex" and the leg is the one that entered
     * it, so the chain of keys is the chain of legs — reversed into travel
     * order once, and everything else (coordinates, runs, totals) reads off
     * that single sequence.
     *
     * @param  list<array{from: int, to: int, road_id: int, bearing: float, length_m: float}>  $legs
     * @param  array<string, string>  $cameFrom  state key => the state it came from
     */
    private function reconstruct(
        array $legs,
        string $goalKey,
        array $cameFrom,
        string $startKey,
    ): RouterOutcome {
        $legChain = [];
        $stateKey = $goalKey;

        while ($stateKey !== $startKey) {
            $legChain[] = self::stateLeg($stateKey);
            $stateKey = $cameFrom[$stateKey] ?? $startKey;
        }

        $pathLegs = array_reverse($legChain);

        $coordinates = [$this->nodes[$legs[$pathLegs[0]]['from']]];
        $streets = [];
        $distance = 0.0;

        $currentRoadId = null;
        $currentStreet = null;

        foreach ($pathLegs as $legIndex) {
            $leg = $legs[$legIndex];

            $coordinates[] = $this->nodes[$leg['to']];
            $distance += $leg['length_m'];

            if ($currentRoadId !== $leg['road_id']) {
                if ($currentStreet !== null) {
                    $streets[] = $currentStreet;
                }

                $road = $this->roads[$leg['road_id']];
                $currentRoadId = $leg['road_id'];
                $currentStreet = [
                    'road_id' => $currentRoadId,
                    'osm_id' => $road['osm_id'],
                    'name' => $road['name'],
                    'highway' => $road['highway'],
                    'meters' => 0.0,
                ];
            }

            // Real metres, with the turn penalties and multipliers out of the
            // way: the number on the screen is a distance, not a cost.
            $currentStreet['meters'] += $leg['length_m'];
        }

        if ($currentStreet !== null) {
            $streets[] = $currentStreet;
        }

        return RouterOutcome::foundPath($coordinates, $streets, $distance);
    }

    /** The leg index in a state key, or null for the origin state ('node|'). */
    private static function stateLeg(string $stateKey): int
    {
        return (int) substr($stateKey, strrpos($stateKey, '|') + 1);
    }
}
