<?php

namespace Tests\Feature\Lines;

use App\Enums\LineSense;
use App\Models\Line;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Coverage for creating and updating lines.
 *
 * Note on the geometry column: LineController::syncGeometry() is a no-op on
 * SQLite because the geom column only exists on PostgreSQL, so the actual
 * ST_GeomFromGeoJSON write — and the path that clears geom to NULL — are not
 * exercised here. Closing that gap needs a PostgreSQL test database, which
 * this project does not have. Everything else (validation, linking, sort key
 * derivation, transactions) is covered.
 */
class LineStoreTest extends TestCase
{
    use RefreshDatabase;

    private function actingAsUser(): User
    {
        $user = User::factory()->create();

        $this->actingAs($user);

        return $user;
    }

    /**
     * @return array<string, mixed>
     */
    private function payload(array $overrides = []): array
    {
        return array_merge([
            'code' => '22 rojo',
            'sense' => LineSense::Outbound->value,
        ], $overrides);
    }

    public function test_creating_a_line_derives_its_sort_key()
    {
        $this->actingAsUser();

        $this->post(route('lines.store'), $this->payload(['code' => '22 roja']))
            ->assertRedirect(route('lines.index'));

        $line = Line::query()->where('code', '22 roja')->sole();

        $this->assertSame(22, (int) $line->code_number);
    }

    public function test_creating_a_line_links_it_to_an_existing_counterpart()
    {
        $this->actingAsUser();

        // The first direction has no counterpart yet, so it stays unlinked.
        $this->post(route('lines.store'), $this->payload());
        $this->assertNull(Line::query()->where('code', '22 rojo')->sole()->parent_line_id);

        // Creating the opposite direction repairs both sides.
        $this->post(route('lines.store'), $this->payload([
            'sense' => LineSense::Return->value,
        ]));

        $outbound = Line::query()
            ->where('code', '22 rojo')
            ->where('sense', LineSense::Outbound->value)
            ->sole();

        $return = Line::query()
            ->where('code', '22 rojo')
            ->where('sense', LineSense::Return->value)
            ->sole();

        $this->assertSame($return->id, $outbound->parent_line_id);
        $this->assertSame($outbound->id, $return->parent_line_id);
    }

    public function test_creating_a_line_whose_counterpart_is_in_the_other_direction_links_symmetrically()
    {
        $this->actingAsUser();

        // Same thing with the senses reversed, to prove the lookup is not
        // biased towards OUTBOUND existing first.
        $this->post(route('lines.store'), $this->payload([
            'sense' => LineSense::Return->value,
        ]));

        $this->assertNull(Line::query()->where('code', '22 rojo')->sole()->parent_line_id);

        $this->post(route('lines.store'), $this->payload());

        $linked = Line::query()->where('code', '22 rojo')->orderBy('sense')->get();

        $this->assertCount(2, $linked);
        $this->assertSame($linked[1]->id, $linked[0]->parent_line_id);
        $this->assertSame($linked[0]->id, $linked[1]->parent_line_id);
    }

    public function test_a_line_alone_in_its_direction_is_left_unlinked()
    {
        $this->actingAsUser();

        // Circular routes legitimately exist in only one direction.
        $this->post(route('lines.store'), $this->payload(['code' => '72']));

        $this->assertNull(Line::query()->where('code', '72')->sole()->parent_line_id);
    }

    public function test_lines_sharing_a_number_but_differing_by_suffix_do_not_link()
    {
        $this->actingAsUser();

        $this->post(route('lines.store'), $this->payload(['code' => '22']));
        $this->post(route('lines.store'), $this->payload(['code' => '22 rojo']));

        $this->assertSame(0, Line::query()->whereNotNull('parent_line_id')->count());
    }

    public function test_geo_json_must_be_a_multilinestring()
    {
        $this->actingAsUser();

        // The built-in `json` rule accepts all of these because they parse.
        foreach (['123', '"a string"', '[]', '{"type":"Point","coordinates":[0,0]}'] as $invalid) {
            $this->post(route('lines.store'), $this->payload(['geo_json' => $invalid]))
                ->assertSessionHasErrors('geo_json');
        }

        $this->assertSame(0, Line::query()->count());
    }

    public function test_geo_json_rejects_a_feature_collection()
    {
        $this->actingAsUser();

        $this->post(route('lines.store'), $this->payload([
            'geo_json' => json_encode([
                'type' => 'FeatureCollection',
                'features' => [],
            ]),
        ]))->assertSessionHasErrors('geo_json');

        $this->assertSame(0, Line::query()->count());
    }

