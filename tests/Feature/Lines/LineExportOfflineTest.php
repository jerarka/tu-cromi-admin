<?php

namespace Tests\Feature\Lines;

use App\Console\Commands\LinesExportOffline;
use App\Models\Line;
use App\Models\LineTransfer;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Process\PendingProcess;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Coverage for the offline bundle pipeline: the NDJSON contract with the
 * Flutter app's Dart CLI, and the published SQLite bundle plus manifest.
 *
 * Content tests run with --skip-dart-cli: what they assert is the NDJSON the
 * CLI consumes, and that must not depend on a Flutter checkout being present.
 * Tests that exercise the SQLite path fake the CLI through Process::fake() and
 * install a throwaway Flutter checkout under the fake local disk, so the
 * command's path checks and its manifest measurements run for real.
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

    private const BUNDLE_PATH = 'offline/test.db.gz';

    private const NDJSON_PATH = 'offline/data.ndjson.gz';

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
     * The Dart CLI is skipped by default: the NDJSON is what these tests
     * assert, and the SQLite path has its own tests below.
     *
     * @return list<array<string, mixed>>
     */
    private function export(int $version = 1, bool $buildSqlite = false): array
    {
        $parameters = [
            '--data-version' => $version,
            '--path' => self::BUNDLE_PATH,
        ];

        if (! $buildSqlite) {
            $parameters['--skip-dart-cli'] = true;
        }

        $this->artisan('lines:export-offline', $parameters)->assertSuccessful()->run();

        $compressed = Storage::disk('local')->get(self::NDJSON_PATH);

        $this->assertIsString($compressed);

        $raw = gzdecode($compressed);

        $this->assertIsString($raw);

        return array_map(
            static fn (string $line): array => json_decode($line, true, flags: JSON_THROW_ON_ERROR),
            array_values(array_filter(explode("\n", $raw), static fn (string $l): bool => $l !== '')),
        );
    }

    /**
     * Fake the Dart CLI with the same observable contract as the real one: it
     * reads the NDJSON meta record, writes gzipped bytes to --output and a
     * manifest to --manifest. The database bytes are fake on purpose — the
     * command measures whatever file it is about to publish, and that is
     * exactly what the size and hash assertions check.
     *
     * @param  string  $dartRunFlags  offline.dart_run_flags to pin, so the
     *                                suite never reads the developer's .env.
     * @param  string  $dartVersion  Version the faked `dart --version` reports.
     * @return string The fake Flutter checkout the CLI is expected to run from.
     */
    private function fakeDartCli(
        string $dartRunFlags = '--enable-experiment=native-assets',
        string $dartVersion = '3.12.2',
    ): string {
        Storage::disk('local')->makeDirectory('fake-flutter/tools');
        Storage::disk('local')->put('fake-flutter/tools/build_offline_db.dart', '// fake CLI');

        $repo = Storage::path('fake-flutter');

        // Pinned rather than read from the developer's .env: the command's
        // behaviour must not depend on the machine running the suite.
        config([
            'offline.flutter_repo' => $repo,
            'offline.dart_run_flags' => $dartRunFlags,
        ]);

        Process::fake(function (PendingProcess $process) use ($dartVersion) {
            $command = (array) $process->command;

            if (in_array('--version', $command, true)) {
                return Process::result("Dart SDK version: {$dartVersion} (stable) on \"windows_x64\"");
            }

            $argument = static function (string $flag) use ($command): string {
                $index = array_search($flag, $command, true);

                return $index === false ? '' : (string) $command[$index + 1];
            };

            $ndjson = gzdecode((string) file_get_contents($argument('--input')));

            $meta = json_decode(
                explode("\n", (string) $ndjson)[0],
                true,
                flags: JSON_THROW_ON_ERROR,
            );

            $database = gzencode('fake sqlite database');

            file_put_contents($argument('--output'), $database);

            // Shaped like the real CLI's manifest: version as a string,
            // gz_bytes rather than data_bytes, no generated_at, no hash.
            file_put_contents($argument('--manifest'), json_encode([
                'version' => (string) $meta['version'],
                'updated_at' => $meta['updated_at'],
                'total_lines' => $meta['total_lines'],
                'total_transfers' => $meta['total_transfers'],
                'gz_bytes' => strlen($database),
                'schema_version' => 1,
            ], JSON_THROW_ON_ERROR));

            return Process::result('fake dart cli: done');
        });

        return $repo;
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

        $raw = gzdecode(Storage::disk('local')->get(self::NDJSON_PATH));

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

    public function test_a_non_integer_data_version_is_rejected()
    {
        Storage::fake('local');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        // (int) 'abc' is 0, and a published version 0 matches a phone's starter
        // version, so the update prompt never fires. A typo has to stop the
        // export instead of silently publishing version 0.
        $this->artisan('lines:export-offline', [
            '--data-version' => 'abc',
            '--path' => self::BUNDLE_PATH,
        ])->expectsOutputToContain('--data-version must be an integer')
            ->assertFailed()
            ->run();

        Storage::disk('local')->assertMissing(self::NDJSON_PATH);
    }

    public function test_a_version_not_greater_than_the_previous_export_warns()
    {
        Storage::fake('local');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        // A forgotten bump is the quietest failure in this pipeline: R2 gets
        // overwritten with fresh data under a version every installed app
        // already has, so nothing is ever prompted to update.
        Storage::disk('local')->put('offline/meta.json', json_encode([
            'version' => 5,
            'data_bytes' => 1,
            'data_sha256' => 'x',
        ], JSON_THROW_ON_ERROR));

        $this->fakeDartCli();

        $this->artisan('lines:export-offline', [
            '--data-version' => 5,
            '--path' => self::BUNDLE_PATH,
        ])->expectsOutputToContain('not greater than the previous local export')
            ->assertSuccessful()
            ->run();
    }

    public function test_a_version_greater_than_the_previous_export_does_not_warn()
    {
        Storage::fake('local');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        Storage::disk('local')->put('offline/meta.json', json_encode([
            'version' => 4,
            'data_bytes' => 1,
            'data_sha256' => 'x',
        ], JSON_THROW_ON_ERROR));

        $this->fakeDartCli();

        $this->artisan('lines:export-offline', [
            '--data-version' => 5,
            '--path' => self::BUNDLE_PATH,
        ])->doesntExpectOutputToContain('not greater than the previous local export')
            ->assertSuccessful()
            ->run();
    }

    public function test_the_preflight_runs_before_the_dump()
    {
        Storage::fake('local');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        // A Dart too old to resolve the app's graph used to be discovered only
        // after 1.35M rows were written. Nothing should be dumped when the
        // environment itself is wrong.
        $this->fakeDartCli(dartVersion: '3.9.0');

        $this->artisan('lines:export-offline', [
            '--data-version' => 1,
            '--path' => self::BUNDLE_PATH,
        ])->expectsOutputToContain('Dart 3.11')
            ->assertFailed()
            ->run();

        Storage::disk('local')->assertMissing(self::NDJSON_PATH);
        Storage::disk('local')->assertMissing('offline/meta.json');
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

            $raw = gzdecode(Storage::disk('local')->get(self::NDJSON_PATH));

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

        $raw = gzdecode(Storage::disk('local')->get(self::NDJSON_PATH) ?? '');

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

    public function test_the_manifest_describes_the_sqlite_bundle_the_cli_just_built()
    {
        Storage::fake('local');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        // The clock is advanced the moment the line records start coming out,
        // which is after the bundle's own meta record has been written and
        // before the manifest is. Without that the two stamps land in the same
        // second and a re-introduced second now() call would go unnoticed — a
        // test that cannot fail is not a test. The gap in production was 36 s,
        // which is how long the export took.
        Carbon::setTestNow('2026-01-01 00:00:00');

        Event::listen('eloquent.retrieved: '.Line::class, function (): void {
            Carbon::setTestNow('2026-01-01 00:00:45');
        });

        $repo = $this->fakeDartCli();

        try {
            $records = $this->export(1, buildSqlite: true);

            $manifest = json_decode(
                (string) Storage::disk('local')->get('offline/meta.json'),
                true,
                flags: JSON_THROW_ON_ERROR,
            );

            $database = Storage::disk('local')->get(self::BUNDLE_PATH);
        } finally {
            Carbon::setTestNow();
        }

        $this->assertIsString($database);

        // version is an int in the published contract. The CLI writes it as a
        // string (it echoes the NDJSON meta record verbatim), and a client
        // comparing `remote > local` on a String would silently never update.
        $this->assertSame(1, $manifest['version']);
        $this->assertSame($records[0]['updated_at'], $manifest['updated_at']);
        $this->assertSame($records[0]['generated_at'], $manifest['generated_at']);
        $this->assertSame(1, $manifest['total_lines']);
        $this->assertSame(0, $manifest['total_transfers']);

        // Measured on the file that will be uploaded, not copied from the
        // CLI's own bookkeeping — that is the whole point of data_bytes and
        // data_sha256 on the client side.
        $this->assertSame(strlen($database), $manifest['data_bytes']);
        $this->assertSame(hash('sha256', $database), $manifest['data_sha256']);

        // The published shape is the contract, not the CLI's internal names.
        $this->assertArrayNotHasKey('gz_bytes', $manifest);
        $this->assertArrayNotHasKey('db_bytes', $manifest);
        $this->assertArrayNotHasKey('schema_version', $manifest);

        // Called out separately because this is the regression: the manifest
        // used to call now() at the end of the run, so it advertised a
        // generation time later than the bundle it describes.
        $this->assertSame('2026-01-01T00:00:00+00:00', $manifest['generated_at']);

        // The CLI has to run from the checkout: `dart run` resolves
        // package:tu_cromi_app imports from the working directory's package
        // config, not from the script's path. Ten minutes because a full
        // 1.35 M-row build takes 3-5 and the 60 s default would always fail.
        Process::assertRan(function (PendingProcess $process) use ($repo): bool {
            return $process->path === $repo
                && $process->timeout === 600
                && is_array($process->command)
                && in_array('tools/build_offline_db.dart', $process->command, true)
                && in_array('--enable-experiment=native-assets', $process->command, true)
                && in_array('--manifest', $process->command, true);
        });
    }

    public function test_the_dart_run_flags_come_from_config()
    {
        Storage::fake('local');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        // Emptying the config must actually drop the flag from the command:
        // it is an SDK detail, not a hardcoded invocation, so a Dart that
        // graduates native assets cannot be broken by a stale experiment.
        $this->fakeDartCli(dartRunFlags: '');

        $this->artisan('lines:export-offline', [
            '--data-version' => 1,
            '--path' => self::BUNDLE_PATH,
        ])->assertSuccessful()->run();

        Process::assertRan(function (PendingProcess $process): bool {
            return is_array($process->command)
                && in_array('tools/build_offline_db.dart', $process->command, true)
                && ! in_array('--enable-experiment=native-assets', $process->command, true);
        });
    }

    public function test_an_old_dart_is_rejected_before_the_build()
    {
        Storage::fake('local');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        // A second, older Dart earlier in the resolver's order is the trap
        // this guards: the build fails with a native-assets message telling
        // you to pass a flag that is already there, and the real problem is
        // the SDK version. See assertDartVersion().
        $this->fakeDartCli(dartVersion: '3.9.0');

        $this->artisan('lines:export-offline', [
            '--data-version' => 1,
            '--path' => self::BUNDLE_PATH,
        ])->expectsOutputToContain('Dart 3.11')
            ->assertFailed()
            ->run();

        // The build never starts, so no half artifact gets left behind.
        Process::assertDidntRun(function (PendingProcess $process): bool {
            return is_array($process->command)
                && in_array('--input', $process->command, true);
        });

        // And the preflight runs before the dump, so an environment problem
        // does not cost a full 1.35M-row export to discover.
        Storage::disk('local')->assertMissing(self::NDJSON_PATH);
    }

    public function test_skip_dart_cli_produces_only_the_ndjson_intermediate()
    {
        Storage::fake('local');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        $this->artisan('lines:export-offline', [
            '--data-version' => 1,
            '--path' => self::BUNDLE_PATH,
            '--skip-dart-cli' => true,
        ])->assertSuccessful()->run();

        Storage::disk('local')->assertExists(self::NDJSON_PATH);
        Storage::disk('local')->assertMissing(self::BUNDLE_PATH);

        // A manifest without data_bytes and data_sha256 is not the published
        // contract, so skip mode writes no half version of it.
        Storage::disk('local')->assertMissing('offline/meta.json');
    }

    public function test_skip_dart_cli_refuses_to_upload()
    {
        Storage::fake('local');
        Storage::fake('r2');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        $this->artisan('lines:export-offline', [
            '--data-version' => 1,
            '--path' => self::BUNDLE_PATH,
            '--skip-dart-cli' => true,
            '--upload' => true,
        ])->assertFailed()->run();

        Storage::disk('r2')->assertMissing('offline/data.db.gz');
    }

    public function test_the_dart_step_needs_a_flutter_checkout()
    {
        Storage::fake('local');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        // Explicitly nulled: the developer's own .env may point at a real
        // checkout, and this test must not depend on the machine's config.
        config(['offline.flutter_repo' => null]);

        $this->artisan('lines:export-offline', [
            '--data-version' => 1,
            '--path' => self::BUNDLE_PATH,
        ])->expectsOutputToContain('OFFLINE_FLUTTER_REPO')
            ->assertFailed()
            ->run();
    }

    public function test_a_missing_dart_cli_fails_before_anything_is_published()
    {
        Storage::fake('local');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        config(['offline.flutter_repo' => Storage::path('not-a-flutter-repo')]);

        $this->artisan('lines:export-offline', [
            '--data-version' => 1,
            '--path' => self::BUNDLE_PATH,
        ])->expectsOutputToContain('build_offline_db.dart')
            ->assertFailed()
            ->run();

        // No Process is faked here on purpose: the check happens before the
        // CLI is invoked, so a stray `dart` would never actually run.
        Storage::disk('local')->assertMissing(self::BUNDLE_PATH);
        Storage::disk('local')->assertMissing('offline/meta.json');
        Storage::disk('local')->assertMissing(self::NDJSON_PATH);
    }

    public function test_upload_publishes_the_bundle_and_the_manifest_it_just_wrote()
    {
        Storage::fake('local');
        Storage::fake('r2');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        $this->fakeDartCli();

        $this->artisan('lines:export-offline', [
            '--data-version' => 1,
            '--path' => 'verify/test.db.gz',
            '--upload' => true,
        ])->assertSuccessful()->run();

        $r2 = Storage::disk('r2');

        $r2->assertExists('verify/test.db.gz');
        $r2->assertExists('verify/meta.json');

        // The point of the assertion: the uploaded manifest has to be the one
        // written beside this bundle. The upload used to name
        // 'offline/meta.json' outright, so a custom --path published a
        // sidecar belonging to some earlier default export — or none at all,
        // silently, because Storage::get() returns null rather than throwing.
        $this->assertSame(
            Storage::disk('local')->get('verify/meta.json'),
            $r2->get('verify/meta.json'),
        );
        $r2->assertMissing('offline/meta.json');

        // The NDJSON intermediate is not published: the app no longer reads
        // it, and it exists only as the Dart CLI's input.
        $r2->assertMissing('verify/data.ndjson.gz');
    }

    public function test_upload_with_the_default_path_publishes_to_offline()
    {
        Storage::fake('local');
        Storage::fake('r2');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        $this->fakeDartCli();

        $this->artisan('lines:export-offline', [
            '--data-version' => 1,
            '--upload' => true,
        ])->assertSuccessful()->run();

        $r2 = Storage::disk('r2');

        $r2->assertExists('offline/data.db.gz');
        $r2->assertExists('offline/meta.json');
        $this->assertSame(
            Storage::disk('local')->get('offline/meta.json'),
            $r2->get('offline/meta.json'),
        );
    }

    public function test_the_artifact_paths_share_the_bundle_directory()
    {
        // A bundle at the storage root is a layout the app can consume: its
        // dirname() is '.', and the manifest must be 'meta.json', not
        // './meta.json'. An R2 object key is literal — only the local
        // filesystem, and therefore the storage fake, forgives the difference.
        $this->assertSame(
            [
                'bundle' => 'data.db.gz',
                'meta' => 'meta.json',
                'ndjson' => 'data.ndjson.gz',
            ],
            LinesExportOffline::artifactPaths('data.db.gz'),
        );

        $this->assertSame(
            [
                'bundle' => 'offline/data.db.gz',
                'meta' => 'offline/meta.json',
                'ndjson' => 'offline/data.ndjson.gz',
            ],
            LinesExportOffline::artifactPaths('offline/data.db.gz'),
        );
    }

    public function test_upload_to_the_storage_root_keeps_the_manifest_at_the_root()
    {
        Storage::fake('local');
        Storage::fake('r2');

        Line::factory()->create(['geo_json' => self::geometry(self::points())]);

        $this->fakeDartCli();

        $this->artisan('lines:export-offline', [
            '--data-version' => 1,
            '--path' => 'data.db.gz',
            '--upload' => true,
        ])->assertSuccessful()->run();

        $r2 = Storage::disk('r2');

        // `dirname('data.db.gz')` is '.', and a './meta.json' key would be a
        // sibling the app never looks for. The app fetches meta.json from the
        // bucket root, next to the database.
        $r2->assertExists('data.db.gz');
        $r2->assertExists('meta.json');
        $this->assertSame(
            Storage::disk('local')->get('meta.json'),
            $r2->get('meta.json'),
        );
    }
}
