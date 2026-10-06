<?php

namespace App\Console\Commands;

use App\Concerns\UploadsBundleToR2;
use App\Geo\GreatCircle;
use App\Models\Line;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * Build the offline bundle for the Flutter app.
 *
 * Two artifacts are published:
 *
 * - data.db.gz: a gzipped SQLite database the app installs as a file copy
 *   (~3-5 s) instead of parsing 1.35 M NDJSON rows on device (~76 s).
 * - meta.json: the manifest clients read first, with the version the app
 *   compares against its local one, the record counts, and the size and
 *   SHA256 of the gzipped database for integrity checks. Every size and hash
 *   describes data.db.gz, never the decompressed database.
 *
 * A third artifact, data.ndjson.gz, is written beside them as an
 * intermediate: it is the Dart CLI's input and is deliberately not uploaded.
 * The app no longer reads it, and publishing it would cost 32 MB of bucket
 * space and one more URL to keep honest.
 *
 * The SQLite file is produced by the Flutter app's own Dart CLI
 * (tools/build_offline_db.dart), never by PHP/PDO. The schema belongs to the
 * app: building the database here would turn every schema change into a
 * cross-stack change and give the app's contract tests nothing to catch.
 * The CLI is invoked from the Flutter checkout because `dart run` resolves
 * `package:tu_cromi_app/...` imports from the working directory's package
 * config, not from the script's path. The checkout must have had
 * `dart pub get` run; the machine only needs Dart 3.11 or newer, not the
 * Flutter SDK, because the CLI uses sqflite_common_ffi rather than
 * package:sqflite. The version matters: before native assets reached stable,
 * `dart run` refuses the app's dependency graph with a message that tells you
 * to pass an experiment flag you may already be passing.
 *
 * The NDJSON format is unchanged and remains the contract between this
 * command and the Dart CLI: one JSON object per line, record order meta,
 * then lines by id, then transfers ordered by (line_a_id, line_b_id,
 * point_a_index, point_b_index). The CLI rejects a bundle whose meta record
 * declares a schema it does not know, so a change here requires updating the
 * CLI in lockstep.
 *
 * Line records carry cumulative_distance, the distance in metres from the
 * first vertex to every other one, as an array parallel to the flattened
 * coordinates. The app ranks transfer options by ride length in SQL, where
 * SQLite has no sin or cos, so the number travels with the geometry instead
 * of being derived on the device. See App\Geo\GreatCircle for the formula and
 * for why its constants must not be "improved".
 *
 * Transfer records carry a walk_distance measured on the same sphere as the
 * ride lengths above, so the app can add a ride to a walk without the two
 * terms sitting on different distance models. It is rounded to one decimal;
 * see App\Geo\GreatCircle::walkMeters() for why.
 *
 * Every float in a transfer record is emitted as a JSON double and every
 * integer as a JSON integer. That is not automatic: PDO_PGSQL returns
 * numerics as PHP strings, so without the explicit casts in the transfer loop
 * below walk_distance and the four coordinates would ship quoted, and
 * `(map['walk_distance'] as num)` on the Dart side throws a TypeError. The
 * ids and indices need no cast because they already arrive as PHP ints.
 *
 * average_rating is the one field still emitted as a string, and for a
 * different reason: Laravel's decimal:2 cast returns a string by design, to
 * keep the trailing zeros of "3.98". It is called out here so nobody reads
 * the paragraph above as a blanket guarantee.
 *
 * The distances are unrounded float64, which makes the export's JSON encoding
 * part of the contract: JSON_PRESERVE_ZERO_FRACTION keeps the leading 0.0 from
 * degrading into an int, and json_encode truncates doubles to
 * serialize_precision significant digits, silently and up to centimetres,
 * unless that ini value is at its shortest-round-trip setting. Both are
 * enforced below rather than left to the host's php.ini.
 *
 * The version is stamped once into the NDJSON meta record from
 * --data-version. The Dart CLI copies it into the database's
 * offline_metadata table and the published meta.json carries the same value
 * as an integer. There is deliberately no second source of version truth:
 * bump --data-version and the app's "update available" prompt follows.
 *
 * Usage:
 *   php artisan lines:export-offline --data-version=2
 *   php artisan lines:export-offline --data-version=2 --path=offline/data.db.gz
 *   php artisan lines:export-offline --data-version=2 --flutter-repo=/path/to/tu_cromi_app
 *   php artisan lines:export-offline --data-version=2 --skip-dart-cli
 *   php artisan lines:export-offline --data-version=2 --upload
 */