    public function test_geo_json_rejects_malformed_coordinates()
    {
        $this->actingAsUser();

        $invalid = [
            // Positions that are not numbers.
            'coordinates' => [[['a', 'b']]],
            // Position with a single value.
            'coordinates' => [[[1.0]]],
            // Line string with no positions.
            'coordinates' => [[]],
            // No line strings at all.
            'coordinates' => [],
            // Coordinates that are not an array of line strings.
            'coordinates' => 'nope',
        ];

        foreach ($invalid as $coordinates) {
            $this->post(route('lines.store'), $this->payload([
                'geo_json' => json_encode([
                    'type' => 'MultiLineString',
                    'coordinates' => $coordinates,
                ]),
            ]))->assertSessionHasErrors('geo_json');
        }

        $this->assertSame(0, Line::query()->count());
    }

    public function test_geo_json_rejects_unparseable_text()
    {
        $this->actingAsUser();

        $this->post(route('lines.store'), $this->payload([
            'geo_json' => '{"type":"MultiLineString",',
        ]))->assertSessionHasErrors('geo_json');
    }

    public function test_geo_json_accepts_a_valid_multilinestring()
    {
        $this->actingAsUser();

        $geometry = [
            'type' => 'MultiLineString',
            'coordinates' => [
                [[-63.18, -17.78], [-63.17, -17.79]],
                [[-63.16, -17.80], [-63.15, -17.81], [-63.14, -17.82]],
            ],
        ];

        $this->post(route('lines.store'), $this->payload([
            'geo_json' => json_encode($geometry),
        ]))->assertRedirect(route('lines.index'));

        $line = Line::query()->where('code', '22 rojo')->sole();

        $this->assertSame($geometry, $line->geo_json);
    }

    public function test_geo_json_accepts_a_single_vertex_geometry()
    {
        $this->actingAsUser();

        // The map editor emits this while a route is still being drawn, so it
        // must not be rejected.
        $this->post(route('lines.store'), $this->payload([
            'geo_json' => json_encode([
                'type' => 'MultiLineString',
                'coordinates' => [[[-63.18, -17.78]]],
            ]),
        ]))->assertRedirect(route('lines.index'));

        $this->assertSame(1, Line::query()->count());
    }

    public function test_geo_json_may_be_omitted_entirely()
    {
        $this->actingAsUser();

        $this->post(route('lines.store'), $this->payload())
            ->assertRedirect(route('lines.index'));

        $this->assertNull(Line::query()->where('code', '22 rojo')->sole()->geo_json);
    }

    public function test_updating_a_line_rejects_malformed_geo_json()
    {
        $this->actingAsUser();
        $line = Line::factory()->create([
            'code' => '22 rojo',
            'sense' => LineSense::Outbound,
        ]);

        $this->put(route('lines.update', $line), [
            'geo_json' => '123',
        ])->assertSessionHasErrors('geo_json');

        $this->assertNotSame('123', (string) json_encode($line->fresh()->geo_json));
    }

    public function test_updating_a_line_keeps_code_and_sense_immutable()
    {
        $this->actingAsUser();
        $line = Line::factory()->create([
            'code' => '22 rojo',
            'sense' => LineSense::Outbound,
        ]);

        $this->put(route('lines.update', $line), [
            'code' => '999 hacked',
            'sense' => LineSense::Return->value,
            'name' => 'Ruta 22',
        ])->assertRedirect(route('lines.index'));

        $line->refresh();

        $this->assertSame('22 rojo', $line->code);
        $this->assertSame(LineSense::Outbound, $line->sense);
        $this->assertSame('Ruta 22', $line->name);
    }

    public function test_updating_a_line_accepts_a_valid_geometry()
    {
        $this->actingAsUser();
        $line = Line::factory()->create([
            'code' => '22 rojo',
            'sense' => LineSense::Outbound,
        ]);

        $geometry = [
            'type' => 'MultiLineString',
            'coordinates' => [[[-63.18, -17.78], [-63.17, -17.79]]],
        ];

        $this->put(route('lines.update', $line), [
            'geo_json' => json_encode($geometry),
        ])->assertRedirect(route('lines.index'));

        $this->assertSame($geometry, $line->fresh()->geo_json);
    }

    public function test_guests_cannot_create_a_line()
    {
        $this->post(route('lines.store'), $this->payload())
            ->assertRedirect(route('login'));

        $this->assertSame(0, Line::query()->count());
    }
}
