<?php

namespace Tests\Unit\Geo;

use App\Geo\Router;
use Tests\TestCase;

/**
 * The router is the piece every guided tramo will be made of, so the
 * assertions below are deliberately hand-computed: each fixture graph is
 * small enough that the correct answer is derivable by eye, and a routing
 * test that derived its expectation from the implementation it tests would
 * have nothing to catch.
 *
 * Positions are [lng, lat]. Edge lengths are given rather than derived from
 * the coordinates, which is deliberate: the length_m column is what the
 * graph stores, and the router must answer in those metres — a fixture whose
 * lengths came from the same geometry as its coordinates would never notice
 * the router substituting its own arithmetic for the column.
 */
class RouterTest extends TestCase
{
    /**
     * A straight corridor with a detour, shortest of two ways to the same
     * destination.
     *
     * @return array<string, mixed>
     */
    private static function corridor(): array
    {
        return self::fixture([
            // Direct run: 1 - 2 - 3, collinear, no turns.
            self::edge(1, 2, 10),
            self::edge(2, 3, 10),
            // The detour, five times the length: 2 - 4 - 3.
            self::edge(2, 4, 11, length: 500),
            self::edge(4, 3, 11, length: 500),
        ], nodes: [
            1 => [0.0000, 0.0000],
            2 => [0.0002, 0.0000],
            3 => [0.0004, 0.0000],
            4 => [0.0003, 0.0002],
        ]);
    }

    public function test_it_takes_the_short_route_rather_than_the_legal_detour(): void
    {
        $outcome = self::build(self::corridor())->route(1, 3);

        $this->assertTrue($outcome->found(), (string) $outcome->reason);
        $this->assertSame(
            [[0.0, 0.0], [0.0002, 0.0], [0.0004, 0.0]],
            $outcome->coordinates,
        );
        $this->assertCount(1, $outcome->streets);
        $this->assertSame(10, $outcome->streets[0]['road_id']);
    }

    public function test_it_answers_in_metres_rather_than_in_cost(): void
    {
        $outcome = self::build(self::corridor())->route(1, 3);

        // Two legs of exactly 100 m. The turn penalty is zero here anyway, but
        // the contract being asserted is that penalties never reach the total:
        // they decide, they do not appear.
        $this->assertEqualsWithDelta(200.0, $outcome->distanceM, 0.001);
    }

    /**
     * A one-way road with nothing around it: the reverse direction is a refusal.
     *
     * @return array<string, mixed>
     */
    private static function deadEndOneWay(): array
    {
        return self::fixture([
            self::edge(1, 2, 10, forward: true, backward: false),
            self::edge(2, 3, 10, forward: true, backward: false),
        ], nodes: [
            1 => [0.0000, 0.0000],
            2 => [0.0002, 0.0000],
            3 => [0.0004, 0.0000],
        ]);
    }

    public function test_a_one_way_road_cannot_be_traversed_against_its_direction(): void
    {
        $outcome = self::build(self::deadEndOneWay())->route(3, 1);

        $this->assertFalse($outcome->found());
        $this->assertSame('no-path', $outcome->reason);
    }

    public function test_a_refusal_carries_nothing_but_the_reason(): void
    {
        $outcome = self::build(self::deadEndOneWay())->route(3, 1);

        $this->assertNull($outcome->coordinates);
        $this->assertNull($outcome->streets);
        $this->assertNull($outcome->distanceM);
    }

    /**
     * Two roads meeting at one junction — and a restriction that forbids
     * exactly the turn the route needs — with the alternative reachable only
     * the long way around.
     *
     * Road 10 reaches the junction (node 5); road 11 leaves it towards node 2;
     * road 12 loops from the junction east to node 3, north to node 4 and back
     * to the junction. Arriving on 10 and entering 11 at the junction is the
     * forbidden turn, so the legal answer runs over the loop and enters 11
     * from road 12.
     *
     * @return array<string, mixed>
     */
    private static function restrictedJunction(): array
    {
        return self::fixture([
            self::edge(1, 5, 10, length: 100),
            self::edge(5, 2, 11, length: 100),
            self::edge(5, 3, 12, length: 30),
            self::edge(3, 4, 12, length: 300),
            self::edge(4, 5, 12, length: 300),
        ], nodes: [
            1 => [0.0000, 0.0000],
            2 => [0.0002, 0.0000],
            3 => [0.0004, 0.0000],
            4 => [0.0004, 0.0002],
            5 => [0.0001, 0.0000],
        ], restrictions: [
            [
                'from_osm_way' => 1000,
                'to_osm_way' => 1100,
                'via' => [0.0001, 0.0000],
                'kind' => 'no_left_turn',
            ],
        ]);
    }

    public function test_a_forbidden_turn_is_never_taken(): void
    {
        $outcome = self::build(self::restrictedJunction())->route(1, 2);

        $this->assertTrue($outcome->found(), (string) $outcome->reason);

        $roadIds = array_map(fn (array $street): int => $street['road_id'], $outcome->streets);

        // The loop road: the answer found the legal way rather than the way
        // the geometry was begging for.
        $this->assertContains(12, $roadIds);

        // Road 11 carries the destination and IS entered — the forbidden turn
        // is arriving on 10 and entering 11 at the junction; entering it from
        // road 12 is legal and the answer takes it.
        $this->assertContains(11, $roadIds);

        // And it genuinely went around: node 4 is the road-12 midpoint the
        // direct answer would never touch.
        $this->assertContains([0.0004, 0.0002], $outcome->coordinates);

        // 100 (10) + 30 + 300 + 300 (12) + 100 (11) — the long way, and the
        // total says so.
        $this->assertEqualsWithDelta(830.0, $outcome->distanceM, 0.001);
    }

