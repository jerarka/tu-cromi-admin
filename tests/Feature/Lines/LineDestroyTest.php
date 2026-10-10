<?php

namespace Tests\Feature\Lines;

use App\Enums\LineSense;
use App\Models\Favorite;
use App\Models\Line;
use App\Models\Review;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * Coverage for deleting one direction of a line.
 *
 * The row IS the direction, so every test here is also a statement about
 * identity: the counterpart must survive, and it must survive in a state the
 * rest of the app can still read. That is why the counterpart assertions are
 * about parent_line_id AND counterpart() — the column is a cache and the lookup
 * is the truth, so a delete that only left the lookup working would pass a
 * weaker test than this one.
 *
 * The cascade assertions are the point of the whole file. A delete that left
 * orphan rows behind would look perfectly correct from the UI, so nothing else
 * in the suite would notice.
 */
class LineDestroyTest extends TestCase
{
    use RefreshDatabase;

    private function actingAsUser(): User
    {
        $user = User::factory()->create();

        $this->actingAs($user);

        return $user;
    }

    /**
     * Two rows sharing a code, linked the way lines:import links them.
     *
     * @return array{0: Line, 1: Line}
     */
    private function pair(string $code = '4'): array
    {
        $outbound = Line::factory()->create([
            'code' => $code,
            'sense' => LineSense::Outbound,
        ]);

        $return = Line::factory()->create([
            'code' => $code,
            'sense' => LineSense::Return,
            'parent_line_id' => $outbound->id,
        ]);

        $outbound->update(['parent_line_id' => $return->id]);

        return [$outbound, $return];
    }

    private function transfer(int $lineA, int $lineB): void
    {
        DB::table('line_transfers')->insert([
            'line_a_id' => $lineA,
            'line_b_id' => $lineB,
            'point_a_lng' => -63.18,
            'point_a_lat' => -17.78,
            'point_a_index' => 3,
            'point_b_lng' => -63.19,
            'point_b_lat' => -17.79,
            'point_b_index' => 7,
            'walk_distance' => 120.0,
        ]);
    }

    public function test_deleting_a_line_removes_exactly_that_row()
    {
        $this->actingAsUser();

        [$outbound, $return] = $this->pair();

        $this->delete(route('lines.destroy', $outbound))
            ->assertRedirect(route('lines.index'));

        $this->assertDatabaseMissing('lines', ['id' => $outbound->id]);
        $this->assertDatabaseHas('lines', ['id' => $return->id]);
    }

    public function test_the_counterpart_survives_with_no_parent_link_and_no_counterpart()
    {
        $this->actingAsUser();

        [$outbound, $return] = $this->pair();

        $this->delete(route('lines.destroy', $outbound));

        $survivor = $return->fresh();

        $this->assertNotNull($survivor);
        $this->assertNull($survivor->parent_line_id);
        // The lookup resolves by code and sense, so it never pointed at the
        // deleted row through the cache — it now simply finds nothing, which
        // is the honest answer for a route that is alone in its direction.
        $this->assertNull($survivor->counterpart());
    }

    public function test_deleting_the_other_direction_leaves_the_first_one_readable()
    {
        $this->actingAsUser();

        [$outbound, $return] = $this->pair();

        $this->delete(route('lines.destroy', $return));

        $survivor = $outbound->fresh();

        $this->assertNotNull($survivor);
        $this->assertNull($survivor->parent_line_id);
        $this->assertSame($outbound->code, $survivor->code);
    }

