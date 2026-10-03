<?php

namespace App\Console\Commands;

use App\Geo\GreatCircle;
use App\Models\Line;
use Illuminate\Console\Command;
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
    protected $signature = 'lines:export-offline
        {--data-version= : Data version (required)}
        {--path= : Output path relative to storage/app}
        {--no-compress : Output uncompressed NDJSON instead of gzip}
        {--upload : Upload exported files to Cloudflare R2}';

    protected $description = 'Export lines and transfers as NDJSON for offline use';

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

        // ── Meta ────────────────────────────────────────────────────────
        $meta = [
            'type' => 'meta',
            'version' => $dataVersion,
            'generated_at' => now()->toIso8601String(),
            'updated_at' => $linesUpdatedAt ? Carbon::parse($linesUpdatedAt)->toIso8601String() : null,
            'total_lines' => $totalLines,
            'total_transfers' => $totalTransfers,
        ];
        $write(json_encode($meta)."\n");
        $bar->advance();

        // ── Lines ───────────────────────────────────────────────────────
        foreach (Line::cursor() as $line) {
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
            $write(json_encode($record, JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION)."\n");
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
        foreach (DB::table('line_transfers')->orderBy('line_a_id')->orderBy('line_b_id')->cursor() as $t) {
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
            $write(json_encode($record, JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION)."\n");
            $bar->advance();
        }

        if ($compress) {
            gzclose($stream);
        } else {
            fclose($stream);
        }

        // ── Meta sidecar ────────────────────────────────────────────────
        $metaPath = dirname($fullPath).'/meta.json';
        file_put_contents(
            $metaPath,
            json_encode([
                'version' => $dataVersion,
                'generated_at' => now()->toIso8601String(),
                'updated_at' => $linesUpdatedAt ? Carbon::parse($linesUpdatedAt)->toIso8601String() : null,
                'total_lines' => $totalLines,
                'total_transfers' => $totalTransfers,
            ], JSON_UNESCAPED_UNICODE)."\n",
        );

        $bar->finish();
        $this->newLine();

        $size = filesize($fullPath);
        $metaSize = filesize($metaPath);
        $this->info(sprintf(
            'Exported %s (%s) and %s (%s)',
            $fullPath, $this->formatBytes($size),
            $metaPath, $this->formatBytes($metaSize),
        ));

        // ── Upload to Cloudflare R2 ─────────────────────────────────────
        if ($this->option('upload')) {
            $this->uploadToR2($path, $metaPath);
        }

        return self::SUCCESS;
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

    private function uploadToR2(string $path, string $metaPath): void
    {
        $this->newLine();
        $this->info('Uploading to Cloudflare R2...');

        $r2 = Storage::disk('r2');
        $baseUrl = rtrim((string) config('filesystems.disks.r2.url'), '/');

        $files = [$path, 'offline/meta.json'];
        $mimeTypes = [
            $path => str_ends_with($path, '.gz') ? 'application/gzip' : 'application/x-ndjson',
            'offline/meta.json' => 'application/json',
        ];

        $spinner = $this->output->createProgressBar(0);
        $spinner->setFormat(' %message% %cycle%');

        foreach ($files as $file) {
            try {
                $r2->delete($file);
            } catch (\Throwable) {
                // File may not exist yet — safe to ignore.
            }
        }

        foreach ($files as $file) {
            $contents = Storage::get($file);

            if ($contents === null) {
                $spinner->finish();
                $this->newLine();
                $this->error("Failed to read local file: {$file}");

                return;
            }

            $spinner->setMessage("Uploading {$file}...");
            $spinner->advance();

            try {
                $result = $r2->put($file, $contents, ['Content-Type' => $mimeTypes[$file]]);

                if ($result === false) {
                    $spinner->finish();
                    $this->newLine();
                    $this->error("Failed to upload {$file} to R2 (put returned false). Check R2 credentials and bucket.");

                    return;
                }
            } catch (\Throwable $e) {
                $spinner->finish();
                $this->newLine();
                $this->error("Failed to upload {$file} to R2: {$e->getMessage()}");

                return;
            }

            $spinner->finish();
            $this->newLine();
            $this->info("  Uploaded {$baseUrl}/{$file}");
        }

        $this->info('Upload complete.');
    }
}
