<?php

namespace App\Concerns;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\Console\Helper\ProgressBar;

/**
 * Publish an exported bundle and its meta sidecar to Cloudflare R2.
 *
 * @mixin Command
 */
trait UploadsBundleToR2
{
    /**
     * Upload the bundle and its sidecar, replacing whatever is there.
     *
     * Both objects are deleted before either is written, and the bundle goes
     * up before the sidecar. That order is deliberate and should not be
     * tidied up: the sidecar is what a client reads to learn that a new version
     * exists, so publishing it first would advertise a version whose bundle has
     * not landed yet. The other side of the same coin is that a failed upload
     * leaves the bucket with neither object, which makes a client fall back to
     * the bundle it already has instead of to a half-published pair.
     *
     * @param  string  $bundlePath  Path of the bundle on the local disk
     * @param  string  $sidecarPath  Path of the sidecar on the local disk
     * @return bool False when anything failed to publish. The caller must not
     *              report success on false: the whole point of returning a
     *              boolean is that a failed upload used to exit zero.
     */
    protected function uploadToR2(string $bundlePath, string $sidecarPath): bool
    {
        $this->newLine();
        $this->info('Uploading to Cloudflare R2...');

        $r2 = Storage::disk('r2');
        $baseUrl = rtrim((string) config('filesystems.disks.r2.url'), '/');

        $files = [$bundlePath, $sidecarPath];
        $mimeTypes = [
            $bundlePath => str_ends_with($bundlePath, '.gz') ? 'application/gzip' : 'application/x-ndjson',
            $sidecarPath => 'application/json',
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
                $this->abortUpload($spinner, "Failed to read local file: {$file}");

                return false;
            }

            $spinner->setMessage("Uploading {$file}...");
            $spinner->advance();

            try {
                $result = $r2->put($file, $contents, ['Content-Type' => $mimeTypes[$file]]);

                if ($result === false) {
                    $this->abortUpload($spinner, "Failed to upload {$file} to R2 (put returned false). Check R2 credentials and bucket.");

                    return false;
                }
            } catch (\Throwable $e) {
                $this->abortUpload($spinner, "Failed to upload {$file} to R2: {$e->getMessage()}");

                return false;
            }

            $spinner->finish();
            $this->newLine();
            $this->info("  Uploaded {$baseUrl}/{$file}");
        }

        $this->info('Upload complete.');

        return true;
    }

    /**
     * Close the spinner and report why the upload stopped.
     *
     * Three branches of the upload loop each had to remember to stop the
     * spinner, put a newline after it, and then bail — which is how one of
     * them could be missed. It is one line here instead.
     */
    private function abortUpload(ProgressBar $spinner, string $message): void
    {
        $spinner->finish();
        $this->newLine();
        $this->error($message);
    }
}