class LinesExportOffline extends Command
{
    use UploadsBundleToR2;

    protected $signature = 'lines:export-offline
        {--data-version= : Data version (required)}
        {--path= : SQLite bundle path relative to storage/app}
        {--flutter-repo= : Flutter checkout that owns tools/build_offline_db.dart}
        {--dart= : Dart executable used to run the CLI}
        {--skip-dart-cli : Stop after the NDJSON intermediate, without building SQLite}
        {--upload : Upload the SQLite bundle and manifest to Cloudflare R2}';

    protected $description = 'Build the offline SQLite bundle (NDJSON intermediate + Dart CLI)';

    /**
     * Flags for every record in the bundle, and for the manifest.
     *
     * This is the bundle's contract with the app, so it is declared once here
     * rather than repeated per call site. JSON_PRESERVE_ZERO_FRACTION is what
     * keeps a 0 m transfer emitting 0.0 instead of 0, and what keeps
     * cumulative_distance[0] a double rather than an int — the app reads both
     * as numbers, and an int is a type change the consumer never asked for.
     */
    private const JSON_FLAGS = JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION;

    public function handle(): int
    {
        $dataVersion = $this->option('data-version');

        if ($dataVersion === null || $dataVersion === '') {
            $this->error('The --data-version option is required.');

            return self::FAILURE;
        }

        // Cast-and-hope used to turn 'abc' into 0, and a published version 0
        // matches a phone's starter version, so the update prompt never fires
        // and the failure looks like the app ignoring a good bundle. A version
        // has to be an integer or it is a typo.
        if (filter_var($dataVersion, FILTER_VALIDATE_INT) === false) {
            $this->error('--data-version must be an integer.');

            return self::FAILURE;
        }

        $dataVersion = (int) $dataVersion;

        if (! $this->ensureFloatPrecision()) {
            return self::FAILURE;
        }

        $skipDartCli = (bool) $this->option('skip-dart-cli');

        // Without the SQLite build there is nothing publishable: a meta.json
        // with no data.db.gz beside it, or one missing data_sha256, is not a
        // bundle the app can install. Refusing here is cheaper than letting an
        // operator publish a half-existing pair.
        if ($skipDartCli && $this->option('upload')) {
            $this->error('--upload needs the SQLite bundle the Dart CLI produces. Drop --skip-dart-cli or drop --upload.');

            return self::FAILURE;
        }

        $path = (string) ($this->option('path') ?: 'offline/data.db.gz');

        // The bundle and its two satellites share one directory. The sidecar
        // path used to be derived separately on the export side and hardcoded
        // as 'offline/meta.json' on the upload side, so exporting to a custom
        // --path published whatever sidecar happened to be lying in offline/
        // — or none at all, silently, because Storage::get() returns null
        // rather than throwing.
        $artifactPaths = self::artifactPaths($path);
        $metaPath = $artifactPaths['meta'];
        $ndjsonPath = $artifactPaths['ndjson'];

        if (dirname($path) !== '.') {
            Storage::makeDirectory(dirname($path));
        }

        $linesUpdatedAt = Line::max('updated_at');

        // Stamped once, and the published manifest reuses this exact string
        // rather than calling now() again: the old sidecar did, and so
        // advertised a generation time later than the bundle it describes —
        // by exactly as long as the export took.
        $generatedAt = now()->toIso8601String();
        $updatedAt = $linesUpdatedAt ? Carbon::parse($linesUpdatedAt)->toIso8601String() : null;

        $flutterRepo = (string) ($this->option('flutter-repo') ?: config('offline.flutter_repo') ?: '');
        $dart = (string) ($this->option('dart') ?: config('offline.dart_binary') ?: 'dart');

        // Everything answerable without writing the dump is answered before
        // the dump. A mistyped Flutter repo or an SDK too old to resolve the
        // app's package graph used to surface only after 1.35M rows had been
        // written — minutes spent learning a typo.
        if (! $skipDartCli) {
            if (! $this->assertDartCliIsRunnable($flutterRepo, $dart)) {
                return self::FAILURE;
            }

            $this->warnIfVersionNotIncreasing($metaPath, $dataVersion);
            $this->warnIfTransfersAreStale();
        }

        if (! $this->dumpNdjson($ndjsonPath, $dataVersion, $updatedAt, $generatedAt)) {
            return self::FAILURE;
        }

        $this->info(sprintf(
            'Wrote NDJSON intermediate %s (%s)',
            Storage::path($ndjsonPath),
            $this->formatBytes(Storage::size($ndjsonPath)),
        ));

        if ($skipDartCli) {
            $this->info('Skipped the Dart CLI (--skip-dart-cli): no SQLite bundle and no meta.json were produced.');

            return self::SUCCESS;
        }

        // ── Dart CLI ────────────────────────────────────────────────────
        $cliManifest = $this->buildSqliteBundle($flutterRepo, $dart, $ndjsonPath, $path, $metaPath);

        if ($cliManifest === null) {
            return self::FAILURE;
        }

        // ── Published manifest ──────────────────────────────────────────
        if (! $this->writeManifest($path, $metaPath, $cliManifest, $dataVersion, $updatedAt, $generatedAt)) {
            return self::FAILURE;
        }

        $this->info(sprintf(
            'Exported %s (%s) and %s (%s)',
            Storage::path($path), $this->formatBytes(Storage::size($path)),
            Storage::path($metaPath), $this->formatBytes(Storage::size($metaPath)),
        ));

        // ── Upload to Cloudflare R2 ─────────────────────────────────────
        // A failed upload has to fail the command. It used to return void, so
        // --upload exited zero having published nothing, which is the kind of
        // silence CI cannot see.
        if ($this->option('upload') && ! $this->uploadToR2($path, $metaPath)) {
            return self::FAILURE;
        }

        return self::SUCCESS;
    }

