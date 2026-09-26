<?php

namespace App\Console\Commands;

use App\Models\Line;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Populate the derived code_number sort key.
 *
 * Run once after the add_sort_columns_to_lines_table migration on any database
 * that already holds line rows. Until it runs, every row has code_number = 0,
 * which makes the natural ordering collapse.
 *
 * New rows do not need this command: Line::create() derives the column through
 * the model mutator, and LinesImport sets it explicitly because its bulk
 * insert bypasses Eloquent.
 */
class LinesBackfillSortKeys extends Command
{
    protected $signature = 'lines:backfill-sort-keys
        {--dry-run : Report what would change without writing}';

    protected $description = 'Derive code_number from existing line codes';

    public function handle(): int
    {
        $rows = DB::table('lines')
            ->select(['id', 'code', 'code_number'])
            ->orderBy('id')
            ->get();

        $updates = [];

        foreach ($rows as $row) {
            $number = Line::numberFromCode((string) $row->code);

            if ((int) $row->code_number === $number) {
                continue;
            }

            $updates[] = [
                'id' => $row->id,
                'code_number' => $number,
            ];
        }

        if ($updates === []) {
            $this->info("Sort keys already up to date across {$rows->count()} lines.");

            return self::SUCCESS;
        }

        if ($this->option('dry-run')) {
            $this->info("Dry run: {$rows->count()} lines scanned, ".count($updates).' would be updated.');

            return self::SUCCESS;
        }

        // Plain per-row updates rather than upsert(). An upsert issues an
        // INSERT that omits `code` and `sense`, both NOT NULL without
        // defaults, and PostgreSQL rejects that before ON CONFLICT can
        // short-circuit. Going through DB::table() also leaves updated_at
        // alone, since these are derived columns and the lines are unchanged.
        DB::transaction(function () use ($updates): void {
            foreach ($updates as $update) {
                DB::table('lines')
                    ->where('id', $update['id'])
                    ->update(['code_number' => $update['code_number']]);
            }
        });

        $this->info('Updated sort keys for '.count($updates)." of {$rows->count()} lines.");

        return self::SUCCESS;
    }
}
