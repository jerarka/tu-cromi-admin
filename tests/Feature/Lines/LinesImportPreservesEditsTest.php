<?php

namespace Tests\Feature\Lines;

use App\Enums\LineSense;
use App\Models\Line;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use Tests\TestCase;

/**
 * The source GeoJSON is a bootstrap snapshot that is never updated, so the
 * import must never write over a line that already exists. These tests pin that
 * contract down, because the failure mode it prevents is silent: a re-import
 * that discarded the manual direction corrections would look like it worked.
 */
class LinesImportPreservesEditsTest extends TestCase
{
    use RefreshDatabase;

    private string $path;

    protected function setUp(): void
    {
        parent::setUp();

        $this->path = tempnam(sys_get_temp_dir(), 'rutas').'.geojson';

        File::put($this->path, json_encode([
            'features' => [
                $this->feature('4', 1, [[0, 0], [1, 1]]),
                $this->feature('4', 2, [[9, 9], [8, 8]]),
                $this->feature('9', 1, [[2, 2], [3, 3]]),
            ],
        ]));
    }

    protected function tearDown(): void
    {
        File::delete($this->path);

        parent::tearDown();
    }

    /**
     * @param  array<int, array<int, array<int, float>>>  $coordinates
     * @return array<string, mixed>
     */
    private function feature(string $code, int $sentido, array $coordinates): array
    {
        return [
            'properties' => [
                'objectid' => $sentido,
                'nombre' => $code,
                'sentido' => $sentido,
                'sindicato' => 3,
            ],
            'geometry' => [
                'type' => 'MultiLineString',
                'coordinates' => [$coordinates],
            ],
        ];
    }

    public function test_it_adds_every_line_of_an_empty_table()
    {
        $this->artisan('lines:import', ['--path' => $this->path])->assertSuccessful();

        $this->assertSame(3, Line::query()->count());
        $this->assertSame(2, Line::query()->where('code', '4')->count());
    }

    public function test_a_new_line_is_not_marked_as_corrected()
    {
        $this->artisan('lines:import', ['--path' => $this->path])->assertSuccessful();

        $this->assertSame(0, Line::query()->where('geometry_adjusted', true)->count());
    }

    public function test_the_return_geometry_is_stored_reversed_under_the_import_convention()
    {
        $this->artisan('lines:import', ['--path' => $this->path])->assertSuccessful();

        $return = Line::query()
            ->where('code', '4')
            ->where('sense', LineSense::Return)
            ->sole();

        $this->assertEquals(
            [[[8, 8], [9, 9]]],
            $return->geo_json['coordinates'],
        );
    }

    public function test_reimporting_leaves_a_corrected_line_untouched()
    {
        $this->artisan('lines:import', ['--path' => $this->path])->assertSuccessful();

        $outbound = Line::query()
            ->where('code', '4')
            ->where('sense', LineSense::Outbound)
            ->sole();

        // Assigned rather than mass-assigned: geometry_adjusted is not
        // fillable, exactly so that no request can set it.
        $outbound->geo_json = [
            'type' => 'MultiLineString',
            'coordinates' => [[[5, 5], [6, 6]]],
        ];
        $outbound->geometry_adjusted = true;
        $outbound->save();

        $this->artisan('lines:import', ['--path' => $this->path])->assertSuccessful();

        $outbound->refresh();

        $this->assertEquals(
            [[[5, 5], [6, 6]]],
            $outbound->geo_json['coordinates'],
        );
        $this->assertTrue($outbound->geometry_adjusted);
    }

    public function test_the_flag_cannot_be_set_through_mass_assignment()
    {
        $line = Line::factory()->create(['code' => '4', 'sense' => LineSense::Outbound]);

        $line->update(['geometry_adjusted' => true, 'name' => 'Línea 4']);

        $this->assertFalse($line->fresh()->geometry_adjusted);
        $this->assertSame('Línea 4', $line->fresh()->name);
    }

    public function test_reimporting_adds_a_line_that_the_source_gained()
    {
        $this->artisan('lines:import', ['--path' => $this->path])->assertSuccessful();

        $this->assertSame(3, Line::query()->count());

        File::put($this->path, json_encode([
            'features' => [
                $this->feature('4', 1, [[0, 0], [1, 1]]),
                $this->feature('4', 2, [[9, 9], [8, 8]]),
                $this->feature('9', 1, [[2, 2], [3, 3]]),
                $this->feature('7', 1, [[4, 4], [5, 5]]),
            ],
        ]));

        $this->artisan('lines:import', ['--path' => $this->path])->assertSuccessful();

        $this->assertSame(4, Line::query()->count());
        $this->assertSame(1, Line::query()->where('code', '7')->count());
    }

    public function test_reimporting_does_not_duplicate_a_line_that_already_exists()
    {
        $this->artisan('lines:import', ['--path' => $this->path])->assertSuccessful();
        $this->artisan('lines:import', ['--path' => $this->path])->assertSuccessful();

        $this->assertSame(3, Line::query()->count());
    }

    public function test_reimporting_keeps_the_names_and_colors_a_human_typed()
    {
        $this->artisan('lines:import', ['--path' => $this->path])->assertSuccessful();

        $outbound = Line::query()
            ->where('code', '4')
            ->where('sense', LineSense::Outbound)
            ->sole();

        $outbound->update(['name' => 'Línea 4', 'color' => '#123456']);

        $this->artisan('lines:import', ['--path' => $this->path])->assertSuccessful();

        $outbound->refresh();

        $this->assertSame('Línea 4', $outbound->name);
        $this->assertSame('#123456', $outbound->color);
    }

    public function test_force_alone_is_refused()
    {
        $this->artisan('lines:import', ['--path' => $this->path])->assertSuccessful();

        $this->artisan('lines:import', ['--path' => $this->path, '--force' => true])
            ->assertFailed();
    }

    public function test_force_alone_does_not_delete_anything()
    {
        $this->artisan('lines:import', ['--path' => $this->path])->assertSuccessful();

        $this->artisan('lines:import', ['--path' => $this->path, '--force' => true]);

        $this->assertSame(3, Line::query()->count());
    }
}