    /**
     * Write the NDJSON intermediate that the Dart CLI consumes.
     *
     * This is the bundle's contract with the app's own builder: one JSON
     * object per line, fixed record order (meta, lines by id, transfers by
     * (line_a_id, line_b_id, point_a_index, point_b_index)), coordinates as
     * [lng, lat], and every float emitted as a JSON double. The CLI rejects a
     * bundle whose schema it does not know, so a change here has to land with
     * the CLI in lockstep.
     *
     * @return bool False when the stream could not be opened or finished.
     */
    private function dumpNdjson(
        string $ndjsonPath,
        int $dataVersion,
        ?string $updatedAt,
        string $generatedAt,
    ): bool {
        $totalLines = Line::count();
        $totalTransfers = DB::table('line_transfers')->count();

        $bar = $this->output->createProgressBar($totalLines + $totalTransfers + 1);
        $bar->start();

        $ndjsonFullPath = Storage::path($ndjsonPath);
        $stream = gzopen($ndjsonFullPath, 'wb');

        if ($stream === false) {
            $this->error("Could not open output path: {$ndjsonFullPath}");

            return false;
        }

        // ── Meta ────────────────────────────────────────────────────────
        $this->writeRecord($stream, [
            'type' => 'meta',
            'version' => $dataVersion,
            'generated_at' => $generatedAt,
            'updated_at' => $updatedAt,
            'total_lines' => $totalLines,
            'total_transfers' => $totalTransfers,
        ]);
        $bar->advance();

        // ── Lines ───────────────────────────────────────────────────────
        // Ordered by primary key, and the transfer loop below likewise, so
        // that two runs over unchanged data emit byte-identical NDJSON. An
        // unordered cursor hands the row order to whatever the query planner
        // felt like, which makes the compressed bundle differ every time and
        // defeats any content hash or diff on the client side.
        foreach (Line::orderBy('id')->cursor() as $line) {
            $this->writeRecord($stream, [
                'type' => 'line',
                'id' => $line->id,
                'code' => $line->code,
                'name' => $line->name,
                'sense' => $line->sense->value,
                'color' => $line->color,
                'cumulative_distance' => GreatCircle::forGeometry($line->geo_json),
                'geo_json' => $line->geo_json,
                'parent_line_id' => $line->parent_line_id,
                'syndicate' => $line->syndicate,
                'objectid' => $line->objectid,
                'average_rating' => $line->average_rating,
                'total_reviews' => $line->total_reviews,
            ]);
            $bar->advance();
        }

        // ── Transfers ───────────────────────────────────────────────────
        // The four coordinates and walk_distance are cast explicitly because
        // PDO_PGSQL hands numerics back as PHP strings: without the cast they
        // are json_encode'd as "8.5" rather than 8.5, and the app's
        // `as num` on walk_distance throws a TypeError on a String. The ids
        // and indices need no cast — those come back as PHP ints.
        //
        // JSON_PRESERVE_ZERO_FRACTION keeps a 0 m transfer emitting 0.0 rather
        // than 0, so every float in the bundle is a JSON double and the
        // consumer can read them all as numbers without a per-field exception
        // for the zero case.
        // The pair alone is not a total order: 1,35M transfers spread over
        // ~60k line pairs leave ~22 rows tied on (line_a_id, line_b_id), and
        // those would come out in an arbitrary order. Adding the two vertex
        // indices — which together with the ids are unique — makes the order
        // total, and happens to put each pair's transfer points in travel
        // order along the line instead of scattered.
        foreach (DB::table('line_transfers')
            ->orderBy('line_a_id')
            ->orderBy('line_b_id')
            ->orderBy('point_a_index')
            ->orderBy('point_b_index')
            ->cursor() as $t) {
            $this->writeRecord($stream, [
                'type' => 'transfer',
                'line_a_id' => $t->line_a_id,
                'line_b_id' => $t->line_b_id,
                'point_a_lng' => (float) $t->point_a_lng,
                'point_a_lat' => (float) $t->point_a_lat,
                'point_a_index' => $t->point_a_index,
                'point_b_lng' => (float) $t->point_b_lng,
                'point_b_lat' => (float) $t->point_b_lat,
                'point_b_index' => $t->point_b_index,
                'walk_distance' => (float) $t->walk_distance,
            ]);
            $bar->advance();
        }

        if (! gzclose($stream)) {
            $this->error("Could not finish writing {$ndjsonFullPath}.");

            return false;
        }

        $bar->finish();
        $this->newLine();

        return true;
    }