    public function test_the_recipe_and_the_user_data_go_with_the_row()
    {
        $user = $this->actingAsUser();

        [$outbound, $return] = $this->pair();

        $outbound->syncWaypoints([
            ['lat' => -17.78, 'lng' => -63.18],
            ['lat' => -17.79, 'lng' => -63.19],
        ]);

        Favorite::query()->create([
            'user_id' => $user->id,
            'line_id' => $outbound->id,
            'name' => 'Line 4',
        ]);

        Review::query()->create([
            'user_id' => $user->id,
            'line_id' => $outbound->id,
            'rating' => 4,
            'comment' => 'Always on time',
        ]);

        $this->assertDatabaseHas('line_waypoints', ['line_id' => $outbound->id]);

        $this->delete(route('lines.destroy', $outbound));

        $this->assertDatabaseMissing('line_waypoints', ['line_id' => $outbound->id]);
        $this->assertDatabaseMissing('favorites', ['line_id' => $outbound->id]);
        $this->assertDatabaseMissing('reviews', ['line_id' => $outbound->id]);

        // The counterpart's own rows are untouched: the delete is partial by
        // design, so its collateral has to be partial too.
        $return->syncWaypoints([['lat' => -17.80, 'lng' => -63.20]]);

        $this->assertDatabaseHas('line_waypoints', ['line_id' => $return->id]);
    }

    public function test_transfers_touching_the_row_go_from_both_positions()
    {
        $this->actingAsUser();

        [$outbound, $return] = $this->pair();
        $third = Line::factory()->create([
            'code' => '5',
            'sense' => LineSense::Outbound,
        ]);

        // line_transfers holds two foreign keys into lines, so a delete has to
        // clean both positions or the surviving rows are dangling references
        // into a table that no longer has them.
        $this->transfer($outbound->id, $return->id);
        $this->transfer($third->id, $outbound->id);
        $this->transfer($third->id, $return->id);

        $this->delete(route('lines.destroy', $outbound));

        $this->assertDatabaseMissing('line_transfers', ['line_a_id' => $outbound->id]);
        $this->assertDatabaseMissing('line_transfers', ['line_b_id' => $outbound->id]);
        $this->assertDatabaseHas('line_transfers', [
            'line_a_id' => $third->id,
            'line_b_id' => $return->id,
        ]);
    }

    public function test_the_redirect_carries_the_table_filters_back()
    {
        $this->actingAsUser();

        [$outbound] = $this->pair();

        // Deleting from a filtered list is a list operation: landing on an
        // unfiltered page 1 throws away the search the reviewer was working in.
        // Built by hand rather than through route()'s parameter array, because
        // this is the shape the delete dialog's form actually sends: a form's
        // action URL is the only place it can carry the table's filters, and
        // `_method` rides along with them.
        $this->delete(route('lines.destroy', $outbound).'?'.http_build_query([
            '_method' => 'DELETE',
            'search' => 'rojo',
            'sense' => LineSense::Return->value,
            'page' => 3,
        ]))->assertRedirect(route('lines.index', [
            'search' => 'rojo',
            'sense' => LineSense::Return->value,
            'page' => 3,
        ]));
    }

    public function test_the_redirect_carries_no_query_string_when_there_were_no_filters()
    {
        $this->actingAsUser();

        [$outbound] = $this->pair();

        // A query string carrying empty values would read as "search for
        // nothing" to whatever looks at it next.
        $this->delete(route('lines.destroy', $outbound))
            ->assertRedirect(route('lines.index'));
    }

    public function test_the_toast_names_the_code_and_the_direction()
    {
        $this->actingAsUser();

        [$outbound] = $this->pair('22 rojo');

        // Pinned exactly: the code alone is ambiguous on this table, since two
        // rows carry it and the one that survives is the one the reviewer did
        // not press delete on.
        $this->delete(route('lines.destroy', $outbound))
            ->assertInertiaFlash('toast', [
                'type' => 'success',
                'message' => 'Deleted 22 rojo (ida).',
            ]);
    }

    public function test_the_toast_names_the_other_direction_from_a_return_row()
    {
        $this->actingAsUser();

        [, $return] = $this->pair('22 rojo');

        $this->delete(route('lines.destroy', $return))
            ->assertInertiaFlash('toast', [
                'type' => 'success',
                'message' => 'Deleted 22 rojo (vuelta).',
            ]);
    }

    public function test_guests_cannot_delete_a_line()
    {
        [$outbound] = $this->pair();

        $this->delete(route('lines.destroy', $outbound))
            ->assertRedirect(route('login'));

        $this->assertDatabaseHas('lines', ['id' => $outbound->id]);
    }
}
