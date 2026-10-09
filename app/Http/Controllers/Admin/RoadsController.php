<?php

namespace App\Http\Controllers\Admin;

use App\Geo\GreatCircle;
use App\Geo\Router;
use App\Http\Controllers\Controller;
use App\Http\Requests\Road\ContinueRoadRequest;
use App\Http\Requests\Road\RelayRoadRequest;
use App\Http\Requests\Road\RouteRoadRequest;
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

        // Link roads are excluded at every scan of the table — in `matched`
        // and in `near` below, not only at the winner. A ramp beside an
        // intersection would otherwise take both the per-point vote and the
        // reference on distance alone, and the votes would never get to agree
        // otherwise. The table was imported without them until the routing
        // graph needed them (roads:import-overpass), so the exclusion lives
        // here rather than at the import: same rows, different consumers.
        //
        // The backslash is Postgres LIKE's own escape for the underscore (a
        // wildcard); the `\\` and `\'` sit in the PHP source so the statement
        // the driver sees carries the real characters.
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
                      AND r.highway NOT LIKE \'%\\_link\'
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
                  AND r.highway NOT LIKE \'%\\_link\'
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
            SELECT w.road_id,
                   w.name,
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
            /**
             * The road's own identity, and the one field this answer was missing
             * for the longest.
             *
             * A drop did not need it: the position and the distance decide
             * everything it did, and the centreline arrived with the answer so no
             * second request was needed. Laying a *selection* along the street
             * does need it, because when that street runs out at a corner the
             * editor has to ask what continues — and a lookup that cannot name
             * the street it just answered with cannot exclude it from the
             * candidates, so the continuation returns the street the route is
             * already on and the walk never leaves the block.
             */
            'road_id' => (int) $street->road_id,
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
                  AND r.highway NOT LIKE \'%\\_link\'
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

    /**
     * The street that continues past the end of another one.
     *
     * The third question the road lookups answer, and the only one that cannot be
     * answered exactly, which is worth saying before the SQL: there is no graph in
     * this table. A row is one OSM way with its geometry, a name and a highway
     * tag, and nothing anywhere records which node a way starts or ends at. So
     * "what continues from here" is not a lookup, it is a guess, and the honest
     * thing is to make the guess as narrow as it can be and to say what it assumes.
     *
     * The guess: where would you be if you kept going? The caller sends the compass
     * direction it was travelling — because it is the only party that knows, a
     * route runs against a way's own node order about half the time, and the two
     * senses of a line are separate rows — and the query projects that direction a
     * short distance past the junction and asks which road is nearest to the
     * result.
     *
     * The short distance is the parameter that decides how good the answer is, and
     * `ContinueRoadRequest::PROBE_METERS` says why it is ten: at a corner the
     * street being turned onto passes within a metre of the junction, so a probe
     * ten metres ahead is about ten metres from it while the street just travelled
     * is ten metres behind. Ordering by distance to the probe therefore prefers
     * going straight and falls back to turning.
     *
     * Which is right for a route and wrong for a navigator, and that is the limit
     * worth stating plainly: a route that doubles back on itself, or a junction
     * where three streets leave at similar angles, can produce a street that is
     * not the one a person would have taken. There is nothing in this table that
     * would let the answer be better, so the reviewer looking at the map after the
     * drop is the check — which is also why the walk is allowed to cross only one
     * corner per drop.
     *
     * The road being left is excluded by id, and that exclusion is what makes this
     * endpoint necessary rather than an extra call to `snap()`: a snap answer
     * carries no identity, so a client that asked "what is near here" at a junction
     * would be handed the street it is already on and would walk in a circle.
     *
     * `oneway` is returned but never consulted. A line's two senses are separate
     * rows and neither is a routing constraint here — this lays geometry along a
     * road, it does not plan a journey — so filtering on direction would refuse
     * perfectly good continuations on any one-way street, which is a large part of
     * the network in a city centre.
     */
    public function continue(ContinueRoadRequest $request): JsonResponse
    {
        // The roads table only exists on PostgreSQL, as in snap() and relay().
        if (Schema::getConnection()->getDriverName() !== 'pgsql') {
            return response()->json(null, 404);
        }

        // Bound in the order the placeholders appear in the statement, which is
        // the order the driver matches them: the junction as lng then lat, the probe
        // distance, the bearing it is projected along, then the road to exclude and
        // the radius each side of the junction looks within.
        $bindings = [
            $request->input('lng'),
            $request->input('lat'),
            ContinueRoadRequest::PROBE_METERS,
            $request->bearing(),
            $request->roadId(),
            $request->radius(),
        ];

        $street = DB::selectOne(
            'WITH origin AS (
                SELECT ST_SetSRID(ST_Point(CAST(? AS double precision), CAST(? AS double precision)), 4326) AS p
            ),
            probe AS (
                SELECT ST_Project(o.p::geography, CAST(? AS double precision), radians(CAST(? AS double precision)))::geometry AS p
                FROM origin o
            ),
            candidates AS (
                SELECT r.id AS road_id, r.name, r.highway, r.oneway, r.geom,
                       ST_Distance(r.geom::geography, o.p::geography) AS near_d,
                       ST_Distance(r.geom::geography, pr.p::geography) AS ahead_d
                FROM roads r
                CROSS JOIN origin o
                CROSS JOIN probe pr
                WHERE r.id <> CAST(? AS integer)
                  AND ST_DWithin(r.geom::geography, o.p::geography, ?)
                  AND r.highway NOT LIKE \'%\\_link\'
            )
            SELECT c.road_id, c.name, c.highway, c.oneway, c.near_d, c.ahead_d,
                   ST_Y(ST_ClosestPoint(c.geom, (SELECT p FROM origin))) AS lat,
                   ST_X(ST_ClosestPoint(c.geom, (SELECT p FROM origin))) AS lng,
                   ST_AsGeoJSON(c.geom) AS geometry
            FROM candidates c
            ORDER BY c.ahead_d ASC, c.near_d ASC, c.name ASC NULLS LAST, c.road_id ASC
            LIMIT 1',
            $bindings,
        );

        // 204 rather than an empty body, matching snap(): nothing continues here,
        // which is a normal answer and not a failure.
        if ($street === null) {
            return response()->json(null, 204);
        }

        return response()->json([
            'road_id' => (int) $street->road_id,
            'name' => $street->name,
            'highway' => $street->highway,
            /**
             * The raw OSM token, exactly as on the other two lookups. See snap()
             * for why casting it to a bool would report every road as one-way.
             */
            'oneway' => $street->oneway,
            'distance_m' => (float) $street->near_d,
            /**
             * Where the walk enters the new street: the point on it nearest to the
             * junction, which is the shared node. Sent as an explicit entry rather
             * than left for the client to derive, because deriving it means
             * projecting onto a geometry that can hold several parts with real gaps
             * between them and guessing which part a chainage refers to.
             */
            'lat' => (float) $street->lat,
            'lng' => (float) $street->lng,
            'geometry' => json_decode($street->geometry, true),
        ]);
    }

    /**
     * The path the network legally offers between two control points.
     *
     * The fourth lookup, and the one that starts where continue()'s comments
     * stop short: that one guesses what street comes next because "there is
     * no graph in this table". There is now — road_nodes and road_edges,
     * rebuilt by roads:build-graph — and App\Geo\Router searches it edge by
     * edge. Here is the other half: which slice of the network the question
     * needs, where the two control points land on it, and what the editor's
     * caller does with the answer.
     *
     * The corridor only carries edges whose two endpoints sit inside the
     * origin-destination box, padded by a quarter of the distance plus a
     * floor. The full graph is ~175k edges and a tramo is a few kilometres,
     * so loading the city whole per request would pay for streets the answer
     * cannot cross; the same box the padded query asks the (lat, lng) index
     * for is a few thousand instead. The floor exists because a route may
     * leave the straight line without leaving the sensible answer — a detour
     * around a one-way block is precisely the legal path a bare box would
     * cut in half.
     *
     * The refusal shape is richer than snap()'s 204 on purpose. A tramo the
     * router cannot draw has to say why: a control point nowhere near a
     * street is fixed by moving it, an impossible pairing is fixed by adding
     * a control point, and a client that cannot tell the two apart would ask
     * for the correction nobody needed.
     */
    public function route(RouteRoadRequest $request): JsonResponse
    {
        // The graph is driver-agnostic (plain columns), so there is no driver
        // gate here — unlike the three lookups above. What is checked instead
        // is that it exists at all: an empty road_edges is "no resource built
        // yet", which is a missing-route answer, not a 500.
        if (DB::selectOne('SELECT 1 AS one FROM road_edges LIMIT 1') === null) {
            return response()->json(null, 404);
        }

        $origin = $request->origin();
        $destination = $request->destination();
        $bearing = $request->bearing();
        $radius = $request->radius();

        $distance = GreatCircle::metersBetween(
            [$origin['lng'], $origin['lat']],
            [$destination['lng'], $destination['lat']],
        );

        $pad = max(300.0, $distance * 0.25);
        $midLat = ($origin['lat'] + $destination['lat']) / 2;
        $latPad = $pad / GreatCircle::METRES_PER_DEGREE_LATITUDE;
        $lngPad = $pad / GreatCircle::metresPerDegreeLongitude($midLat);

        $west = min($origin['lng'], $destination['lng']) - $lngPad;
        $east = max($origin['lng'], $destination['lng']) + $lngPad;
        $south = min($origin['lat'], $destination['lat']) - $latPad;
        $north = max($origin['lat'], $destination['lat']) + $latPad;

        $nodes = [];

        foreach (
            DB::table('road_nodes')
                ->whereBetween('lat', [$south, $north])
                ->whereBetween('lng', [$west, $east])
                ->get(['id', 'lat', 'lng']) as $node
        ) {
            $nodes[(int) $node->id] = [(float) $node->lng, (float) $node->lat];
        }

        $edges = [];

        foreach (
            DB::table('road_edges as e')
                ->join('road_nodes as f', fn ($join) => $join
                    ->on('f.id', '=', 'e.from_node_id')
                    ->whereBetween('f.lat', [$south, $north])
                    ->whereBetween('f.lng', [$west, $east]))
                ->join('road_nodes as t', fn ($join) => $join
                    ->on('t.id', '=', 'e.to_node_id')
                    ->whereBetween('t.lat', [$south, $north])
                    ->whereBetween('t.lng', [$west, $east]))
                ->get(['e.from_node_id', 'e.to_node_id', 'e.road_id', 'e.length_m', 'e.forward_ok', 'e.backward_ok']) as $edge
        ) {
            $edges[] = [
                'from' => (int) $edge->from_node_id,
                'to' => (int) $edge->to_node_id,
                'road_id' => (int) $edge->road_id,
                'length_m' => (float) $edge->length_m,
                'forward_ok' => (bool) $edge->forward_ok,
                'backward_ok' => (bool) $edge->backward_ok,
            ];
        }

        $roadIds = array_values(array_unique(array_map(
            fn (array $edge): int => $edge['road_id'],
            $edges,
        )));

        $roads = [];

        if ($roadIds !== []) {
            foreach (
                DB::table('roads')->whereIn('id', $roadIds)->get(['id', 'osm_id', 'name', 'highway']) as $road
            ) {
                $roads[(int) $road->id] = [
                    'osm_id' => (int) $road->osm_id,
                    'name' => $road->name,
                    'highway' => (string) $road->highway,
                ];
            }
        }

        $restrictions = [];

        foreach (
            DB::table('turn_restrictions')
                ->whereBetween('via_lat', [$south, $north])
                ->whereBetween('via_lng', [$west, $east])
                ->get(['from_osm_way', 'to_osm_way', 'via_lat', 'via_lng', 'kind']) as $restriction
        ) {
            $restrictions[] = [
                'from_osm_way' => (int) $restriction->from_osm_way,
                'to_osm_way' => (int) $restriction->to_osm_way,
                'via' => [(float) $restriction->via_lng, (float) $restriction->via_lat],
                'kind' => (string) $restriction->kind,
            ];
        }

        $outgoingBearings = [];

        foreach ($edges as $edge) {
            $from = $nodes[$edge['from']];
            $to = $nodes[$edge['to']];

            if ($edge['forward_ok']) {
                $outgoingBearings[$edge['from']][] = self::compassHeading($from, $to);
            }

            if ($edge['backward_ok']) {
                $outgoingBearings[$edge['to']][] = self::compassHeading($to, $from);
            }
        }

        $originNode = $this->snapNode($nodes, $origin, $radius, $outgoingBearings, $bearing);

        if ($originNode === null) {
            return $this->routeRefusal('origin-too-far');
        }

        $destinationNode = $this->snapNode($nodes, $destination, $radius, [], null);

        if ($destinationNode === null) {
            return $this->routeRefusal('destination-too-far');
        }

        $outcome = (new Router($nodes, $edges, $roads, $restrictions))
            ->route($originNode['id'], $destinationNode['id']);

        if (! $outcome->found()) {
            return $this->routeRefusal((string) $outcome->reason);
        }

        $warnings = [];

        // The editor's normal snap threshold: anything below it is a placement
        // the reviewer cannot tell apart from the exact vertex, so a number
        // here would be noise, not news.
        if ($originNode['distance'] > 25.0) {
            $warnings[] = sprintf('origin-snapped-%dm', (int) round($originNode['distance']));
        }

        if ($destinationNode['distance'] > 25.0) {
            $warnings[] = sprintf('destination-snapped-%dm', (int) round($destinationNode['distance']));
        }

        return response()->json([
            'status' => 'ok',
            'coordinates' => $outcome->coordinates,
            'streets' => $outcome->streets,
            'distance_m' => $outcome->distanceM,
            'warnings' => $warnings,
            'reason' => null,
        ]);
    }

    private function routeRefusal(string $reason): JsonResponse
    {
        return response()->json([
            'status' => 'none',
            'coordinates' => null,
            'streets' => null,
            'distance_m' => null,
            'warnings' => [],
            'reason' => $reason,
        ]);
    }

    /**
     * The node a control point lands on.
     *
     * The bearing is what picks the carriageway. On a divided road the wrong
     * half is metres closer and completely wrong, so distance alone is the
     * question that has a different answer from the right one — and each
     * degree of disagreement costs a metre of equivalent distance, which for
     * a 180-degree mistake means the wrong half loses even when it is fifteen
     * metres nearer. No heading to argue with (a destination end has none),
     * the plain nearest node wins.
     *
     * @param  array<int, array{0: float, 1: float}>  $nodes  nodeId => [lng, lat]
     * @param  array{lat: float, lng: float}  $point
     * @param  array<int, list<float>>  $outgoingBearings  nodeId => compass headings of legs leaving it
     * @return array{id: int, distance: float}|null
     */
    private function snapNode(
        array $nodes,
        array $point,
        float $radius,
        array $outgoingBearings,
        ?float $bearing,
    ): ?array {
        $bestId = null;
        $bestScore = INF;
        $bestDistance = 0.0;

        foreach ($nodes as $id => $position) {
            $distance = GreatCircle::metersBetween([$point['lng'], $point['lat']], $position);

            if ($distance > $radius) {
                continue;
            }

            $score = $distance;

            if ($bearing !== null) {
                $disagreement = 180.0;

                foreach ($outgoingBearings[$id] ?? [] as $heading) {
                    $disagreement = min($disagreement, self::headingDiff($heading, $bearing));
                }

                $score += $disagreement;
            }

            if ($score < $bestScore) {
                $bestScore = $score;
                $bestId = $id;
                $bestDistance = $distance;
            }
        }

        return $bestId === null ? null : ['id' => $bestId, 'distance' => $bestDistance];
    }

    /**
     * The angle between two compass headings, folded to [0, 180].
     *
     * @param  array{0: float, 1: float}  $from
     * @param  array{0: float, 1: float}  $to
     */
    private static function compassHeading(array $from, array $to): float
    {
        $east = ($to[0] - $from[0]) * cos(deg2rad($from[1]));
        $north = $to[1] - $from[1];

        return fmod(atan2($east, $north) * 180.0 / M_PI + 360.0, 360.0);
    }

    private static function headingDiff(float $one, float $other): float
    {
        $delta = abs($one - $other);

        return $delta > 180.0 ? 360.0 - $delta : $delta;
    }
}