    /**
     * Check that the Dart CLI could actually run, before the dump is written.
     *
     * Both answers are questions about the environment, and both used to
     * arrive minutes late: a mistyped OFFLINE_FLUTTER_REPO or an SDK too old
     * to resolve the app's package graph surfaced only after 1.35M rows had
     * been written. The script is checked before anything is invoked so the
     * error names the path that was wrong rather than a process failure.
     */
    private function assertDartCliIsRunnable(string $flutterRepo, string $dart): bool
    {
        if ($flutterRepo === '') {
            $this->error('Set OFFLINE_FLUTTER_REPO (or pass --flutter-repo=) to the Flutter app checkout that owns tools/build_offline_db.dart.');

            return false;
        }

        if (! is_file(rtrim($flutterRepo, '/\\').'/tools/build_offline_db.dart')) {
            $this->error("The Dart CLI was not found at {$flutterRepo}/tools/build_offline_db.dart. Check OFFLINE_FLUTTER_REPO.");

            return false;
        }

        return $this->assertDartVersion($dart);
    }

    /**
     * Warn when the new version does not move past the last local export.
     *
     * Nothing here is fatal — re-exporting the same version is legitimate —
     * but a forgotten bump is the quietest failure in this pipeline: R2 gets
     * overwritten with fresh data under a version every installed app already
     * has, so no phone is ever prompted and the bundle change is invisible.
     * The check reads the local manifest, so on a fresh checkout there is
     * nothing to compare against and it stays quiet.
     */
    private function warnIfVersionNotIncreasing(string $metaPath, int $dataVersion): void
    {
        $metaFile = Storage::path($metaPath);

        if (! is_file($metaFile)) {
            return;
        }

        $previous = json_decode((string) file_get_contents($metaFile), true);
        $previousVersion = is_array($previous) ? ($previous['version'] ?? null) : null;

        if (! is_numeric($previousVersion) || (int) $previousVersion < $dataVersion) {
            return;
        }

        $this->warn(
            "Version {$dataVersion} is not greater than the previous local export (version {$previousVersion}). "
            .'Clients already on that version will not be prompted to update — bump --data-version if the data changed.'
        );
    }

