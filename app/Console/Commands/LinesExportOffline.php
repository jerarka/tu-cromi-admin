<?php

namespace App\Console\Commands;

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
                'geo_json' => $line->geo_json,
                'parent_line_id' => $line->parent_line_id,
                'syndicate' => $line->syndicate,
                'objectid' => $line->objectid,
                'average_rating' => $line->average_rating,
                'total_reviews' => $line->total_reviews,
            ];
            $write(json_encode($record, JSON_UNESCAPED_UNICODE)."\n");
            $bar->advance();
        }

        // ── Transfers ───────────────────────────────────────────────────
        foreach (DB::table('line_transfers')->orderBy('line_a_id')->orderBy('line_b_id')->cursor() as $t) {
            $record = [
                'type' => 'transfer',
                'line_a_id' => $t->line_a_id,
                'line_b_id' => $t->line_b_id,
                'point_a_lng' => $t->point_a_lng,
                'point_a_lat' => $t->point_a_lat,
                'point_a_index' => $t->point_a_index,
                'point_b_lng' => $t->point_b_lng,
                'point_b_lat' => $t->point_b_lat,
                'point_b_index' => $t->point_b_index,
                'walk_distance' => $t->walk_distance,
            ];
            $write(json_encode($record, JSON_UNESCAPED_UNICODE)."\n");
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
