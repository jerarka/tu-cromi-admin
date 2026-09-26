<?php

namespace Tests\Feature\Roads;

use App\Http\Requests\Road\SnapRoadRequest;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class SnapRoadTest extends TestCase
{
    use RefreshDatabase;

    /**
     * The roads table is PostGIS-only, so the lookup query itself cannot run on
     * the SQLite test database. What is covered here is everything around it:
     * authentication, validation of the sampled points, the radius cap, and the
     * graceful answer where the table has no geometry. The spatial query is
     * verified against a real PostgreSQL instance, because the alternative is
     * shipping it with no execution coverage whatsoever.
     */
    public function test_guests_cannot_reach_the_road_lookup()
    {
        $this->post(route('roads.snap'), [
            'points' => [['lat' => -17.8, 'lng' => -63.18]],
        ])->assertRedirect(route('login'));
    }

    public function test_the_request_rejects_a_missing_sample()
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('roads.snap'), [])
            ->assertSessionHasErrors('points');
    }

    public function test_the_request_rejects_an_empty_sample()
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('roads.snap'), ['points' => []])
            ->assertSessionHasErrors('points');
    }

    public function test_the_request_rejects_a_sample_larger_than_the_limit()
    {
        $user = User::factory()->create();

        // Past the limit the extra points stop changing which street wins, so
        // accepting them would only cost a slower query.
        $this->actingAs($user)
            ->post(route('roads.snap'), [
                'points' => array_fill(0, SnapRoadRequest::MAX_POINTS + 1, [
                    'lat' => -17.8,
                    'lng' => -63.18,
                ]),
            ])->assertSessionHasErrors('points');
    }

    public function test_the_request_rejects_an_out_of_range_position_inside_the_sample()
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('roads.snap'), [
                'points' => [
                    ['lat' => -17.8, 'lng' => -63.18],
                    ['lat' => 120.0, 'lng' => -63.18],
                ],
            ])->assertSessionHasErrors('points.1.lat');

        $this->actingAs($user)
            ->post(route('roads.snap'), [
                'points' => [
                    ['lat' => -17.8, 'lng' => -63.18],
                    ['lat' => -17.8, 'lng' => 400.0],
                ],
            ])->assertSessionHasErrors('points.1.lng');
    }

    public function test_the_search_radius_is_capped_so_a_wide_snap_cannot_be_requested()
    {
        $user = User::factory()->create();

        // A caller asking for a kilometre-wide snap would be shown a road it did
        // not drop a vertex near, and a wrong snap moves a route.
        $this->actingAs($user)
            ->post(route('roads.snap'), [
                'points' => [['lat' => -17.8, 'lng' => -63.18]],
                'radius' => 5000,
            ])->assertSessionHasErrors('radius');
    }

    public function test_the_threshold_is_capped_and_cannot_be_negative()
    {
        $user = User::factory()->create();

        // The threshold is how close a street must be to count, so a negative
        // one would refuse every street and a huge one would accept a road the
        // editor had decided not to snap onto. It is a judgement about the edit
        // and it is not the server's to widen.
        $this->actingAs($user)
            ->post(route('roads.snap'), [
                'points' => [['lat' => -17.8, 'lng' => -63.18]],
                'threshold' => 5000,
            ])->assertSessionHasErrors('threshold');

        $this->actingAs($user)
            ->post(route('roads.snap'), [
                'points' => [['lat' => -17.8, 'lng' => -63.18]],
                'threshold' => -1,
            ])->assertSessionHasErrors('threshold');
    }

    public function test_a_missing_threshold_falls_back_to_the_normal_distance()
    {
        // The server needs a threshold to decide which streets are even
        // candidates, and it has to be the editor's threshold rather than a
        // guess: the client sends the one it will then apply to the result, so
        // the two cannot disagree about what is close enough.
        $request = SnapRoadRequest::create('/roads/snap', 'POST', [
            'points' => [['lat' => -17.8, 'lng' => -63.18]],
        ]);
        $request->setContainer($this->app);
        $request->setRedirector($this->app->make('redirect'));
        $request->validateResolved();

        $this->assertSame(25.0, $request->threshold());
        $this->assertSame(60.0, $request->radius());
    }

    public function test_it_answers_not_found_on_a_database_without_the_geometry_column()
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('roads.snap'), [
                'points' => [['lat' => -17.8, 'lng' => -63.18]],
            ])->assertNotFound();
    }

    /**
     * The route editor is the one place in the app that talks to the server
     * outside Inertia, so it has to send the CSRF token itself or every lookup
     * comes back 419 and the snap silently never happens. The token travels in
     * the XSRF-TOKEN cookie and comes back in the X-XSRF-TOKEN header, so the
     * contract the frontend relies on is that this cookie is set and readable
     * by script.
     *
     * Nothing in the test suite would catch that contract breaking on its own:
     * the CSRF middleware skips itself while running tests, so a request
     * without a token succeeds here and fails in a browser.
     */
    public function test_the_xsrf_cookie_the_editor_reads_is_set_and_readable_by_script()
    {
        $user = User::factory()->create();

        $response = $this->actingAs($user)->get(route('lines.index'));

        $cookie = collect($response->headers->getCookies())
            ->first(fn ($cookie) => $cookie->getName() === 'XSRF-TOKEN');

        $this->assertNotNull(
            $cookie,
            'The editor reads the CSRF token from the XSRF-TOKEN cookie.',
        );
        $this->assertFalse(
            $cookie->isHttpOnly(),
            'A httpOnly cookie is unreadable, so the editor could not send it.',
        );
        $this->assertNotSame('', (string) $cookie->getValue());
    }

    public function test_the_sample_keeps_the_reference_point_first()
    {
        // Order is the contract the editor depends on: it derives one rigid
        // offset from the first point, so a response describing a later point
        // would move the stretch somewhere nobody dropped it.
        $request = SnapRoadRequest::create('/roads/snap', 'POST', [
            'points' => [
                ['lat' => -17.81, 'lng' => -63.10],
                ['lat' => -17.82, 'lng' => -63.11],
            ],
        ]);
        $request->setContainer($this->app);
        $request->setRedirector($this->app->make('redirect'));
        $request->validateResolved();

        $this->assertSame(
            [[-17.81, -63.10], [-17.82, -63.11]],
            $request->points(),
        );
    }
}