    /**
     * Warn when a line in the bundle has been hand-corrected since the transfers
     * were computed.
     *
     * `geometry_adjusted` is a dirty flag and its documented meaning is exactly
     * this: the line's geometry no longer matches what the transfer rows were
     * measured against. `line_transfers` addresses vertices by index, so an edited
     * line publishes transfers that now describe different pairs of points — and
     * the app ships those indexes to riders, who are then told to transfer between
     * two places a block apart.
     *
     * `lines:refresh-geometry` has always said so when it invalidates the indexes
     * itself. This is the same warning from the other end, and it is here because
     * the flag is set by *every* geometry save in the editor, not only by that
     * command: the editor's own tools remove vertices — a re-spacing rewrites the
     * interior of a selection, and laying a dragged stretch along a street drops
     * whatever runs past the end of it — so this is now a routine way for the
     * indexes to go stale rather than an exceptional one.
     *
     * A warning and not a refusal. The bundle may well be wanted anyway — the
     * geometry is the reviewer's work and shipping it is the point — and the
     * decision to spend seventeen minutes on `transfers:compute` belongs to
     * whoever is holding the deploy. What was missing was the sentence, and a
     * silence here reads as a clean run.
     */
    private function warnIfTransfersAreStale(): void
    {
        $adjusted = Line::query()->where('geometry_adjusted', true)->count();

        if ($adjusted === 0) {
            return;
        }

        $stale = DB::table('line_transfers')
            ->whereIn('line_a_id', Line::query()->where('geometry_adjusted', true)->select('id'))
            ->orWhereIn('line_b_id', Line::query()->where('geometry_adjusted', true)->select('id'))
            ->count();

        if ($stale === 0) {
            return;
        }

        $this->warn(sprintf(
            '%d %s on %d hand-corrected %s hold point indexes that no longer describe the geometry. '
            .'Re-run transfers:compute before publishing, or riders will be given transfer points a block apart.',
            $stale,
            Str::plural('transfer', $stale),
            $adjusted,
            Str::plural('line', $adjusted),
        ));
    }

    /**
     * Resolve the three artifact paths from the bundle path.
     *
     * Public and static so the '.' branch — a bundle at the storage root,
     * where dirname() is '.' — is testable without a database. There a
     * './meta.json' still resolves on the local filesystem, but an R2 object
     * key is literal: the app would look for meta.json at the bucket root
     * forever while the upload sat under a key it never requests.
     *
     * @return array{bundle: string, meta: string, ndjson: string}
     */
    public static function artifactPaths(string $bundlePath): array
    {
        $directory = dirname($bundlePath);
        $prefix = $directory === '.' ? '' : $directory.'/';

        return [
            'bundle' => $bundlePath,
            'meta' => $prefix.'meta.json',
            'ndjson' => $prefix.'data.ndjson.gz',
        ];
    }

