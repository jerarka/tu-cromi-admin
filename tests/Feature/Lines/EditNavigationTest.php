<?php

namespace Tests\Feature\Lines;

use App\Enums\LineSense;
use App\Models\Line;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\TestCase;

class EditNavigationTest extends TestCase
{
    use RefreshDatabase;

    /**
     * Seed three lines, each with both senses.
     *
     * Rows are inserted in the REVERSE of index order, and `code` is a string
     * column, so index order (code ASC, sense ASC) is:
     *
     *   1. '1'  OUTBOUND
     *   2. '1'  RETURN
     *   3. '10' OUTBOUND   <- '10' sorts before '2' (lexicographic)
     *   4. '10' RETURN
     *   5. '2'  OUTBOUND
     *   6. '2'  RETURN
     *
     * A test that passes therefore proves navigation follows (code, sense)
     * rather than insertion order, primary key order, or numeric code order.
     */
    private function seedUnlinkedLines(): void
    {
        foreach ([
            ['2', LineSense::Return],
            ['2', LineSense::Outbound],
            ['10', LineSense::Return],
            ['10', LineSense::Outbound],
            ['1', LineSense::Return],
            ['1', LineSense::Outbound],
        ] as [$code, $sense]) {
            Line::factory()->create([
                'code' => $code,
                'sense' => $sense,
            ]);
        }
    }

    /**
     * Seed a single code with both senses, linked bidirectionally the same way
     * lines:import does, so the counterpart button has something to point at.
     */
    private function seedLinkedPair(string $code): Line
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

        return $outbound;
    }

    private function find(string $code, LineSense $sense): Line
    {
        return Line::query()
            ->where('code', $code)
            ->where('sense', $sense)
            ->sole();
    }

    public function test_first_line_in_index_order_has_no_previous()
    {
        $user = User::factory()->create();
        $this->seedUnlinkedLines();

        $first = $this->find('1', LineSense::Outbound);

        $this->actingAs($user)
            ->get(route('lines.edit', $first))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->component('lines/Edit')
                ->where('nav.prev', null)
                ->where('nav.next.code', '1')
                ->where('nav.next.sense', LineSense::Return->value)
            );
    }

    public function test_last_line_in_index_order_has_no_next()
    {
        $user = User::factory()->create();
        $this->seedUnlinkedLines();

        $last = $this->find('2', LineSense::Return);

        $this->actingAs($user)
            ->get(route('lines.edit', $last))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->component('lines/Edit')
                ->where('nav.prev.code', '2')
                ->where('nav.prev.sense', LineSense::Outbound->value)
                ->where('nav.next', null)
            );
    }

    public function test_navigation_follows_code_then_sense_rather_than_id_order()
    {
        $user = User::factory()->create();
        $this->seedUnlinkedLines();

        // Second row of the index. Insertion order and id order both disagree
        // with the expected targets here.
        $line = $this->find('1', LineSense::Return);

        $this->actingAs($user)
            ->get(route('lines.edit', $line))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->component('lines/Edit')
                ->where('nav.prev.code', '1')
                ->where('nav.prev.sense', LineSense::Outbound->value)
                ->where('nav.next.code', '10')
                ->where('nav.next.sense', LineSense::Outbound->value)
            );
    }

    public function test_code_ordering_is_lexicographic_not_numeric()
    {
        $user = User::factory()->create();
        $this->seedUnlinkedLines();

        // '10' precedes '2' under a string sort, so from '10' the next line is
        // '2' OUTBOUND. A numeric sort would have gone the other way.
        $line = $this->find('10', LineSense::Return);

        $this->actingAs($user)
            ->get(route('lines.edit', $line))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->component('lines/Edit')
                ->where('nav.prev.code', '10')
                ->where('nav.prev.sense', LineSense::Outbound->value)
                ->where('nav.next.code', '2')
                ->where('nav.next.sense', LineSense::Outbound->value)
            );
    }

    public function test_prev_of_a_return_leg_is_its_own_outbound_sibling()
    {
        $user = User::factory()->create();
        $this->seedUnlinkedLines();

        $line = $this->find('2', LineSense::Outbound);

        $this->actingAs($user)
            ->get(route('lines.edit', $line))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->component('lines/Edit')
                ->where('nav.prev.code', '10')
                ->where('nav.prev.sense', LineSense::Return->value)
                ->where('nav.next.code', '2')
                ->where('nav.next.sense', LineSense::Return->value)
            );
    }

    public function test_edit_exposes_the_opposite_direction_via_parent_line()
    {
        $user = User::factory()->create();

        $outbound = $this->seedLinkedPair('16 azul');
        $return = Line::query()->find($outbound->parent_line_id);

        $this->actingAs($user)
            ->get(route('lines.edit', $outbound))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->component('lines/Edit')
                ->where('line.parent_line.id', $return->id)
                ->where('line.parent_line.sense', LineSense::Return->value)
            );
    }

    public function test_unlinked_line_has_no_counterpart()
    {
        $user = User::factory()->create();

        $orphan = Line::factory()->create([
            'code' => '73',
            'sense' => LineSense::Outbound,
        ]);

        $this->actingAs($user)
            ->get(route('lines.edit', $orphan))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->component('lines/Edit')
                ->where('line.parent_line', null)
            );
    }

    public function test_guests_cannot_reach_the_edit_screen()
    {
        $line = Line::factory()->create();

        $this->get(route('lines.edit', $line))->assertRedirect(route('login'));
    }
}
