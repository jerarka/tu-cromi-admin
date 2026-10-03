<?php

namespace Tests\Feature\Lines;

use App\Models\Line;
use App\Models\LineTransfer;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Arr;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Coverage for the offline NDJSON bundle.
 *
 * The app cannot recompute ride lengths itself — it ranks transfer options with
 * SQL, and SQLite has no sin or cos — so `cumulative_distance` travels in the
 * bundle next to `geo_json`. A wrong value here is not a crash in the admin; it
 * is a wrong transfer suggestion on a phone with no network.
 *
 * Only the line records' geometry is asserted. Transfer *values* come from
 * line_transfers, which is populated by a PostGIS command that cannot run on
 * the SQLite test database — but their JSON types can, and they are asserted
 * below because the app reads them with a bare `as num`.
 */
class LineExportOfflineTest extends TestCase
{
    use RefreshDatabase;

    private const PATH = 'offline/test.ndjson.gz';

    /**
     * Three vertices far enough apart to have a non-trivial distance, plus a
     * deliberate multi-segment case. Coordinates are [lng, lat].
     *
     * @return list<array{0: float, 1: float}>
     */
    private static function points(): array
    {
        return [
            [-63.0552587326916, -17.8429626188005],
            [-63.0589724255409, -17.8387443569103],
            [-63.0785144249511, -17.8301941507457],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private static function geometry(array $points): array
    {
        return [
            'type' => 'MultiLineString',
            'coordinates' => [$points],
        ];
    }

    /**
     * Run the exporter and return the decoded NDJSON records.
     *
     * @return list<array<string, mixed>>
     */
    private function export(int $version = 1): array
    {
        $this->artisan('lines:export-offline', [
            '--data-version' => $version,
            '--path' => self::PATH,
        ])->assertSuccessful()->run();

        $compressed = Storage::disk('local')->get(self::PATH);

        $this->assertIsString($compressed);

        $raw = gzdecode($compressed);

        $this->assertIsString($raw);

        return array_map(
            static fn (string $line): array => json_decode($line, true, flags: JSON_THROW_ON_ERROR),
            array_values(array_filter(explode("\n", $raw), static fn (string $l): bool => $l !== '')),
        );
    }

    /**
     * @param  array<string, mixed>  $geometry
     * @return list<float>
     */
    private static function flatCount(array $geometry): int
    {
        return array_sum(array_map('count', $geometry['coordinates']));
    }

    public function test_every_line_record_carries_a_cumulative_distance()
    {
        Storage::fake('local');

        // The sense is pinned rather than left to the factory: a unique index
        // covers (code, sense), so two rows sharing this code have to be the
        // ida and the vuelta or the insert fails on a coin flip.
        $geometry = self::geometry(self::points());
        Line::factory()->outbound()->create(['code' => '105 verde', 'geo_json' => $geometry]);
        Line::factory()->return()->create([
            'code' => '105 verde',
            'geo_json' => ['type' => 'MultiLineString', 'coordinates' => [
                [self::points()[0], self::points()[1]],
                [self::points()[1], self::points()[2]],
            ]],
        ]);

        $records = $this->export();

        $lineRecords = array_values(array_filter($records, static fn (array $r): bool => $r['type'] === 'line'));

        $this->assertCount(2, $lineRecords);

        foreach ($lineRecords as $record) {
            $this->assertArrayHasKey('cumulative_distance', $record);
            $this->assertIsArray($record['cumulative_distance']);
            $this->assertSame(0.0, $record['cumulative_distance'][0]);
            $this->assertCount(self::flatCount($record['geo_json']), $record['cumulative_distance']);
        }
    }

    public function test_the_distances_match_the_vertices_they_sit_next_to()
    {
        Storage::fake('local');

        Line::factory()->create(['code' => '105 verde', 'geo_json' => self::geometry(self::points())]);

        $records = $this->export();
        $record = array_values(array_filter($records, static fn (array $r): bool => $r['type'] === 'line'))[0];

        /** @var list<float> $cum */
        $cum = $record['cumulative_distance'];

        // First hop of line 230, the same pair the unit test pins: proof that
        // the exporter and the pure class agree.
        $this->assertEqualsWithDelta(611.983440, $cum[1], 1e-6);
        $this->assertEqualsWithDelta(2888.560631, $cum[2], 1e-6);
        $this->assertGreaterThan($cum[1], $cum[2]);
    }

    public function test_the_emitted_json_keeps_a_float_zero_and_full_precision()
    {
        Storage::fake('local');

        Line::factory()->create(['code' => '105 verde', 'geo_json' => self::geometry(self::points())]);

        $this->export();

        $raw = gzdecode(Storage::disk('local')->get(self::PATH));

        $this->assertIsString($raw);
        $this->assertStringContainsString('"cumulative_distance":[0.0,', $raw);
        $this->assertStringContainsString('611.98344', $raw);
    }

    public function test_the_geometry_is_still_valid_geojson_in_the_bundle()
    {
        Storage::fake('local');

        $geometry = self::geometry(self::points());
        Line::factory()->create(['code' => '105 verde', 'geo_json' => $geometry]);

        $records = $this->export();
        $record = array_values(array_filter($records, static fn (array $r): bool => $r['type'] === 'line'))[0];

        $this->assertSame('MultiLineString', $record['geo_json']['type']);
        $this->assertSame($geometry, $record['geo_json']);
        $this->assertCount(2, $record['geo_json']['coordinates'][0][0]);
    }

    public function test_the_meta_record_leads_the_bundle_with_the_requested_version()
    {
        Storage::fake('local');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        $records = $this->export(1);

        $this->assertSame('meta', $records[0]['type']);
        $this->assertSame(1, $records[0]['version']);
        $this->assertSame(1, $records[0]['total_lines']);
    }

    public function test_a_low_serialize_precision_does_not_truncate_the_distances()
    {
        Storage::fake('local');

        Line::factory()->create(['code' => '105 verde', 'geo_json' => self::geometry(self::points())]);

        $original = ini_get('serialize_precision');

        try {
            // The classic misconfiguration: json_encode would rewrite
            // 611.9834402331257 as 611.983 and nobody would be told.
            ini_set('serialize_precision', '6');

            $this->export();

            $raw = gzdecode(Storage::disk('local')->get(self::PATH));

            $this->assertIsString($raw);
            $this->assertStringContainsString('611.9834402', $raw);
        } finally {
            ini_set('serialize_precision', $original === false ? '-1' : $original);
        }
    }

    public function test_transfer_numbers_are_json_numbers_and_not_strings()
    {
        Storage::fake('local');

        $outbound = Line::factory()->outbound()->create([
            'code' => '105 verde',
            'geo_json' => self::geometry(self::points()),
        ]);
        $return = Line::factory()->return()->create([
            'code' => '105 verde',
            'geo_json' => self::geometry(self::points()),
        ]);

        LineTransfer::factory()->between($outbound->id, $return->id)->create([
            'point_a_lng' => -63.0552587326916,
            'point_a_lat' => -17.8429626188005,
            'point_a_index' => 0,
            'point_b_lng' => -63.0589724255409,
            'point_b_lat' => -17.8387443569103,
            'point_b_index' => 1,
            'walk_distance' => 0,
        ]);

        $records = $this->export();
        $record = array_values(array_filter($records, static fn (array $r): bool => $r['type'] === 'transfer'))[0];

        // The app reads these with a bare `(map['walk_distance'] as num)`, which
        // throws a TypeError on a String. On PostgreSQL these columns arrive as
        // PHP strings, which is why the exporter casts them; SQLite hands back
        // real floats, so this test states the format contract rather than
        // reproducing the driver behaviour that motivated the cast.
        foreach (['point_a_lng', 'point_a_lat', 'point_b_lng', 'point_b_lat', 'walk_distance'] as $field) {
            $this->assertIsFloat($record[$field], "{$field} must be a JSON double");
        }

        foreach (['line_a_id', 'line_b_id', 'point_a_index', 'point_b_index'] as $field) {
            $this->assertIsInt($record[$field], "{$field} must be a JSON integer");
        }
    }

    public function test_a_zero_walk_distance_is_emitted_as_a_float_and_not_an_integer()
    {
        Storage::fake('local');

        $outbound = Line::factory()->outbound()->create(['geo_json' => self::geometry(self::points())]);
        $return = Line::factory()->return()->create(['geo_json' => self::geometry(self::points())]);

        LineTransfer::factory()->between($outbound->id, $return->id)->create([
            'point_a_lng' => -63.05,
            'point_a_lat' => -17.84,
            'point_a_index' => 0,
            'point_b_lng' => -63.05,
            'point_b_lat' => -17.84,
            'point_b_index' => 1,
            'walk_distance' => 0,
        ]);

        $this->export();

        $raw = gzdecode(Storage::disk('local')->get(self::PATH) ?? '');

        $this->assertIsString($raw);

        // Two lines sharing a stop is the common case, and it is the one that
        // would emit a bare 0 without JSON_PRESERVE_ZERO_FRACTION — turning a
        // double into an int exactly where the consumer expects a double.
        $this->assertStringContainsString('"walk_distance":0.0', $raw);
    }

    public function test_the_bundle_is_emitted_in_a_deterministic_order()
    {
        Storage::fake('local');

        // Created out of order on purpose, so an unordered cursor cannot pass
        // by accident.
        Line::factory()->outbound()->create(['code' => '2', 'geo_json' => self::geometry(self::points())]);
        $first = Line::factory()->outbound()->create(['code' => '1', 'geo_json' => self::geometry(self::points())]);
        $third = Line::factory()->outbound()->create(['code' => '3', 'geo_json' => self::geometry(self::points())]);

        // Tied on (line_a_id, line_b_id) and deliberately shuffled, which is
        // what the real table looks like: ~22 transfers per line pair, all tied
        // on the id columns alone.
        foreach ([3, 0, 2, 1] as $offset => $index) {
            DB::table('line_transfers')->insert([
                'line_a_id' => $first->id,
                'line_b_id' => $third->id,
                'point_a_lng' => -63.05 + $index / 1000,
                'point_a_lat' => -17.84,
                'point_a_index' => $index,
                'point_b_lng' => -63.06,
                'point_b_lat' => -17.84,
                'point_b_index' => 100 - $index,
                'walk_distance' => $index,
            ]);
        }

        $records = $this->export();

        $lineIds = array_column(
            array_values(array_filter($records, static fn (array $r): bool => $r['type'] === 'line')),
            'id',
        );

        $sorted = $lineIds;
        sort($sorted);

        $this->assertSame($sorted, $lineIds, 'line records must be ordered by id');

        $transfers = array_values(array_filter($records, static fn (array $r): bool => $r['type'] === 'transfer'));

        $this->assertCount(4, $transfers);

        $keys = array_map(
            static fn (array $t): string => implode('|', [$t['line_a_id'], $t['line_b_id'], $t['point_a_index'], $t['point_b_index']]),
            $transfers,
        );

        $expected = $keys;
        sort($expected, SORT_STRING);

        $this->assertSame($expected, $keys, 'transfers must be ordered by (a, b, point_a_index, point_b_index)');

        // The ordering is a travel order, not an arbitrary one: within a line
        // pair the transfer points ascend along the line.
        $this->assertSame(
            [0, 1, 2, 3],
            array_column($transfers, 'point_a_index'),
        );
    }

    public function test_the_sidecar_describes_the_same_export_as_the_bundle()
    {
        Storage::fake('local');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        // The clock is advanced the moment the line records start coming out,
        // which is after the bundle's own meta record has been written and
        // before the sidecar is. Without that the two stamps land in the same
        // second and a re-introduced second now() call would go unnoticed — a
        // test that cannot fail is not a test. The gap in production was 36 s,
        // which is how long the export took.
        Carbon::setTestNow('2026-01-01 00:00:00');

        Event::listen('eloquent.retrieved: '.Line::class, function (): void {
            Carbon::setTestNow('2026-01-01 00:00:45');
        });

        try {
            $records = $this->export(1);
            $meta = $records[0];

            $sidecar = json_decode(
                Storage::disk('local')->get('offline/meta.json'),
                true,
                flags: JSON_THROW_ON_ERROR,
            );
        } finally {
            Carbon::setTestNow();
        }

        $this->assertSame('2026-01-01T00:00:00+00:00', $meta['generated_at']);
        $this->assertArrayNotHasKey('type', $sidecar);
        $this->assertSame(Arr::except($meta, 'type'), $sidecar);

        // Called out separately because this is the regression: the sidecar
        // used to call now() again at the end of the run, so it advertised a
        // generation time later than the bundle it describes.
        $this->assertSame($meta['generated_at'], $sidecar['generated_at']);
    }

    public function test_upload_publishes_the_bundle_and_the_sidecar_it_just_wrote()
    {
        Storage::fake('local');
        Storage::fake('r2');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        $this->artisan('lines:export-offline', [
            '--data-version' => 1,
            '--path' => 'verify/data.ndjson.gz',
            '--upload' => true,
        ])->assertSuccessful()->run();

        $r2 = Storage::disk('r2');

        $r2->assertExists('verify/data.ndjson.gz');
        $r2->assertExists('verify/meta.json');

        // The point of the assertion: the uploaded sidecar has to be the one
        // written beside this bundle. The upload used to name 'offline/meta.json'
        // outright, so a custom --path published a sidecar belonging to some
        // earlier default export — or none at all, silently, because
        // Storage::get() returns null rather than throwing.
        $this->assertSame(
            Storage::disk('local')->get('verify/meta.json'),
            $r2->get('verify/meta.json'),
        );
        $r2->assertMissing('offline/meta.json');
    }

    public function test_upload_with_the_default_path_publishes_to_offline()
    {
        Storage::fake('local');
        Storage::fake('r2');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        $this->artisan('lines:export-offline', [
            '--data-version' => 1,
            '--upload' => true,
        ])->assertSuccessful()->run();

        $r2 = Storage::disk('r2');

        $r2->assertExists('offline/data.ndjson.gz');
        $r2->assertExists('offline/meta.json');
        $this->assertSame(
            Storage::disk('local')->get('offline/meta.json'),
            $r2->get('offline/meta.json'),
        );
    }
}
