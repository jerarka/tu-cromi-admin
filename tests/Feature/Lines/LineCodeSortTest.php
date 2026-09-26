<?php

namespace Tests\Feature\Lines;

use App\Enums\LineSense;
use App\Models\Line;
use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LineCodeSortTest extends TestCase
{
    use RefreshDatabase;

    public function test_number_from_code_extracts_the_numeric_prefix()
    {
        $this->assertSame(1, Line::numberFromCode('1'));
        $this->assertSame(10, Line::numberFromCode('10 verde'));
        $this->assertSame(22, Line::numberFromCode('22 roja'));
        $this->assertSame(104, Line::numberFromCode('104 C'));
    }

    public function test_number_from_code_tolerates_surrounding_whitespace()
    {
        $this->assertSame(16, Line::numberFromCode('  16 azul  '));
        $this->assertSame(5, Line::numberFromCode("5\t"));
    }

    public function test_number_from_code_falls_back_for_a_code_with_no_leading_number()
    {
        // Legacy rows may predate the format check. Returning 0 keeps ordering
        // deterministic instead of yielding a NULL, which PostgreSQL and
        // SQLite would sort differently.
        $this->assertSame(0, Line::numberFromCode('abc'));
    }

    public function test_creating_a_line_derives_the_sort_key()
    {
        Line::factory()->create([
            'code' => '22 roja',
            'sense' => LineSense::Outbound,
        ]);

        $line = Line::query()->where('code', '22 roja')->sole();

        $this->assertSame(22, (int) $line->code_number);
    }

    public function test_index_orders_numerically_rather_than_lexicographically()
    {
        $user = User::factory()->create();

        foreach (['10', '2', '1'] as $code) {
            Line::factory()->create(['code' => $code, 'sense' => LineSense::Outbound]);
        }

        $response = $this->actingAs($user)->get(route('lines.index'));

        $response->assertOk();

        $codes = array_map(
            fn (array $line): string => $line['code'],
            $response->viewData('page')['props']['lines']['data'],
        );

        $this->assertSame(['1', '2', '10'], $codes);
    }

    public function test_index_places_a_bare_code_before_its_suffixed_variants()
    {
        $user = User::factory()->create();

        foreach (['48 rojo', '48', '48 azul'] as $code) {
            Line::factory()->create(['code' => $code, 'sense' => LineSense::Outbound]);
        }

        $response = $this->actingAs($user)->get(route('lines.index'));

        $response->assertOk();

        $codes = array_map(
            fn (array $line): string => $line['code'],
            $response->viewData('page')['props']['lines']['data'],
        );

        // A bare code is a legitimate line of its own. It is a strict prefix of
        // "48 azul" and "48 rojo", so ordering by code after code_number puts
        // it first without needing a separate suffix column.
        $this->assertSame(['48', '48 azul', '48 rojo'], $codes);
    }

    public function test_index_orders_same_number_variants_alphabetically_by_suffix()
    {
        $user = User::factory()->create();

        foreach (['16 rojo', '16 azul', '16'] as $code) {
            Line::factory()->create(['code' => $code, 'sense' => LineSense::Outbound]);
        }

        $response = $this->actingAs($user)->get(route('lines.index'));

        $response->assertOk();

        $codes = array_map(
            fn (array $line): string => $line['code'],
            $response->viewData('page')['props']['lines']['data'],
        );

        $this->assertSame(['16', '16 azul', '16 rojo'], $codes);
    }

    public function test_lines_sharing_a_number_but_differing_by_suffix_coexist()
    {
        // The domain case: "22" and "22 rojo" are both 22, follow different
        // routes, and both must be storable.
        Line::factory()->create(['code' => '22', 'sense' => LineSense::Outbound]);
        Line::factory()->create(['code' => '22 rojo', 'sense' => LineSense::Outbound]);

        $this->assertSame(2, Line::query()->whereIn('code', ['22', '22 rojo'])->count());
    }

    public function test_the_two_senses_of_one_code_are_still_allowed()
    {
        // The ida/vuelta pair shares a code but not a sense, so the unique
        // index on (code, sense) must not reject it.
        Line::factory()->create(['code' => '22 rojo', 'sense' => LineSense::Outbound]);
        Line::factory()->create(['code' => '22 rojo', 'sense' => LineSense::Return]);

        $this->assertSame(2, Line::query()->where('code', '22 rojo')->count());
    }

    public function test_storing_a_duplicate_code_and_sense_is_rejected()
    {
        $user = User::factory()->create();
        Line::factory()->create(['code' => '22 rojo', 'sense' => LineSense::Outbound]);

        $response = $this->actingAs($user)->post(route('lines.store'), [
            'code' => '22 rojo',
            'sense' => LineSense::Outbound->value,
        ]);

        $response->assertSessionHasErrors('code');
        $this->assertSame(1, Line::query()->where('code', '22 rojo')->count());
    }

    public function test_storing_a_code_without_a_leading_number_is_rejected()
    {
        $user = User::factory()->create();

        $this->actingAs($user)->post(route('lines.store'), [
            // Letter O instead of zero — the typo this rule exists to catch.
            'code' => '2O rojo',
            'sense' => LineSense::Outbound->value,
        ])->assertSessionHasErrors('code');

        $this->assertSame(0, Line::query()->count());
    }

    public function test_a_unique_index_backs_up_the_validation_rule()
    {
        Line::factory()->create(['code' => '73', 'sense' => LineSense::Outbound]);

        $this->expectException(QueryException::class);

        // The rule catches this with a 422; the index is the integrity
        // backstop for writes that bypass validation, such as bulk inserts.
        Line::query()->create(['code' => '73', 'sense' => LineSense::Outbound->value]);
    }
}
