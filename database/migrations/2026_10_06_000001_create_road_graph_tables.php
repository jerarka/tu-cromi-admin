<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * The derived road graph and the turn restrictions, the two inputs the
     * route router needs and the roads table alone cannot answer.
     *
     * Nothing here is PostGIS: road_nodes and road_edges are plain numbers,
     * which is what makes the router built on them testable in the SQLite
     * suite, and turn_restrictions only stores OSM identities and a coordinate.
     * road_nodes and road_edges are derived data rebuilt wholesale by
     * roads:build-graph, so they carry no timestamps; turn_restrictions is
     * imported reference data upserted by osm id, exactly like roads.
     *
     * turn_restrictions deliberately has no foreign keys. Its from/to columns
     * hold OSM way ids, which may fall outside the imported bbox, so an FK to
     * roads would make the import order a correctness requirement instead of
     * an accident. The router resolves them against roads.osm_id at load time
     * and reports the count it could not resolve.
     */
    public function up(): void
    {
        Schema::create('road_nodes', function (Blueprint $table) {
            $table->id();
            $table->double('lat');
            $table->double('lng');

            $table->index(['lat', 'lng']);
        });

        Schema::create('road_edges', function (Blueprint $table) {
            $table->id();

            $table->foreignId('from_node_id')->constrained('road_nodes')->cascadeOnDelete();
            $table->foreignId('to_node_id')->constrained('road_nodes')->cascadeOnDelete();

            $table->foreignId('road_id')->constrained()->cascadeOnDelete();

            // The one cost the router needs, measured by the app's own
            // GreatCircle so the graph speaks the same metre as everything else.
            $table->double('length_m');

            /**
             * OSM's oneway already resolved into which way along the way's own
             * node order the edge may be traversed: `forward` allows only
             * forward, `backward` (the `-1` tagging) only backward, `no` both.
             */
            $table->boolean('forward_ok');
            $table->boolean('backward_ok');

            $table->index('from_node_id');
            $table->index('to_node_id');
            $table->index('road_id');
        });

        Schema::create('turn_restrictions', function (Blueprint $table) {
            $table->id();

            // The OSM relation id, unique so a re-import upserts.
            $table->bigInteger('osm_id')->unique();

            // The raw OSM token: no_left_turn, only_right_turn, ... The router
            // decides what each kind means; the import only stores what OSM said.
            $table->string('kind', 32);

            $table->bigInteger('from_osm_way')->index();
            $table->bigInteger('to_osm_way')->index();

            // The via node's coordinate. Graph nodes are keyed by coordinate
            // (the ways come from `out geom`, which carries no node ids), so the
            // coordinate is the one join key that exists end to end.
            $table->double('via_lat');
            $table->double('via_lng');

            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('turn_restrictions');
        Schema::dropIfExists('road_edges');
        Schema::dropIfExists('road_nodes');
    }
};
