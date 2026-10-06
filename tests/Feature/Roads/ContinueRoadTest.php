<?php

namespace Tests\Feature\Roads;

use App\Http\Requests\Road\ContinueRoadRequest;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ContinueRoadTest extends TestCase
{
    use RefreshDatabase;

    /**
     * The roads table is PostGIS-only, so the spatial query cannot run on the
     * SQLite test database — the same limit SnapRoadTest works under, and for the
     * same reason: this covers everything around the query and the query itself is
     * verified against a real PostgreSQL instance.
     *
     * That limit is worth restating because this endpoint is the one whose answer
     * cannot be derived from geometry alone. It guesses which street continues, so
     * a coverage gap here is a gap in the guessing rather than in the plumbing.
     */
    public function test_guests_cannot_reach_the_continuation_lookup()
    {
        $this->post(route('roads.continue'), [
            'road_id' => 1,
            'lat' => -17.8,
            'lng' => -63.18,
            'bearing' => 90,
        ])->assertRedirect(route('login'));
    }

    public function test_the_request_requires_the_road_being_left()
    {
        $user = User::factory()->create();

        // Without an id to exclude, the query cannot tell the continuation from
        // the street the route is already on, and answers with that street. The
        // failure is silent — a loop that never leaves the block — so the field is
        // required rather than defaulted.
        $this->actingAs($user)
            ->post(route('roads.continue'), [
                'lat' => -17.8,
                'lng' => -63.18,
                'bearing' => 90,
            ])->assertSessionHasErrors('road_id');
    }

    public function test_the_request_requires_a_bearing()
    {
        $user = User::factory()->create();

        // The bearing is the whole question. "What continues from here" has no
        // answer without knowing which way "here" was heading.
        $this->actingAs($user)
            ->post(route('roads.continue'), [
                'road_id' => 1,
                'lat' => -17.8,
                'lng' => -63.18,
            ])->assertSessionHasErrors('bearing');
    }

    public function test_the_request_rejects_an_out_of_range_junction()
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('roads.continue'), [
                'road_id' => 1,
                'lat' => 120.0,
                'lng' => -63.18,
                'bearing' => 90,
            ])->assertSessionHasErrors('lat');

        $this->actingAs($user)
            ->post(route('roads.continue'), [
                'road_id' => 1,
                'lat' => -17.8,
                'lng' => 400.0,
                'bearing' => 90,
            ])->assertSessionHasErrors('lng');
    }

    public function test_the_search_radius_is_capped()
    {
        $user = User::factory()->create();

        // A caller asking to continue across three blocks would be told about a
        // street with nothing to do with the one the route is on, and the walk
        // would carry the rest of the selection there.
        $this->actingAs($user)
            ->post(route('roads.continue'), [
                'road_id' => 1,
                'lat' => -17.8,
                'lng' => -63.18,
                'bearing' => 90,
                'radius' => 5000,
            ])->assertSessionHasErrors('radius');
    }

    public function test_a_missing_radius_falls_back_to_a_junction()
    {
        $request = $this->validated([
            'road_id' => 7,
            'lat' => -17.8,
            'lng' => -63.18,
            'bearing' => 90,
        ]);

        // Twenty-five metres is a junction and a bit, and the default is the one
        // that number is: two ways sharing a node can still have their nearest
        // approaches a few metres apart.
        $this->assertSame(25.0, $request->radius());
        $this->assertSame(7, $request->roadId());
    }

    public function test_a_bearing_outside_a_turn_is_normalised_rather_than_refused()
    {
        // The client computes the bearing from a bearing it derived from a turn, so
        // it lands anywhere in a revolution and a negative one is a perfectly
        // ordinary way of saying west. `ST_Project` wants a direction it can point
        // at, so the fold happens here — refusing the value would reject it for
        // being correct.
        $request = $this->validated([
            'road_id' => 7,
            'lat' => -17.8,
            'lng' => -63.18,
            'bearing' => -90.0,
        ]);

        $this->assertSame(270.0, $request->bearing());

        foreach ([[450.0, 90.0], [720.0, 0.0], [-450.0, 270.0]] as [$sent, $folded]) {
            $request = $this->validated([
                'road_id' => 7,
                'lat' => -17.8,
                'lng' => -63.18,
                'bearing' => $sent,
            ]);

            $this->assertSame($folded, $request->bearing());
        }
    }

    public function test_a_bearing_that_is_not_a_number_is_refused()
    {
        $user = User::factory()->create();

        // The one shape of bearing that cannot be folded into a direction. A word
        // reaching `ST_Project` would be a query error rather than a dropped vertex.
        $this->actingAs($user)
            ->post(route('roads.continue'), [
                'road_id' => 1,
                'lat' => -17.8,
                'lng' => -63.18,
                'bearing' => 'east',
            ])->assertSessionHasErrors('bearing');
    }

    public function test_it_answers_not_found_on_a_database_without_the_geometry_column()
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('roads.continue'), [
                'road_id' => 1,
                'lat' => -17.8,
                'lng' => -63.18,
                'bearing' => 90,
            ])->assertNotFound();
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private function validated(array $payload): ContinueRoadRequest
    {
        $request = ContinueRoadRequest::create('/roads/continue', 'POST', $payload);
        $request->setContainer($this->app);
        $request->setRedirector($this->app->make('redirect'));
        $request->validateResolved();

        return $request;
    }
}