    /**
     * Convert the NDJSON intermediate into the gzipped SQLite bundle.
     *
     * The repo and the Dart binary arrive already resolved and checked by
     * assertDartCliIsRunnable(); this only runs the build.
     *
     * The build is given 10 minutes: a full 1.35 M-row bundle takes 3-5, and
     * the default 60 s would time out every real run.
     *
     * Output is streamed rather than buffered: the CLI reports progress every
     * 200k transfers, and a frozen terminal for five minutes reads like a
     * hang. The exception covers both a missing dart binary and a timeout.
     *
     * @return array<string, mixed>|null The CLI's manifest, or null when the
     *                                   build failed and nothing may be published.
     */
    private function buildSqliteBundle(
        string $flutterRepo,
        string $dart,
        string $ndjsonPath,
        string $bundlePath,
        string $manifestPath,
    ): ?array {
        $this->info('Building the SQLite bundle with the Dart CLI. A full bundle takes 3-5 minutes...');

        try {
            $result = Process::path($flutterRepo)
                ->timeout(600)
                ->start([
                    $dart, 'run', ...$this->dartRunFlags(), 'tools/build_offline_db.dart',
                    '--input', Storage::path($ndjsonPath),
                    '--output', Storage::path($bundlePath),
                    '--manifest', Storage::path($manifestPath),
                ], function (string $type, string $output): void {
                    $this->output->write($output);
                })
                ->wait();
        } catch (\Throwable $e) {
            // A missing dart binary, a timeout, and similar process-level
            // failures land here. The command's job is to fail the export,
            // not to spill a stack trace over an operations terminal.
            $this->error("The Dart CLI could not be run: {$e->getMessage()}");

            return null;
        }

        if (! $result->successful()) {
            $this->error("The Dart CLI failed with exit code {$result->exitCode()}.");

            return null;
        }

        $manifestJson = is_file(Storage::path($manifestPath)) ? file_get_contents(Storage::path($manifestPath)) : false;

        if ($manifestJson === false) {
            $this->error('The Dart CLI did not write a manifest.');

            return null;
        }

        $manifest = json_decode($manifestJson, true);

        if (! is_array($manifest)) {
            $this->error('The Dart CLI manifest is not valid JSON.');

            return null;
        }

        /** @var array<string, mixed> $manifest */
        return $manifest;
    }

    /**
     * Refuse to build with a Dart too old to resolve the app's package graph.
     *
     * Before native assets reached stable, `dart run` answers a package that
     * needs the feature with "enable native assets with --enable-experiment=
     * native-assets" — even when that flag is already in the command. That
     * message sent us chasing the invocation while the real problem was a
     * second, older dart earlier in the resolver's order: PHP's
     * ExecutableFinder checks .bat wrappers with is_executable(), which
     * returns false on Windows, so Flutter's dart.bat loses to a bare
     * dart.exe that is years behind. Checking the version first turns that
     * scavenger hunt into one line.
     *
     * Unparseable output is not an error here: if dart is missing or broken,
     * the build step reports it with the command it tried to run.
     */
    private function assertDartVersion(string $dart): bool
    {
        $result = Process::timeout(30)->run([$dart, '--version']);

        $version = $result->output().$result->errorOutput();

        if (! preg_match('/Dart SDK version: (\d+)\.(\d+)/', $version, $matches)) {
            return true;
        }

        if ((int) $matches[1] > 3 || ((int) $matches[1] === 3 && (int) $matches[2] >= 11)) {
            return true;
        }

        $this->error(
            "The resolved Dart is {$matches[1]}.{$matches[2]}, which cannot build this bundle: "
            .'native assets need Dart 3.11 or newer. Point OFFLINE_DART_BINARY (or --dart=) '
            .'at a newer SDK — for example the dart bundled with Flutter.'
        );

        return false;
    }

    /**
     * VM options Dart needs between `run` and the script path.
     *
     * `dart run [vm-options] <dart-file>`, so placement matters: putting them
     * after the script would hand them to the CLI as its own arguments.
     *
     * The default is the native-assets experiment. The app's dependency graph
     * reaches `objective_c` through its Apple platform plugins, and this SDK
     * refuses to resolve it otherwise. It is env-configurable because the
     * flag is an SDK detail: a Dart that graduates the feature can drop it by
     * emptying OFFLINE_DART_RUN_FLAGS, and an expired flag only warns.
     *
     * @return list<string>
     */
    private function dartRunFlags(): array
    {
        $flags = trim((string) config('offline.dart_run_flags'));

        if ($flags === '') {
            return [];
        }

        return preg_split('/\s+/', $flags, -1, PREG_SPLIT_NO_EMPTY) ?: [];
    }

