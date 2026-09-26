<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Road\SnapRoadRequest;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * The street network, as a lookup for the route editor.
 *
 * The table is imported reference data, so this is read-only by design. There
 * is no store, update or destroy: a road nobody edits by hand is what keeps
 * the editor from making a route look correct by moving a road under it.
 */
class RoadsController extends Controller
{
    /**
     * The street a drop belongs to, and where the point that was dropped sits
     * on it.
     *
     * The point the user actually grabbed decides. It is the only one whose
     * distance is measured against the threshold, and the answer is the street
     * closest to it. Everything the caller sends after that first point is
     * consulted for a single purpose: breaking a tie.
     *
     * The tie is a crossing. Dropped near an intersection the reference is
     * nearly equidistant from two streets, and answering with whichever one the
     * database happened to return is how a route ends up on the road beside
     * the one it was aimed at. So streets within a few metres of the closest
     * one are treated as equally close, and the one that more of the moved
     * vertices recognise wins. Votes never exclude anything — an earlier
     * version required a share of them to agree and refused the snap otherwise,
     * which was wrong for routes rather than merely pessimistic: a route goes
     * down one street, turns, and carries on along another, so a selection
     * spread along it agrees about one in seven times and the rule threw away
     * the drop. It is also why a single dragged vertex is the whole request
     * often enough, and the extra points cost nothing but are rarely decisive.
     *
     * The returned position is the reference point projected onto the chosen
     * street, not the street itself, so the caller can move that point onto the
     * centreline and carry the rest of the selection with it. The distance comes
     * back too, because the client decides whether to snap and may hold a
     * tighter threshold than the one sent.
     *
     * A 204 is the "nothing close enough" answer. Overpass road coverage is
     * good but not complete — the import found 36 vertices across 9 codes with
     * no street within 40m — so this case is real and the client has to handle
     * it as normal, not as an error.
     */
    public function snap(SnapRoadRequest $request): JsonResponse
    {
        // The roads table only exists on PostgreSQL, so a non-PostgreSQL
        // database has no resource to look up. Reported as a missing route
        // rather than a server error, matching how the other PostGIS-only
        // paths in the app degrade.
        if (Schema::getConnection()->getDriverName() !== 'pgsql') {
            return response()->json(null, 404);
        }

        $points = $request->points();

        // The sample goes in as a VALUES list so a whole drop is one round trip
        // and one query plan. The placeholders are built from the array
        // position rather than unnest()'d from a JSON array, which keeps the
        // statement fully parameterised and the plan identical for every
        // number of points.
        //
        // Every value is cast rather than left to be inferred. The driver
        // hands PostgreSQL text, so a VALUES list of bare placeholders infers
        // the index column as text and then `idx = 0` fails to resolve — the
        // spatial functions would swallow the strings happily, which is what
        // makes the failure land on the one non-spatial comparison instead of
        // where the cast is actually missing.
        $rows = [];
        $bindings = [];

        foreach ($points as $index => [$lat, $lng]) {
            // ST_Point is built with lng, lat and then given the SRID it is
            // compared against, because it is created with SRID 0 and PostGIS
            // refuses to mix those with the 4326 column.
            $rows[] = '(CAST(? AS integer), ST_SetSRID(ST_Point(CAST(? AS double precision), CAST(? AS double precision)), 4326))';
            $bindings[] = $index;
            $bindings[] = $lng;
            $bindings[] = $lat;
        }

        // Bound in the order the placeholders appear in the statement, which is
        // the order the driver matches them: the sample, then the radius the
        // sampled points look through, the threshold the reference is held to,
        // and the band those two are reconciled within.
        $bindings[] = $request->radius();
        $bindings[] = $request->threshold();
        $bindings[] = SnapRoadRequest::TIE_BAND_METERS;

        $street = DB::selectOne(
            'WITH targets(idx, p) AS (VALUES '.implode(', ', $rows).'),
            ref AS (
                SELECT p FROM targets WHERE idx = 0
            ),
            matched AS (
                SELECT t.idx, r.id AS road_id
                FROM targets t
                CROSS JOIN LATERAL (
                    SELECT r.id, r.geom
                    FROM roads r
                    WHERE ST_DWithin(r.geom::geography, t.p::geography, ?)
                    ORDER BY r.geom::geography <-> t.p::geography
                    LIMIT 1
                ) r
            ),
            votes AS (
                SELECT road_id, count(*) AS votes
                FROM matched
                GROUP BY road_id
            ),
            near AS (
                SELECT r.id AS road_id, r.name, r.highway, r.oneway, r.geom,
                       ST_Distance(r.geom::geography, ref.p::geography) AS ref_d
                FROM roads r
                CROSS JOIN ref
                WHERE ST_DWithin(r.geom::geography, ref.p::geography, ?)
            ),
            closest AS (
                SELECT min(ref_d) AS ref_d FROM near
            ),
            banded AS (
                SELECT n.*
                FROM near n
                CROSS JOIN closest c
                WHERE n.ref_d <= c.ref_d + ?
            ),
            winner AS (
                SELECT b.road_id, b.name, b.highway, b.oneway, b.geom, b.ref_d,
                       COALESCE(v.votes, 0) AS votes
                FROM banded b
                LEFT JOIN votes v ON v.road_id = b.road_id
                ORDER BY COALESCE(v.votes, 0) DESC, b.ref_d ASC
                LIMIT 1
            )
            SELECT w.name,
                   w.highway,
                   w.oneway,
                   w.votes,
                   (SELECT count(*) FROM matched) AS samples,
                   ST_Y(ST_ClosestPoint(w.geom, ref.p)) AS lat,
                   ST_X(ST_ClosestPoint(w.geom, ref.p)) AS lng,
                   w.ref_d AS distance_m
            FROM winner w
            CROSS JOIN ref',
            $bindings,
        );

        if ($street === null) {
            return response()->json(null, 204);
        }

        return response()->json([
            'lat' => (float) $street->lat,
            'lng' => (float) $street->lng,
            'name' => $street->name,
            'highway' => $street->highway,
            'distance_m' => (float) $street->distance_m,
            // The raw OSM token, and deliberately not a boolean. The column
            // holds 'no', 'forward' or 'backward', and the last two are both
            // one-way but in opposite directions: cast to bool they collapse
            // into each other and, worse, a two-way street comes back true
            // because the string 'no' is truthy. On a domain whose whole
            // vocabulary is outbound and return, that distinction is the one
            // thing this field exists to carry.
            'oneway' => $street->oneway,
            // How much of the moved selection is on this street, for the editor
            // to show. It is confirmation, not a decision: the reference point
            // alone decides whether a snap happens.
            'votes' => (int) $street->votes,
            // Only the points that resolved to a street are counted. A point
            // with nothing within the radius expressed no view on which street
            // the drop is on, and counting it would report a stretch as less
            // sure than the data is.
            'samples' => (int) $street->samples,
        ]);
    }
}
