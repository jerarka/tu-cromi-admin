<?php

namespace Tests\Feature\Roads;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * The road graph is plain columns, so — unlike the three PostGIS lookups —
 * the routing endpoint runs on the SQLite suite whole: the graph is seeded by
 * hand, the search runs for real, and the assertions cover the endpoint
 * contract end to end. The spatial side of the same path (that the corridor
 * query answers against real PostGIS geometry) is roads:self-test's job.
 *
 * Positions are [lng, lat]; the fixture node coordinates are 0 apart on the
 * east axis so the metre figures stay round.
 */
class RouteRoadTest extends TestCase
{
    use RefreshDatabase;

    /**
     * @param  array<int, array{0: float, 1: float}>  $nodes
     * @param  list<array{from: int, to: int, road_id: int, length_m: float, forward_ok: bool, backward_ok: bool}>  $edges
     */
    private function seedGraph(array $nodes, array $edges, array $roads = []): void
    {
        foreach ($nodes as $id => [$lng, $lat]) {
            DB::table('road_nodes')->insert(['id' => $id, 'lat' => $lat, 'lng' => $lng]);
        }

        foreach ($roads !== [] ? $roads : array_unique(array_column($edges, 'road_id')) as $roadId) {
            DB::table('roads')->insert([
                'osm_id' => $roadId * 100,
                'name' => 'seeded '.$roadId,
                'highway' => 'residential',
                'oneway' => 'no',
                'point_count' => 2,
            ]);
        }

        foreach ($edges as $edge) {
            DB::table('road_edges')->insert([
                'from_node_id' => $edge['from'],
                'to_node_id' => $edge['to'],
                // The seeded roads key by osm-id-as-id convention the graph
                // builder does not use: road_edges.road_id is the roads PK,
                // so the seeds hand out the array keys as ids directly.
                'road_id' => $edge['road_id'],
                'length_m' => $edge['length_m'],
                'forward_ok' => $edge['forward_ok'],
                'backward_ok' => $edge['backward_ok'],
            ]);
        }
    }

    /** @return array<string, mixed> */
    private function routePayload(array $overrides = []): array
    {
        return array_merge([
            'origin' => ['lat' => 0.0, 'lng' => 0.0],
            'destination' => ['lat' => 0.0, 'lng' => 0.0004],
        ], $overrides);
    }

    public function test_guests_cannot_reach_the_router(): void
    {
        $this->post(route('roads.route'), $this->routePayload())
            ->assertRedirect(route('login'));
    }

    public function test_the_request_rejects_a_missing_endpoint(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('roads.route'), ['origin' => ['lat' => 0.0, 'lng' => 0.0]])
            ->assertSessionHasErrors('destination.lat');
    }

    public function test_the_request_rejects_an_out_of_range_point(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('roads.route'), $this->routePayload([
                'destination' => ['lat' => 95.0, 'lng' => 0.0004],
            ]))->assertSessionHasErrors('destination.lat');
    }

    public function test_the_request_rejects_an_oversized_radius(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('roads.route'), $this->routePayload(['radius' => 5000]))
            ->assertSessionHasErrors('radius');
    }

    public function test_a_small_graph_answers_along_its_only_road(): void
    {
        // The happy path, plus the default radius fallback the payload
        // deliberately omits.
        $user = User::factory()->create();

        $this->seedGraph(
            nodes: [
                1 => [0.0000, 0.0],
                2 => [0.0002, 0.0],
                3 => [0.0004, 0.0],
            ],
            edges: [
                ['from' => 1, 'to' => 2, 'road_id' => 1, 'length_m' => 100.0, 'forward_ok' => true, 'backward_ok' => true],
                ['from' => 2, 'to' => 3, 'road_id' => 1, 'length_m' => 100.0, 'forward_ok' => true, 'backward_ok' => true],
            ],
        );

        $response = $this->actingAs($user)
            ->postJson(route('roads.route'), $this->routePayload())
            ->assertOk();

        $body = $response->json();

        $this->assertSame('ok', $body['status']);
        $this->assertSame('seeded 1', $body['streets'][0]['name']);
        $this->assertSame([], $body['warnings']);
        $this->assertNull($body['reason']);

        // Coordinates compared numerically rather than with assertSame: SQLite
        // hands back a stored 0.0 as an int, and the editor's JSON read of the
        // same answer sees one number either way. What matters is position.
        $this->assertSame(
            [[0.0, 0.0], [0.0002, 0.0], [0.0004, 0.0]],
            array_map(
                fn (array $position): array => [
                    (float) $position[0],
                    (float) $position[1],
                ],
                $body['coordinates'],
            ),
        );
        $this->assertEqualsWithDelta(200.0, $body['distance_m'], 0.001);
    }

    public function test_an_empty_graph_answers_not_found(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->postJson(route('roads.route'), $this->routePayload())
            ->assertNotFound();
    }

    public function test_an_origin_nowhere_near_road_says_so(): void
    {
        $user = User::factory()->create();

        $this->seedGraph(
            nodes: [
                1 => [0.0000, 0.0],
                2 => [0.0004, 0.0],
            ],
            edges: [
                ['from' => 1, 'to' => 2, 'road_id' => 1, 'length_m' => 100.0, 'forward_ok' => true, 'backward_ok' => true],
            ],
        );

        $response = $this->actingAs($user)
            ->postJson(route('roads.route'), $this->routePayload([
                'origin' => ['lat' => 3.0, 'lng' => 3.0],
            ]))
            ->assertOk();

        $body = $response->json();

        $this->assertSame('none', $body['status']);
        $this->assertSame('origin-too-far', $body['reason']);
        $this->assertNull($body['coordinates']);
    }

    public function test_a_destination_nowhere_near_road_says_so(): void
    {
        $user = User::factory()->create();

        $this->seedGraph(
            nodes: [
                1 => [0.0000, 0.0],
                2 => [0.0004, 0.0],
            ],
            edges: [
                ['from' => 1, 'to' => 2, 'road_id' => 1, 'length_m' => 100.0, 'forward_ok' => true, 'backward_ok' => true],
            ],
        );

        $response = $this->actingAs($user)
            ->postJson(route('roads.route'), $this->routePayload([
                'destination' => ['lat' => 3.0, 'lng' => 3.0],
            ]))
            ->assertOk();

        $this->assertSame('destination-too-far', $response->json('reason'));
    }

    public function test_a_wide_snap_distances_surface_as_warnings(): void
    {
        $user = User::factory()->create();

        $this->seedGraph(
            nodes: [
                1 => [0.0000, 0.0],
                2 => [0.0004, 0.0],
            ],
            edges: [
                ['from' => 1, 'to' => 2, 'road_id' => 1, 'length_m' => 100.0, 'forward_ok' => true, 'backward_ok' => true],
            ],
        );

        $response = $this->actingAs($user)
            ->postJson(route('roads.route'), $this->routePayload([
                // 30 m off node 1's latitude: still inside the default radius,
                // far enough past the editor's normal threshold to be news.
                'origin' => ['lat' => 0.0003, 'lng' => 0.0000],
            ]))
            ->assertOk();

        $this->assertSame('ok', $response->json('status'));
        $this->assertCount(1, $response->json('warnings'));
    }
}