    /**
     * Write the published meta.json from Laravel's own export state.
     *
     * The CLI's manifest is not copied: it names the size `gz_bytes`, writes
     * `version` as a string (a client comparing `remote > local` on a String
     * would silently never update), and knows nothing about data_sha256 or
     * generated_at. What it does own is the counts, and those are read from
     * it — they describe what actually landed in the database.
     *
     * data_bytes and data_sha256 are measured here, on the file that is about
     * to be uploaded, so the manifest can never certify bytes that are not the
     * bytes in the bucket.
     *
     * @param  array<string, mixed>  $cliManifest
     */
    private function writeManifest(
        string $bundlePath,
        string $metaPath,
        array $cliManifest,
        int $dataVersion,
        ?string $updatedAt,
        string $generatedAt,
    ): bool {
        if (! isset($cliManifest['total_lines'], $cliManifest['total_transfers'])) {
            $this->error('The Dart CLI manifest is missing total_lines or total_transfers.');

            return false;
        }

        $bundleFullPath = Storage::path($bundlePath);
        $dataBytes = filesize($bundleFullPath);
        $dataSha256 = hash_file('sha256', $bundleFullPath);

        if ($dataBytes === false || $dataSha256 === false) {
            $this->error("Could not measure the SQLite bundle at {$bundleFullPath}.");

            return false;
        }

        $manifest = [
            'version' => $dataVersion,
            'updated_at' => $updatedAt,
            'generated_at' => $generatedAt,
            'total_lines' => (int) $cliManifest['total_lines'],
            'total_transfers' => (int) $cliManifest['total_transfers'],
            'data_bytes' => $dataBytes,
            'data_sha256' => $dataSha256,
        ];

        $json = json_encode($manifest, self::JSON_FLAGS | JSON_PRETTY_PRINT);

        if ($json === false) {
            $this->error('Could not encode the manifest: '.json_last_error_msg());

            return false;
        }

        if (file_put_contents(Storage::path($metaPath), $json."\n") === false) {
            $this->error('Could not write '.Storage::path($metaPath));

            return false;
        }

        return true;
    }

    /**
     * Append one encoded NDJSON record to the open gzip stream.
     *
     * A failure throws rather than writing nothing. json_encode only fails on
     * malformed UTF-8, and the free-text `name` and `syndicate` columns are
     * exactly where that would come from — writing `false . "\n"` would put a
     * blank line in the bundle, which the app reads as a malformed record
     * rather than as a failed export.
     *
     * @param  resource  $stream
     * @param  array<string, mixed>  $record
     *
     * @throws \RuntimeException
     */
    private function writeRecord($stream, array $record): void
    {
        $json = json_encode($record, self::JSON_FLAGS);

        if ($json === false) {
            throw new \RuntimeException('Could not encode a bundle record: '.json_last_error_msg());
        }

        if ((int) gzwrite($stream, $json."\n") === 0) {
            throw new \RuntimeException('Could not write a bundle record to the NDJSON stream.');
        }
    }

    /**
     * Make sure json_encode can express a float64 without losing digits.
     *
     * json_encode formats doubles with `serialize_precision` significant
     * digits, and PHP defaults it to -1, which means the shortest
     * representation that round-trips. A host configured with the older
     * default of 6 would quietly rewrite 611.9834402331257 as 611.983: no
     * warning, no error, just a bundle whose ride lengths disagree with the
     * ones the app measures by up to centimetres per vertex.
     *
     * The value is PHP_INI_ALL, so it is corrected here instead of refused:
     * stopping a build step over a setting the run can fix itself would be
     * friction, and the alternative — silently shipping lossy distances — is
     * not acceptable. A host that refuses the assignment does get stopped,
     * because then the only options are shipping bad data or not shipping.
     *
     * @return bool False only when the setting is wrong and cannot be fixed.
     */
    private function ensureFloatPrecision(): bool
    {
        $precision = ini_get('serialize_precision');

        if ($precision === '-1' || $precision === false || (int) $precision >= 17) {
            return true;
        }

        if (@ini_set('serialize_precision', '-1') !== false) {
            return true;
        }

        $this->error(
            "serialize_precision is {$precision}, which truncates the exported "
            .'distances. Set it to -1 (shortest round-trip) in php.ini.'
        );

        return false;
    }

    private function formatBytes(int $bytes): string
    {
        if ($bytes < 1024) {
            return $bytes.' B';
        }

        $units = ['KB', 'MB', 'GB'];
        $i = -1;

        while ($bytes >= 1024 && $i < count($units) - 1) {
            $bytes /= 1024;
            $i++;
        }

        return number_format($bytes, 1).' '.$units[$i];
    }
}
