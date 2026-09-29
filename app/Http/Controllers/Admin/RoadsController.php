<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Road\RelayRoadRequest;
use App\Http\Requests\Road\SnapRoadRequest;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use stdClass;

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
     * The chosen street's own coordinates come back as well, which is what lets
     * the editor go past the dropped vertex: a one-vertex drag that snaps pulls
     * the neighbouring vertices onto the same street instead of leaving them on
     * the one the vertex was moved off. One row is one OSM way and a way ends
     * at a node, so this reaches as far as the way does and no further — a named
     * street is many ways ("Avenida 16 de Julio" is 38 of them), and joining
     * them up would need node identity this table does not store plus a heading
     * test at every crossing, where four ways meet within a metre. Stopping at
     * the boundary is the honest limit: it fixes the kink within a block, which
     * is the case a reviewer actually hit.
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
                   w.ref_d AS distance_m,
                   ST_AsGeoJSON(w.geom) AS geometry
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
            /**
             * The whole chosen street, so the editor can pull the route's
             * neighbouring vertices onto it.
             *
             * Sent as a decoded array rather than a string so the client reads
             * the same shape it would get from a `.json()` body, and left for
             * the client to validate: a response it cannot trust must be a
             * snap that is not offered, not a parse error on a field the
             * reviewer never sees.
             *
             * The size of this is why no second request is needed. A way in
             * this table averages six points and the largest has 332, so the
             * street travels with the answer it came with rather than costing a
             * round trip of its own.
             */
            'geometry' => json_decode($street->geometry, true),
        ]);
    }

    /**
     * The street each point of a selected stretch belongs to.
     *
     * A different question from `snap()`, and a different shape of answer for a
     * reason that is not about size: a drop sends one point as *the* reference
     * and the rest only to break a tie, so past a handful of them nothing
     * changes and the client is right to stop asking. Here every point is its
     * own reference and every point's answer is wanted, so the reply is one row
     * per point rather than one row for the drop.
     *
     * That is also what makes it answer the question a reviewer is really asking
     * when they box a stretch of route and ask for it to be straightened. They
     * are not pointing at one vertex, so nothing may be chosen on the strength
     * of one vertex. Each point finds its own street, which is what lets a
     * selection that turns a corner come out right: the point before the corner
     * belongs to the street it came along, the point after belongs to the street
     * it turned onto, and neither has to be wrong for the pair to be correct.
     *
     * The three stages, and why each is here:
     *
     * `nearest` is one KNN index scan per point, which is what makes a hundred
     * of them affordable, and its only job is to say what each point would pick
     * if it had to pick on distance alone.
     *
     * `local_votes` counts, for each point and each street that point is a
     * candidate for, how many of its *neighbours* have that same street as their
     * own nearest. Neighbours rather than the whole selection, and that is the
     * decision the whole query turns on. A route with forty points on one street
     * and forty on the street behind it ties exactly on a global count, and a tie
     * broken by distance is a coin flip wherever the route runs between two
     * streets — which is exactly what a divided road, or a street and the service
     * lane beside it, looks like. A point one metre from the lane and three from
     * the road belongs to the road, because that is where its neighbours are.
     *
     * The counting is keyed on the *candidates*, not on each point's own nearest,
     * and getting that backwards is silent and total: a street a point does not
     * pick is precisely the one whose vote matters, so keying on the point's own
     * nearest leaves every contested street with zero votes and the query falls
     * back to distance, which is the coin flip this stage exists to remove. The
     * LEFT JOIN is load-bearing for the same reason — a street no neighbour
     * recognises is a count of zero, not a row to be dropped.
     *
     * A point does not vote for itself: its own distance already decides, as the
     * final ordering term, and letting it vote would just add one to whatever it
     * already agreed with.
     *
     * `ranked` then cuts each point's candidates down to the tie band and picks
     * the best-supported of what survives. The band is a window function rather
     * than a correlated `min` because a correlated subquery re-reads the whole
     * candidate set once per row: fine at seven candidates, quadratic at four
     * hundred, and the sort it replaces costs nothing.
     *
     * A point with no street inside the threshold gets no row at all. That is
     * the honest answer — the reviewer's point is somewhere the imported network
     * does not reach — and it is why the client leaves that vertex alone rather
     * than inventing a position for it. Thirty-six vertices across nine codes are
     * in exactly that situation, so it is a real case and not a hypothetical.
     */
    public function relay(RelayRoadRequest $request): JsonResponse
    {
        // The roads table only exists on PostgreSQL, as in snap().
        if (Schema::getConnection()->getDriverName() !== 'pgsql') {
            return response()->json(null, 404);
        }

        $points = $request->points();

        // The sample goes in as a VALUES list for the reason it does on a drop:
        // one round trip, one plan, and every value cast because the driver hands
        // PostgreSQL text and the spatial functions swallow strings happily.
        $rows = [];
        $bindings = [];

        foreach ($points as $index => [$lat, $lng]) {
            $rows[] = '(CAST(? AS integer), ST_SetSRID(ST_Point(CAST(? AS double precision), CAST(? AS double precision)), 4326))';
            $bindings[] = $index;
            $bindings[] = $lng;
            $bindings[] = $lat;
        }

        // Bound in the order the placeholders appear: the sample, then the radius
        // each point votes with, the threshold each point is held to, and the
        // band those two are reconciled within.
        $bindings[] = $request->radius();
        $bindings[] = $request->threshold();
        $bindings[] = RelayRoadRequest::TIE_BAND_METERS;

        $streets = DB::select(
            'WITH targets(idx, p) AS (VALUES '.implode(', ', $rows).'),
            nearest AS (
                SELECT t.idx, m.road_id
                FROM targets t
                CROSS JOIN LATERAL (
                    SELECT r.id AS road_id
                    FROM roads r
                    WHERE ST_DWithin(r.geom::geography, t.p::geography, ?)
                    ORDER BY r.geom::geography <-> t.p::geography
                    LIMIT 1
                ) m
            ),
            candidates AS (
                SELECT t.idx, r.id AS road_id, r.name, r.highway, r.oneway, r.geom,
                       ST_Distance(r.geom::geography, t.p::geography) AS d
                FROM targets t
                CROSS JOIN roads r
                WHERE ST_DWithin(r.geom::geography, t.p::geography, ?)
            ),
            local_votes AS (
                SELECT c.idx, c.road_id, count(n.idx) AS votes
                FROM candidates c
                LEFT JOIN nearest n ON n.road_id = c.road_id AND n.idx <> c.idx
                GROUP BY c.idx, c.road_id
            ),
            banded AS (
                SELECT c.*
                FROM (
                    SELECT c.*, min(c.d) OVER (PARTITION BY c.idx) AS closest
                    FROM candidates c
                ) c
                WHERE c.d <= c.closest + ?
            ),
            scored AS (
                SELECT b.idx, b.road_id, b.name, b.highway, b.oneway, b.geom, b.d,
                       COALESCE(v.votes, 0) AS votes
                FROM banded b
                LEFT JOIN local_votes v ON v.idx = b.idx AND v.road_id = b.road_id
            )
            SELECT DISTINCT ON (s.idx)
                   s.idx, s.road_id, s.name, s.highway, s.oneway, s.votes, s.d,
                   ST_AsGeoJSON(s.geom) AS geometry
            FROM scored s
            ORDER BY s.idx, s.votes DESC, s.d ASC',
            $bindings,
        );

        // Typed as stdClass rather than the general object, because that is what
        // a DB::select row actually is and it is the only reason reading these
        // properties is safe to say anything about at all.
        return response()->json(array_map(
            fn (stdClass $street): array => [
                'index' => (int) $street->idx,
                'road_id' => (int) $street->road_id,
                'name' => $street->name,
                'highway' => $street->highway,
                'oneway' => $street->oneway,
                'votes' => (int) $street->votes,
                'distance_m' => (float) $street->d,
                'geometry' => json_decode($street->geometry, true),
            ],
            $streets,
        ));
    }
}
