<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * The route's control points — the recipe the guided editor works from.
     *
     * This is editor metadata, deliberately distinct from the geometry it
     * points at: geo_json is and stays the sole source of truth for the
     * drawn route (the offline bundle, the Dart CLI contract and
     * line_transfers all read it), while a control point is an intention the
     * reviewer expressed about HOW the route was made. The tramo between two
     * adjacent waypoints is an editor-side concept; only the endpoints are
     * stored, and the geometry itself never mentions them.
     *
     * Coordinates are plain doubles rather than geography: a waypoint is a
     * number the editor sends back, not something any spatial query runs
     * against, and doubles keep the SQLite suite able to carry the whole
     * persistence flow.
     *
     * role is written by the server, derived from ordinal, and the client's
     * value is never trusted with it: first is start, last is end, everything
     * between is via — the one rule, and it is the same rule the frontend
     * derives markers by (waypointRoleAt), so neither side can drift.
     */
    public function up(): void
    {
        Schema::create('line_waypoints', function (Blueprint $table) {
            $table->id();

            $table->foreignId('line_id')->constrained()->cascadeOnDelete();
            $table->unsignedInteger('ordinal');

            $table->string('role', 8);

            $table->double('lat');
            $table->double('lng');

            $table->timestamps();

            $table->unique(['line_id', 'ordinal']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('line_waypoints');
    }
};
