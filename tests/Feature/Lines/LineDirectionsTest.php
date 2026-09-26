<?php

namespace Tests\Feature\Lines;

use App\Enums\DirectionOperation;
use App\Enums\LineSense;
use App\Models\Line;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LineDirectionsTest extends TestCase
{
    use RefreshDatabase;

    /**
     * A geometry with two segments, so the tests can prove that inverting
     * reverses the segment order and not only the points inside each one.
     * Reversing the points without reversing the segments would produce a
     * route that jumps between two disconnected halves.
     *
     * @return array{type: string, coordinates: array<int, array<int, array<int, float>>>}
     */
    private function twoSegmentGeometry(): array
    {
        return [
            'type' => 'MultiLineString',
            'coordinates' => [
                [[0.0, 0.0], [1.0, 1.0]],
                [[1.0, 1.0], [2.0, 0.0]],
            ],
        ];
    }

    private function pair(?array $outboundGeometry = null, ?array $returnGeometry = null): array
    {
        $outbound = Line::factory()->create([
            'code' => '4',
            'sense' => LineSense::Outbound,
            'geo_json' => $outboundGeometry ?? $this->twoSegmentGeometry(),
        ]);

        $return = Line::factory()->create([
            'code' => '4',
            'sense' => LineSense::Return,
            'geo_json' => $returnGeometry ?? [
                'type' => 'MultiLineString',
                'coordinates' => [[[5.0, 5.0], [6.0, 6.0], [7.0, 5.0]]],
            ],
        ]);

        return [$outbound, $return];
    }

    public function test_inverting_reverses_the_point_order_of_both_records()
    {
        [$outbound, $return] = $this->pair();

        $outbound->applyDirectionOperation(DirectionOperation::Invert);

        // Loosely compared: the JSON column round-trips 1.0 as 1, and what
        // matters here is the order, not the numeric representation.
        $this->assertEquals(
            [[[2, 0], [1, 1]], [[1, 1], [0, 0]]],
            $outbound->fresh()->geo_json['coordinates'],
        );
        $this->assertEquals(
            [[[7, 5], [6, 6], [5, 5]]],
            $return->fresh()->geo_json['coordinates'],
        );
    }

    public function test_inverting_also_reverses_the_order_of_the_segments()
    {
        [$outbound] = $this->pair();

        $outbound->applyDirectionOperation(DirectionOperation::Invert);

        $this->assertEquals(
            [[2, 0], [1, 1]],
            $outbound->fresh()->geo_json['coordinates'][0],
        );
    }

    public function test_inverting_twice_restores_the_original_geometry()
    {
        [$outbound, $return] = $this->pair();

        $before = [$outbound->geo_json, $return->geo_json];

        $outbound->applyDirectionOperation(DirectionOperation::Invert);
        $outbound->applyDirectionOperation(DirectionOperation::Invert);

        $this->assertSame($before[0], $outbound->fresh()->geo_json);
        $this->assertSame($before[1], $return->fresh()->geo_json);
    }

    public function test_swapping_exchanges_the_geometry_between_the_two_records()
    {
        [$outbound, $return] = $this->pair();
        $outboundGeometry = $outbound->geo_json;
        $returnGeometry = $return->geo_json;

        $outbound->applyDirectionOperation(DirectionOperation::Swap);

        $this->assertSame($returnGeometry, $outbound->fresh()->geo_json);
        $this->assertSame($outboundGeometry, $return->fresh()->geo_json);
    }

    public function test_swapping_twice_restores_the_original_geometry()
    {
        [$outbound, $return] = $this->pair();
        $outboundGeometry = $outbound->geo_json;
        $returnGeometry = $return->geo_json;

        $outbound->applyDirectionOperation(DirectionOperation::Swap);
        $outbound->applyDirectionOperation(DirectionOperation::Swap);

        $this->assertSame($outboundGeometry, $outbound->fresh()->geo_json);
        $this->assertSame($returnGeometry, $return->fresh()->geo_json);
    }

    public function test_either_operation_leaves_the_descriptive_fields_alone()
    {
        [$outbound, $return] = $this->pair();

        $outbound->update(['name' => 'Línea 4', 'color' => '#ff0000']);

        $outbound->applyDirectionOperation(DirectionOperation::Swap);

        $outbound->refresh();

        $this->assertSame('Línea 4', $outbound->name);
        $this->assertSame('#ff0000', $outbound->color);
        $this->assertSame('4', $outbound->code);
        $this->assertSame(LineSense::Outbound, $outbound->sense);

        // The counterpart keeps its own descriptive fields too: only geometry
        // moved, never the sense it describes.
        $this->assertSame('4', $return->fresh()->code);
        $this->assertSame(LineSense::Return, $return->fresh()->sense);
    }

    public function test_either_operation_marks_both_records_as_corrected()
    {
        [$outbound, $return] = $this->pair();

        $this->assertFalse($outbound->geometry_adjusted);
        $this->assertFalse($return->geometry_adjusted);

        $outbound->applyDirectionOperation(DirectionOperation::Invert);

        $this->assertTrue($outbound->fresh()->geometry_adjusted);
        $this->assertTrue($return->fresh()->geometry_adjusted);
    }

    public function test_the_operation_reaches_both_sides_regardless_of_which_one_is_the_target()
    {
        [, $return] = $this->pair();

        $return->applyDirectionOperation(DirectionOperation::Invert);

        $this->assertEquals(
            [[[7, 5], [6, 6], [5, 5]]],
            $return->fresh()->geo_json['coordinates'],
        );
    }

    public function test_a_line_without_a_counterpart_refuses_the_operation_and_writes_nothing()
    {
        $line = Line::factory()->create([
            'code' => '72',
            'sense' => LineSense::Outbound,
        ]);

        $this->assertFalse($line->applyDirectionOperation(DirectionOperation::Invert));
        $this->assertFalse($line->fresh()->geometry_adjusted);
        $this->assertNull($line->counterpart());
    }

    public function test_a_line_with_no_geometry_is_handled_by_both_operations()
    {
        $outbound = Line::factory()->create([
            'code' => '9',
            'sense' => LineSense::Outbound,
            'geo_json' => null,
        ]);

        Line::factory()->create([
            'code' => '9',
            'sense' => LineSense::Return,
            'geo_json' => $this->twoSegmentGeometry(),
        ]);

        $outbound->applyDirectionOperation(DirectionOperation::Invert);

        $this->assertNull($outbound->fresh()->geo_json);

        $outbound->applyDirectionOperation(DirectionOperation::Swap);

        $this->assertNotNull($outbound->fresh()->geo_json);
    }

    public function test_the_counterpart_is_found_by_code_and_sense_even_when_the_link_is_missing()
    {
        $outbound = Line::factory()->create([
            'code' => '4',
            'sense' => LineSense::Outbound,
            'parent_line_id' => null,
        ]);

        $return = Line::factory()->create([
            'code' => '4',
            'sense' => LineSense::Return,
            'parent_line_id' => null,
        ]);

        $this->assertTrue($outbound->applyDirectionOperation(DirectionOperation::Invert));
        $this->assertTrue($outbound->fresh()->geometry_adjusted);
        $this->assertTrue($return->fresh()->geometry_adjusted);
    }

    public function test_the_endpoint_requires_authentication()
    {
        $outbound = Line::factory()->create([
            'code' => '4',
            'sense' => LineSense::Outbound,
        ]);

        $this->patch(route('lines.directions', $outbound), [
            'operation' => DirectionOperation::Invert->value,
        ])->assertRedirect(route('login'));
    }

    public function test_the_endpoint_applies_the_requested_operation()
    {
        $user = User::factory()->create();
        [$outbound] = $this->pair();
        $before = $outbound->geo_json;

        $response = $this->actingAs($user)->patch(route('lines.directions', $outbound), [
            'operation' => DirectionOperation::Invert->value,
        ]);

        $response->assertRedirect(route('lines.edit', $outbound));
        $this->assertNotSame($before, $outbound->fresh()->geo_json);
        $this->assertTrue($outbound->fresh()->geometry_adjusted);
    }

    public function test_the_endpoint_rejects_an_unknown_operation()
    {
        $user = User::factory()->create();
        [$outbound] = $this->pair();
        $before = $outbound->geo_json;

        $this->actingAs($user)
            ->patch(route('lines.directions', $outbound), ['operation' => 'sideways'])
            ->assertSessionHasErrors('operation');

        $this->assertSame($before, $outbound->fresh()->geo_json);
        $this->assertFalse($outbound->fresh()->geometry_adjusted);
    }

    public function test_the_endpoint_refuses_a_line_without_a_counterpart()
    {
        $user = User::factory()->create();
        $line = Line::factory()->create(['code' => '72', 'sense' => LineSense::Outbound]);
        $before = $line->geo_json;

        $response = $this->actingAs($user)->patch(route('lines.directions', $line), [
            'operation' => DirectionOperation::Swap->value,
        ]);

        $response->assertRedirect(route('lines.edit', $line));
        $this->assertSame($before, $line->fresh()->geo_json);
    }

    public function test_editing_the_geometry_through_the_form_marks_the_line_as_corrected()
    {
        $user = User::factory()->create();
        $outbound = Line::factory()->create([
            'code' => '4',
            'sense' => LineSense::Outbound,
        ]);

        $this->actingAs($user)->put(route('lines.update', $outbound), [
            'name' => 'Línea 4',
            'geo_json' => json_encode($this->twoSegmentGeometry()),
        ])->assertRedirect(route('lines.edit', $outbound));

        $this->assertTrue($outbound->fresh()->geometry_adjusted);
    }

    public function test_updating_a_line_without_geometry_leaves_the_flag_alone()
    {
        $user = User::factory()->create();
        $outbound = Line::factory()->create([
            'code' => '4',
            'sense' => LineSense::Outbound,
        ]);

        $this->actingAs($user)->put(route('lines.update', $outbound), [
            'name' => 'Línea 4',
        ])->assertRedirect(route('lines.edit', $outbound));

        $this->assertFalse($outbound->fresh()->geometry_adjusted);
    }

    public function test_saving_returns_to_the_same_line_instead_of_the_table()
    {
        $user = User::factory()->create();
        $outbound = Line::factory()->create([
            'code' => '4',
            'sense' => LineSense::Outbound,
        ]);

        // Reviewing a route is a per-line job: the reviewer flips directions
        // and works down a list. Landing on the table after each save loses
        // their place, so the redirect has to come back here.
        $response = $this->actingAs($user)->put(route('lines.update', $outbound), [
            'name' => 'Línea 4',
        ]);

        $response->assertRedirect(route('lines.edit', $outbound));
        $this->assertNotSame(route('lines.index'), $response->headers->get('Location'));
    }

    public function test_the_edit_page_exposes_the_counterpart_so_the_actions_can_be_offered()
    {
        $user = User::factory()->create();
        [$outbound, $return] = $this->pair();

        $response = $this->actingAs($user)->get(route('lines.edit', $outbound));

        $response->assertOk();
        $this->assertSame(
            $return->id,
            $response->viewData('page')['props']['counterpart']['id'],
        );
    }
}
