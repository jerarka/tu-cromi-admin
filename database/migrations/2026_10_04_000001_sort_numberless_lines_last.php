<?php

use App\Models\Line;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Give a line with no number somewhere to sort after the numbered ones.
 *
 * Not every bus carries a number: a service identified only by the route name
 * painted on its side ("la guardia - nueva terminal") has no numeric prefix to
 * derive. Until now code_number had nowhere to record that and defaulted to 0,
 * which is a real line number — so a route genuinely called "0" and a route with
 * no number shared a sort key, and there was no way to push the numberless ones
 * to the end without a NULL.
 *
 * NULL was rejected deliberately. This project runs PostgreSQL and SQLite, and
 * they disagree: NULLs sort last on one and first on the other, so the same data
 * would produce two different index orders. Worse, the neighbour lookup compares
 * whole rows, and a row value containing a NULL compares to NULL — neither
 * greater nor less — which would silently drop every candidate on the far side
 * of the boundary and break prev/next exactly there.
 *
 * Instead code_number stores the largest integer the column can hold, which no
 * real number reaches. Plain ascending code_number then puts numberless routes
 * last on both drivers, keeps lines_sort_index serving this sort, and leaves the
 * comparison an ordinary three-column row value.
 *
 * Two changes, both no-ops on a database whose codes all start with digits:
 * the default moves from 0 to the sentinel, and any row already sitting on the
 * old default with a numberless code is corrected.
 *
 * The sentinel is written out as a literal rather than read from
 * Line::SORT_LAST on purpose. A migration is a frozen record of what ran when;
 * pointing it at a constant means editing the model later would change what this
 * file does to a database that has not been migrated yet.
 */
return new class extends Migration
{
    /** Must equal Line::SORT_LAST. */
    private const SORT_LAST = 2147483647;

    public function up(): void
    {
        Schema::table('lines', function (Blueprint $table) {
            $table->unsignedInteger('code_number')->default(self::SORT_LAST)->change();
        });

        // Only rows the old default mislabelled: a code with no numeric prefix
        // sitting on 0. Read in PHP rather than with a SQL pattern because
        // regular expressions are not portable to SQLite, which the test suite
        // migrates, and because Line already owns the definition of "this code
        // has a number" — a second copy of that pattern here would be free to
        // drift away from it.
        $mislabelled = DB::table('lines')
            ->where('code_number', 0)
            ->get(['id', 'code']);

        foreach ($mislabelled as $row) {
            if (Line::numberFromCode((string) $row->code) !== null) {
                // A code that legitimately reads "0" is left alone: for that
                // row, 0 is the truth and not the old default.
                continue;
            }

            DB::table('lines')
                ->where('id', $row->id)
                ->update(['code_number' => self::SORT_LAST]);
        }
    }

    public function down(): void
    {
        // Numberless rows are left holding the sentinel: there is no number to
        // restore, and 0 would make them indistinguishable from a route
        // legitimately called "0".
        Schema::table('lines', function (Blueprint $table) {
            $table->unsignedInteger('code_number')->default(0)->change();
        });
    }
};
