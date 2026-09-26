<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Drop the now-redundant code_suffix column.
 *
 * code_suffix was added hours ago alongside code_number and proved redundant:
 * within a line number a bare code is a strict prefix of the suffixed ones, so
 * ordering by code_number then code yields an identical row order. That was
 * verified across all 272 lines before removing the column.
 *
 * The add_sort_columns_to_lines_table migration has been amended in place so a
 * fresh install never creates the column. This migration exists only to clean
 * up databases that already ran the earlier version.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasColumn('lines', 'code_suffix')) {
            return;
        }

        Schema::table('lines', function (Blueprint $table) {
            $table->dropColumn('code_suffix');
        });
    }

    public function down(): void
    {
        Schema::table('lines', function (Blueprint $table) {
            $table->string('code_suffix')->default('')->after('code_number');
        });
    }
};
