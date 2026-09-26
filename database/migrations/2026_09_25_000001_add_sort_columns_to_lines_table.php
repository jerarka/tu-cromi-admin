<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Add the derived sort key used to order lines naturally.
 *
 * `code` is a public identifier of the form "<number>[ <suffix>]", e.g. "1",
 * "104 C", "22 rojo". Sorting it as a plain string gives "1", "10", "100",
 * "103", "11" — wrong for riders and operators, who order by the number.
 * code_number holds the numeric prefix as a real integer, so the database
 * compares it numerically and PostgreSQL and SQLite agree.
 *
 * The suffix needs no column of its own. Within one number a bare code is a
 * strict prefix of the suffixed ones ("22" is a prefix of "22 rojo"), and a
 * prefix sorts before the longer string in any sane collation, so ordering by
 * `code` after `code_number` already yields "22", "22 amarillo", "22 rojo".
 * Verified against the full table: sorting with and without a code_suffix
 * column produced an identical row order for all 272 lines.
 *
 * `code` itself is left untouched: it is published verbatim in the offline
 * NDJSON export consumed by the Flutter app.
 *
 * The unique index enforces that a given code has at most one row per
 * direction. LineController::adjacent() depends on that tuple being unique to
 * resolve prev/next deterministically.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('lines', function (Blueprint $table) {
            $table->unsignedInteger('code_number')->default(0)->after('code');

            $table->index(['code_number', 'code', 'sense'], 'lines_sort_index');
            $table->unique(['code', 'sense']);
        });
    }

    public function down(): void
    {
        Schema::table('lines', function (Blueprint $table) {
            $table->dropIndex('lines_sort_index');
            $table->dropUnique(['code', 'sense']);
            $table->dropColumn('code_number');
        });
    }
};