    /**
     * An `only_*` restriction: from one road, every turn but the named one is
     * forbidden — which is a refusal when the graph offers nothing else.
     *
     * @return array<string, mixed>
     */
    private static function onlyStraightOn(): array
    {
        return self::fixture([
            self::edge(1, 5, 10),
            self::edge(5, 2, 11),
            self::edge(5, 3, 12),
        ], nodes: [
            1 => [0.0000, 0.0000],
            2 => [0.0002, 0.0000],
            3 => [0.0004, 0.0000],
            5 => [0.0001, 0.0000],
        ], restrictions: [
            [
                'from_osm_way' => 1000,
                'to_osm_way' => 1400,
                'via' => [0.0001, 0.0000],
                'kind' => 'only_straight_on',
            ],
        ]);
    }

    public function test_an_only_restriction_forbids_every_other_turn(): void
    {
        // Road 14 does not exist downstream, so with the turn onto 11 and the
        // turn onto 12 both forbidden by the only-restriction, the junction
        // is a dead end the search reports rather than ignores.
        $outcome = self::build(self::onlyStraightOn())->route(1, 2);

        $this->assertFalse($outcome->found());
        $this->assertSame('no-path', $outcome->reason);
    }

    public function test_a_straight_turn_through_a_restriction_is_untouched(): void
    {
        // Arriving on 10 and leaving on 12 at the junction is a different
        // pair from the forbidden one, and the answer takes it happily.
        $outcome = self::build(self::restrictedJunction())->route(1, 3);

        $this->assertTrue($outcome->found(), (string) $outcome->reason);

        // 1 -> 5 on 10, 5 -> 3 on 12: the direct pair, not the loop.
        $this->assertEqualsWithDelta(130.0, $outcome->distanceM, 0.001);
        $this->assertCount(2, $outcome->streets);
    }

    public function test_the_search_gives_up_at_its_budget_instead_of_hanging(): void
    {
        // A straight road nine nodes long: reachable, but past a budget of
        // three expansions it cannot be reached by this search, which is the
        // difference between a refusal and a hang.
        $nodes = [];
        $edges = [];

        for ($i = 1; $i <= 9; $i++) {
            $nodes[$i] = [$i * 0.0002, 0.0];

            if ($i > 1) {
                $edges[] = self::edge($i - 1, $i, 10);
            }
        }

        $graph = self::fixture($edges, nodes: $nodes);

        $router = new Router(
            $graph['nodes'],
            $graph['edges'],
            $graph['roads'],
            [],
            expansionBudget: 3,
        );

        $outcome = $router->route(1, 9);

        $this->assertFalse($outcome->found());
        $this->assertSame('budget', $outcome->reason);
    }

    public function test_two_runs_of_the_same_input_answer_exactly_alike(): void
    {
        $first = self::build(self::restrictedJunction())->route(1, 2);
        $second = self::build(self::restrictedJunction())->route(1, 2);

        $this->assertSame($first->coordinates, $second->coordinates);
        $this->assertSame($first->streets, $second->streets);
    }

    public function test_an_unknown_node_is_the_same_refusal_as_an_unreachable_one(): void
    {
        $outcome = self::build(self::corridor())->route(1, 99);

        $this->assertFalse($outcome->found());
        $this->assertSame('no-path', $outcome->reason);
    }

    public function test_streets_group_consecutive_runs_of_one_road(): void
    {
        // Two legs, one road: the answer is one street entry carrying both
        // legs' metres, not two entries of one.
        $outcome = self::build(self::deadEndOneWay())->route(1, 3);

        $this->assertTrue($outcome->found());
        $this->assertCount(1, $outcome->streets);
        $this->assertEqualsWithDelta(200.0, $outcome->streets[0]['meters'], 0.001);
    }

    // -------------------------------------------------------------------------
    // Fixture helpers.
    // -------------------------------------------------------------------------

    /**
     * @param  list<array{from: int, to: int, road_id: int, length_m: float, forward_ok: bool, backward_ok: bool}>  $edges
     * @param  array<int, array{0: float, 1: float}>  $nodes
     * @return array<string, mixed>
     */
    private static function fixture(array $edges, array $nodes, array $restrictions = []): array
    {
        $roads = [];

        foreach (array_column($edges, 'road_id') as $roadId) {
            $roads[$roadId] = [
                'osm_id' => $roadId * 100,
                'name' => 'fixture '.$roadId,
                'highway' => 'residential',
            ];
        }

        return [
            'nodes' => $nodes,
            'edges' => $edges,
            'roads' => $roads,
            'restrictions' => $restrictions,
        ];
    }

    /**
     * An edge whose stored length is the caller's word, not the coordinates'.
     */
    private static function edge(
        int $from,
        int $to,
        int $roadId,
        int $length = 100,
        bool $forward = true,
        bool $backward = true,
    ): array {
        return [
            'from' => $from,
            'to' => $to,
            'road_id' => $roadId,
            'length_m' => (float) $length,
            'forward_ok' => $forward,
            'backward_ok' => $backward,
        ];
    }

    /**
     * @param  array<string, mixed>  $graph
     */
    private static function build(array $graph): Router
    {
        return new Router(
            $graph['nodes'],
            $graph['edges'],
            $graph['roads'],
            $graph['restrictions'],
        );
    }
}
