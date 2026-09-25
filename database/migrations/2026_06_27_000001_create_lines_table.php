<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Whether the connected driver supports PostGIS.
     *
     * The geom column, the GIST indexes, the sense CHECK constraint and the
     * ST_GeomFromGeoJSON backfill are all PostgreSQL-only. The test suite runs
     * on SQLite (:memory:), so those statements are skipped there and the
     * table is created without the spatial column. The resulting PostgreSQL
     * schema is identical to the original; only the SQLite shape differs, and
     * it is intentionally looser (no geom, no CHECK on sense).
     */
    private function isPostgres(): bool
    {
        return Schema::getConnection()->getDriverName() === 'pgsql';
    }

    public function up(): void
    {
        $isPostgres = $this->isPostgres();

        if ($isPostgres) {
            DB::statement('CREATE EXTENSION IF NOT EXISTS postgis');
        }

        Schema::create('lines', function (Blueprint $table) use ($isPostgres) {
            $table->id();
            $table->string('code');
            $table->string('name')->nullable();
            $table->string('color')->nullable();
            $table->jsonb('geo_json')->nullable();
            $table->string('sense', 20)->default('OUTBOUND');
            $table->foreignId('parent_line_id')->nullable()->constrained('lines')->nullOnDelete();
            $table->string('syndicate')->nullable();
            $table->integer('objectid')->nullable();
            $table->decimal('average_rating', 3, 2)->nullable();
            $table->integer('total_reviews')->default(0);
            $table->timestamps();

            $table->index('code');
            $table->index('parent_line_id');

            if ($isPostgres) {
                $table->geometry('geom', 'MultiLineString', 4326);
            }
        });

        if ($isPostgres) {
            DB::statement('CREATE INDEX idx_lines_geom ON lines USING GIST(geom)');
            DB::statement('CREATE INDEX IF NOT EXISTS idx_lines_geom_geography ON lines USING GIST (geography(geom))');
            DB::statement("ALTER TABLE lines ADD CONSTRAINT lines_sense_check CHECK (sense IN ('OUTBOUND', 'RETURN'))");
            DB::statement('UPDATE lines SET geom = ST_GeomFromGeoJSON(geo_json::text) WHERE geo_json IS NOT NULL');
        }
    }

    public function down(): void
    {
        if ($this->isPostgres()) {
            DB::statement('DROP INDEX IF EXISTS idx_lines_geom');
            DB::statement('DROP INDEX IF EXISTS idx_lines_geom_geography');
        }

        Schema::dropIfExists('lines');
    }
};
