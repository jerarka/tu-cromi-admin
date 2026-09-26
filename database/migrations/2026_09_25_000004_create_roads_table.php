<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * The street network, imported from OpenStreetMap.
     *
     * This is what the route editor snaps vertices to, and what the oneway
     * audit checks a route's direction against. It is a separate table from
     * lines on purpose: a road is imported reference data that nobody edits by
     * hand, while a line is curated. Keeping them apart means the editor cannot
     * accidentally make a route look correct by moving a road.
     *
     * geom is PostGIS-only, exactly as on lines, so the schema is created
     * without it on other drivers and the SQLite test database still migrates.
     */
    private function isPostgres(): bool
    {
        return Schema::getConnection()->getDriverName() === 'pgsql';
    }

    public function up(): void
    {
        $isPostgres = $this->isPostgres();

        Schema::create('roads', function (Blueprint $table) use ($isPostgres) {
            $table->id();

            // OSM way id. Unique so a re-import upserts rather than duplicating
            // ways that straddle two query tiles.
            $table->bigInteger('osm_id')->unique();

            $table->string('name')->nullable();
            $table->string('highway', 32)->index();

            /**
             * OSM's oneway is not a boolean: `yes` means one-way along the way's
             * own node order, `-1` means one-way against it, and `reversible`
             * means both are permitted. Collapsing that to a bool would lose the
             * direction, which is the only part an audit can use.
             */
            $table->string('oneway', 8)->default('no');

            $table->unsignedInteger('point_count')->default(0);
            $table->timestamps();

            if ($isPostgres) {
                $table->geometry('geom', 'MultiLineString', 4326);
            }
        });

        if ($isPostgres) {
            DB::statement('CREATE INDEX idx_roads_geom ON roads USING GIST (geom)');

            // The snap lookup compares in metres, so it casts to geography. An
            // index on the raw geometry would not be used by that predicate and
            // the query would degrade to a sequential scan.
            DB::statement('CREATE INDEX idx_roads_geom_geography ON roads USING GIST (geography(geom))');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('roads');
    }
};
