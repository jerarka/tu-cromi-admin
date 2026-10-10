<?php

namespace Tests\Feature\Lines;

use App\Models\Line;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LineWaypointsTest extends TestCase
{
    use RefreshDatabase;

    /**
     * The guided editor's recipe round-trips through the form the same way
     * geometry does — as a string the rule validates as a whole — and the
     * assertions below pin the parts the server owns: the derived ordinal,
     * the derived role, and the absent-field asymmetry an edit above the
     * guided mode rides on.
     */
    private function user(): User
    {
        return User::factory()->create();
    }

    /** @return list<array{lat: float, lng: float}> */
    private function payload(): array
    {
        return [
            ['lat' => -17.80, 'lng' => -63.18],
            ['lat' => -17.81, 'lng' => -63.19],
            ['lat' => -17.82, 'lng' => -63.20],
        ];
    }

    public function test_storing_a_line_persists_its_control_points(): void
    {
        $response = $this->actingAs($this->user())->post(route('lines.store'), [
            'code' => '999',
            'sense' => 'OUTBOUND',
            'geo_json' => '{"type":"MultiLineString","coordinates":[[[-63.18,-17.8],[-63.19,-17.81]]]}',
            'waypoints' => json_encode($this->payload()),
        ]);

        $response->assertRedirect();

        $line = Line::query()->where('code', '999')->where('sense', 'OUTBOUND')->firstOrFail();

        $rows = $line->waypoints()->get();

        $this->assertSame(3, $rows->count());
        $this->assertSame('start', $rows[0]->role);
        $this->assertSame('via', $rows[1]->role);
        $this->assertSame('end', $rows[2]->role);
        $this->assertSame([0, 1, 2], $rows->pluck('ordinal')->all());
        $this->assertEqualsWithDelta(-63.18, (float) $rows[0]->lng, 0.000001);
    }

    public function test_the_client_role_is_never_stored(): void
    {
        // Ordinal and role are derived server-side from the array order; a
        // forged role in the payload says nothing.
        $this->actingAs($this->user())->post(route('lines.store'), [
            'code' => '999',
            'sense' => 'OUTBOUND',
            'geo_json' => '{"type":"MultiLineString","coordinates":[[[-63.18,-17.8],[-63.19,-17.81]]]}',
            'waypoints' => json_encode(array_map(
                fn (array $point, int $index): array => $point + ['role' => 'end'],
                $this->payload(),
                array_keys($this->payload()),
            )),
        ]);

        $rows = Line::query()->where('code', '999')->firstOrFail()->waypoints()->get();

        $this->assertSame('start', $rows[0]->role);
        $this->assertSame('via', $rows[1]->role);
    }

    public function test_updating_a_line_replaces_the_recipe_whole(): void
    {
        $line = Line::factory()->create(['code' => '999', 'sense' => 'OUTBOUND']);
        $line->syncWaypoints([['lat' => -17.80, 'lng' => -63.18]]);

        $this->actingAs($this->user())
            ->put(route('lines.update', $line->id), [
                'name' => 'Renamed',
                'waypoints' => json_encode($this->payload()),
            ])
            ->assertRedirect();

        $rows = $line->waypoints()->get();

        $this->assertSame(3, $rows->count());
        $this->assertSame('Renamed', $line->fresh()?->name);
    }

    public function test_updating_without_the_field_leaves_the_recipe_alone(): void
    {
        // The asymmetry the whole feature rides on: a save above the guided
        // mode must not touch, clear or invent the stored control points.
        $line = Line::factory()->create(['code' => '999', 'sense' => 'OUTBOUND']);
        $line->syncWaypoints($this->payload());

        $this->actingAs($this->user())
            ->put(route('lines.update', $line->id), ['name' => 'Renamed'])
            ->assertRedirect();

        $this->assertSame(3, $line->waypoints()->count());
    }

    public function test_an_empty_list_clears_the_recipe(): void
    {
        // The other side of the asymmetry above: a field that IS present and
        // holds no control points means the reviewer removed them, so the rows go.
        // This is what makes deleting the last control stick — returning no field
        // for an empty list would leave the stored rows alone and the control
        // would reappear on the next load.
        $line = Line::factory()->create(['code' => '999', 'sense' => 'OUTBOUND']);
        $line->syncWaypoints($this->payload());

        $this->actingAs($this->user())
            ->put(route('lines.update', $line->id), [
                'name' => 'Renamed',
                'waypoints' => '[]',
            ])
            ->assertSessionHasNoErrors();

        $this->assertSame(0, $line->waypoints()->count());
    }

    public function test_a_malformed_payload_is_refused(): void
    {
        $line = Line::factory()->create(['code' => '999', 'sense' => 'OUTBOUND']);

        $this->actingAs($this->user())
            ->put(route('lines.update', $line->id), [
                'name' => 'Renamed',
                'waypoints' => '{"not":"a list"}',
            ])
            ->assertSessionHasErrors('waypoints');

        $this->assertSame(0, $line->waypoints()->count());
    }

    public function test_an_out_of_range_control_point_is_refused(): void
    {
        $line = Line::factory()->create(['code' => '999', 'sense' => 'OUTBOUND']);

        $this->actingAs($this->user())
            ->put(route('lines.update', $line->id), [
                'name' => 'Renamed',
                'waypoints' => json_encode([['lat' => 95.0, 'lng' => -63.18]]),
            ])
            ->assertSessionHasErrors('waypoints');
    }

    public function test_the_edit_page_hands_back_the_stored_recipe(): void
    {
        $line = Line::factory()->create(['code' => '999', 'sense' => 'OUTBOUND']);
        $line->syncWaypoints($this->payload());

        $response = $this->actingAs($this->user())->get(route('lines.edit', $line->id));

        $props = $response->inertiaProps();

        $this->assertCount(3, $props['waypoints']);
        $this->assertSame('start', $props['waypoints'][0]['role']);
        $this->assertEqualsWithDelta(-63.18, (float) $props['waypoints'][0]['lng'], 0.000001);
    }
}
