<?php

namespace App\Console\Commands;

use App\Concerns\UploadsBundleToR2;
use App\Geo\GreatCircle;
use App\Models\Line;
use Illuminate\Console\Command;
use Illuminate\Support\Arr;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;

/**
 * Export lines and transfers to an NDJSON file for offline use
 * in the Flutter app.
 *
 * Format:
 * - One JSON object per line (newline-delimited)
 * - First record is {"type":"meta",...} with version and summary
 * - Line records: {"type":"line",...}
 * - Transfer records: {"type":"transfer",...}
 * Also writes a meta.json sidecar in the same directory (version, generated_at,
 * total_lines, total_transfers) for quick access without decompressing.
 *
 * Line records carry cumulative_distance, the distance in metres from the
 * first vertex to every other one, as an array parallel to the flattened
 * coordinates. The app ranks transfer options by ride length in SQL, where
 * SQLite has no sin or cos, so the number travels with the geometry instead of
 * being derived on the device. See App\Geo\GreatCircle for the formula and for
 * why its constants must not be "improved".
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
 * serialize_precision significant digits, silently and by up to centimetres,
 * unless that ini value is at its shortest-round-trip setting. Both are
 * enforced below rather than left to the host's php.ini.
 *
 * Output is gzip-compressed by default. Use --no-compress for raw NDJSON.
 *
 * Usage:
 *   php artisan lines:export-offline --data-version=1
 *   php artisan lines:export-offline --data-version=2 --path=offline/custom.ndjson.gz
 *   php artisan lines:export-offline --data-version=1 --no-compress
 *   php artisan lines:export-offline --data-version=1 --upload
 */
class LinesExportOffline extends Command
{
    use UploadsBundleToR2;

    protected $signature = 'lines:export-offline
        {--data-version= : Data version (required)}
        {--path= : Output path relative to storage/app}
        {--no-compress : Output uncompressed NDJSON instead of gzip}
        {--upload : Upload exported files to Cloudflare R2}';

    protected $description = 'Export lines and transfers as NDJSON for offline use';

    /**
     * Flags for every record in the bundle, and for the sidecar.
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

        $dataVersion = (int) $dataVersion;

        if (! $this->ensureFloatPrecision()) {
            return self::FAILURE;
        }

        $compress = ! $this->option('no-compress');
        $ext = $compress ? '.ndjson.gz' : '.ndjson';
        $path = $this->option('path') ?: 'offline/data'.$ext;

        // One path, used for both the local write and the upload. These were
        // derived separately, and the upload side had 'offline/meta.json'
        // hardcoded — so exporting to a custom path uploaded whatever
        // sidecar happened to be lying in offline/, describing a different
        // bundle than the one it published beside it.
        $metaPath = dirname($path).'/meta.json';

        $totalLines = Line::count();
        $totalTransfers = DB::table('line_transfers')->count();
        $linesUpdatedAt = Line::max('updated_at');

        $fullPath = Storage::path($path);
        Storage::makeDirectory(dirname($path));

        $bar = $this->output->createProgressBar($totalLines + $totalTransfers + 1);
        $bar->start();

        $stream = $compress ? gzopen($fullPath, 'wb') : fopen($fullPath, 'wb');

        if ($stream === false) {
            $this->error("Could not open output path: {$fullPath}");

            return self::FAILURE;
        }

        $write = function (string $data) use ($stream, $compress): void {
            if ($compress) {
                gzwrite($stream, $data);
            } else {
                fwrite($stream, $data);
            }
        };

        // Stamped once. The sidecar used to call now() a second time, at the
        // end of the export, so it advertised a generation time later than the
        // bundle it describes — by exactly as long as the export took.
        $generatedAt = now()->toIso8601String();

        // ── Meta ────────────────────────────────────────────────────────
        $meta = [
            'type' => 'meta',
            'version' => $dataVersion,
            'generated_at' => $generatedAt,
            'updated_at' => $linesUpdatedAt ? Carbon::parse($linesUpdatedAt)->toIso8601String() : null,
            'total_lines' => $totalLines,
            'total_transfers' => $totalTransfers,
        ];
        $write($this->encodeRecord($meta)."\n");
        $bar->advance();

        // ── Lines ───────────────────────────────────────────────────────
        // Ordered by primary key, and the transfer loop below likewise, so
        // that two runs over unchanged data emit byte-identical NDJSON. An
        // unordered cursor hands the row order to whatever the query planner
        // felt like, which makes the compressed bundle differ every time and
        // defeats any content hash or diff on the client side.
        foreach (Line::orderBy('id')->cursor() as $line) {
            $record = [
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
            ];
            $write($this->encodeRecord($record)."\n");
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
            $record = [
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
            ];
            $write($this->encodeRecord($record)."\n");
            $bar->advance();
        }

        if ($compress) {
            gzclose($stream);
        } else {
            fclose($stream);
        }

        // ── Meta sidecar ────────────────────────────────────────────────
        // Derived from the record rather than rebuilt: the two used to be
        // assembled separately, which is how they came to describe different
        // timestamps for the same export.
        file_put_contents(Storage::path($metaPath), $this->encodeRecord(Arr::except($meta, 'type'))."\n");

        $bar->finish();
        $this->newLine();

        // Storage::size() returns int, and throws when the file is unreadable.
        // filesize() returned int|false instead, so the report below printed
        // "0 B" for a bundle that had failed to write.
        $size = Storage::size($path);
        $metaSize = Storage::size($metaPath);
        $this->info(sprintf(
            'Exported %s (%s) and %s (%s)',
            $fullPath, $this->formatBytes($size),
            $metaPath, $this->formatBytes($metaSize),
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
     * Encode one NDJSON record with the bundle's flag set.
     *
     * A failure throws rather than returning an empty string. json_encode only
     * fails on malformed UTF-8, and the free-text `name` and `syndicate` columns
     * are exactly where that would come from — writing `false . "\n"` would put a
     * blank line in the bundle, which the app reads as a malformed record rather
     * than as a failed export.
     *
     * @param  array<string, mixed>  $record
     *
     * @throws \RuntimeException
     */
    private function encodeRecord(array $record): string
    {
        $json = json_encode($record, self::JSON_FLAGS);

        if ($json === false) {
            throw new \RuntimeException('Could not encode a bundle record: '.json_last_error_msg());
        }

        return $json;
    }

    /**
     * Make sure json_encode can express a float64 without losing digits.
     *
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
