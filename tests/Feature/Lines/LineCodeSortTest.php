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

    public function test_number_from_code_reports_no_number_for_a_slug()
    {
        // Null, not 0: a service with no number is a real category, and this
        // method's job is to report what the code says, not where to sort it.
        $this->assertNull(Line::numberFromCode('la-guardia-nueva-terminal'));
        $this->assertNull(Line::numberFromCode('abc'));
    }

    public function test_number_from_code_still_reads_zero_as_a_real_number()
    {
        // The case that makes null necessary rather than merely tidy.
        $this->assertSame(0, Line::numberFromCode('0'));
    }

    public function test_sort_number_sends_a_numberless_line_to_the_end_of_the_column()
    {
        // The stored key, as opposed to the reported number. It has to be the
        // largest value the column holds so plain ascending code_number puts
        // numberless routes last without a NULL, which PostgreSQL and SQLite
        // would sort in opposite directions.
        $this->assertSame(Line::SORT_LAST, Line::sortNumber('la-guardia-nueva-terminal'));
        $this->assertSame(1, Line::sortNumber('1'));
        $this->assertSame(22, Line::sortNumber('22 roja'));
    }

    public function test_sort_number_does_not_confuse_a_route_called_zero_with_no_number()
    {
        // Both are "no prefix after sorting" candidates if 0 were used as the
        // stand-in. Here they cannot collide.
        $this->assertSame(0, Line::sortNumber('0'));
        $this->assertNotSame(Line::sortNumber('0'), Line::sortNumber('la-guardia-nueva-terminal'));
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

    public function test_a_slug_code_is_accepted_for_a_service_with_no_number()
    {
        $user = User::factory()->create();

        $this->actingAs($user)->post(route('lines.store'), [
            'code' => 'la-guardia-nueva-terminal',
            'sense' => LineSense::Outbound->value,
            'name' => 'La Guardia - Nueva Terminal',
        ])->assertRedirect(route('lines.index'));

        $line = Line::query()->where('code', 'la-guardia-nueva-terminal')->sole();

        $this->assertSame(Line::SORT_LAST, (int) $line->code_number);
        $this->assertSame('La Guardia - Nueva Terminal', $line->name);
    }

    public function test_a_slug_code_is_still_unique_per_direction()
    {
        $user = User::factory()->create();

        $payload = [
            'code' => 'la-guardia-nueva-terminal',
            'sense' => LineSense::Outbound->value,
        ];

        $this->actingAs($user)->post(route('lines.store'), $payload);
        $this->actingAs($user)->post(route('lines.store'), $payload)
            ->assertSessionHasErrors('code');

        // Both senses of one slug pair are legitimate; the same sense twice is not.
        $this->actingAs($user)->post(route('lines.store'), [
            ...$payload,
            'sense' => LineSense::Return->value,
        ])->assertRedirect(route('lines.index'));

        $this->assertSame(2, Line::query()->where('code', 'la-guardia-nueva-terminal')->count());
    }

    public function test_a_slug_cannot_spoof_a_numbered_code()
    {
        $user = User::factory()->create();

        foreach (['2O rojo', 'La Guardia', 'la guardia', 'la--guardia', '-guardia', 'la-guardia-'] as $invalid) {
            $this->actingAs($user)->post(route('lines.store'), [
                'code' => $invalid,
                'sense' => LineSense::Outbound->value,
            ])->assertSessionHasErrors('code');
        }

        $this->assertSame(0, Line::query()->count());
    }

    public function test_a_slug_code_is_not_silently_normalised()
    {
        $user = User::factory()->create();

        // The display wording goes in `name`. Slugifying what was typed into
        // `code` would let a stray capital or trailing space create an identity
        // nobody can predict, and two spellings of one route would then be two
        // different lines.
        $this->actingAs($user)->post(route('lines.store'), [
            'code' => 'La Guardia - Nueva Terminal',
            'sense' => LineSense::Outbound->value,
        ])->assertSessionHasErrors('code');

        $this->assertSame(0, Line::query()->count());
    }

    public function test_a_code_with_a_letter_where_a_zero_belongs_is_still_rejected()
    {
        $user = User::factory()->create();

        $this->actingAs($user)->post(route('lines.store'), [
            // Letter O instead of zero. It reads as a slug until you notice the
            // space and the capital, which is exactly why the rule does not
            // simply accept anything.
            'code' => '2O rojo',
            'sense' => LineSense::Outbound->value,
        ])->assertSessionHasErrors('code');

        $this->assertSame(0, Line::query()->count());
    }

    public function test_index_places_lines_with_no_number_after_the_numbered_ones()
    {
        $user = User::factory()->create();

        foreach (['2', '1', 'la-guardia-nueva-terminal', 'el-torno-nueva-terminal'] as $code) {
            Line::factory()->create(['code' => $code, 'sense' => LineSense::Outbound]);
        }

        $response = $this->actingAs($user)->get(route('lines.index'));

        $response->assertOk();

        $codes = array_map(
            fn (array $line): string => $line['code'],
            $response->viewData('page')['props']['lines']['data'],
        );

        // Numbered first in numeric order, then the numberless ones by code.
        $this->assertSame([
            '1',
            '2',
            'el-torno-nueva-terminal',
            'la-guardia-nueva-terminal',
        ], $codes);
    }

    public function test_a_line_numbered_zero_sorts_among_the_numbered_lines()
    {
        $user = User::factory()->create();

        foreach (['2', '0', 'la-guardia-nueva-terminal'] as $code) {
            Line::factory()->create(['code' => $code, 'sense' => LineSense::Outbound]);
        }

        $response = $this->actingAs($user)->get(route('lines.index'));

        $response->assertOk();

        $codes = array_map(
            fn (array $line): string => $line['code'],
            $response->viewData('page')['props']['lines']['data'],
        );

        // With 0 as the "no number" stand-in, "0" would have been pushed behind
        // the slug. Null is what keeps them apart.
        $this->assertSame(['0', '2', 'la-guardia-nueva-terminal'], $codes);
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
