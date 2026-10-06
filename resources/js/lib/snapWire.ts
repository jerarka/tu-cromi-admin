import type {
    Coordinates,
    Position,
    SnapCandidate,
    StreetContinuation,
    StreetLookup,
} from '@/lib/routeEditing';

/**
 * The two conversions between the module's coordinate convention and the
 * street lookup's wire format.
 *
 * Both directions, and both in one place, because they are the only points
 * where `[lng, lat]` and `lat`/`lng` meet. Everything else in the editor speaks
 * `[lng, lat]`; the endpoint speaks the other order, because that is what the
 * rest of the HTTP world uses. Transposing either one mirrors every snapped
 * vertex about the antimeridian, the map draws it without complaint, and Save
 * writes it down — so a swap here is silent, permanent data corruption rather
 * than a visible failure.
 *
 * The inbound direction also validates, because the alternative is a response
 * missing a field turning into `[undefined, undefined]`, which then travels
 * through the arithmetic and lands in the saved route as NaN.
 */

/** What `POST /roads/snap` sends and receives. */
export interface SnapWireResponse {
    /**
     * The chosen street's identity.
     *
     * Read leniently into a nullable field rather than required, because a
     * response without it is still a complete snap: the position and the distance
     * decide the drop on their own. What it costs is the one thing a snap cannot
     * do — hand the street to a continuation lookup at a corner, which has to
     * exclude the street the route is already on and cannot do that without an id
     * to compare.
     */
    road_id: number;
    lat: number;
    lng: number;
    name: string | null;
    highway: string | null;
    /**
     * The raw OSM direction token — 'no', 'forward' or 'backward' — not a
     * boolean. The last two are both one-way in opposite directions, and a
     * two-way street is the string 'no', which is truthy: any cast to bool
     * reports every road as one-way.
     */
    oneway: string | null;
    distance_m: number;
    votes: number;
    samples: number;
    /**
     * The chosen street's own coordinates, as GeoJSON geometry.
     *
     * Untyped on the wire interface on purpose: it is the one field whose shape
     * the server is free to vary (a MultiLineString, and in principle a
     * LineString), so it is validated into the module's own `Coordinates` on the
     * way in rather than trusted here.
     */
    geometry: unknown;
}

/**
 * Positions as the wire wants them: `lat`/`lng` objects rather than arrays.
 *
 * Named for what it does rather than for its direction, so that a change of
 * convention has one place to be wrong in.
 */
export function toWirePoints(points: Position[]): SnapWirePoint[] {
    return points.map((position) => ({
        lat: position[1],
        lng: position[0],
    }));
}

export interface SnapWirePoint {
    lat: number;
    lng: number;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A validated lookup: the decision-relevant candidate, plus how much of the
 * moved selection is on the chosen street.
 *
 * The count is kept beside the candidate rather than inside it because it does
 * not take part in the decision. It is a report for the reviewer, and folding
 * it into SnapCandidate would have put a field on the type that the snap logic
 * is tempted — and once did — to weigh.
 */
export interface SnapLookup {
    candidate: SnapCandidate;
    /**
     * Which street was chosen, or null when the answer did not say.
     *
     * Carried beside the centreline rather than inside it, because the two answer
     * different questions: the geometry is what the route is laid onto, and this
     * is what the editor needs to name when it runs out of it. Nullable for the
     * reason on the wire field — nothing about the drop depends on it.
     */
    roadId: number | null;
    name: string | null;
    votes: number;
    samples: number;
    /**
     * The chosen street's centreline, or null when the response did not carry a
     * usable one.
     *
     * Null rather than an empty array because the two mean different things: an
     * absent street means the drop is a perfectly good snap with no propagation
     * offered, while an empty one would be a geometry with nothing in it to walk
     * along. Keeping them apart lets the caller say which happened.
     */
    line: Coordinates | null;
}

/**
 * The chosen street's coordinates, validated into the module's own order.
 *
 * GeoJSON is `[lng, lat]`, which is also this module's convention, so on paper
 * this is an identity function. That coincidence is the whole risk: the two
 * orders meeting here is the one place a transposition would mirror the street
 * about the antimeridian, and unlike a lat/lng swap in the request body there
 * is no nearby field to look wrong against — the snapped position above is
 * already in module order, so a swapped street would be a correct snap beside
 * a mirrored continuation of it. Hence the shape is rebuilt from scratch rather
 * than cast, and the order is asserted in a test.
 *
 * Strictly a MultiLineString, because that is the only thing the `roads.geom`
 * column can hold. A response in any other shape yields null, which costs the
 * propagation and nothing else — the failure direction matters more here than
 * the convenience of accepting a shape the database cannot produce.
 *
 * A part with fewer than two positions is dropped rather than rejected: a single
 * point is not a stretch of road, and it contributes no length to walk along, so
 * keeping it would only give the walk a degenerate case to guard against. If
 * nothing usable survives, the result is null.
 */
export function snapLineFromGeometry(value: unknown): Coordinates | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }

    const { type, coordinates } = value as {
        type?: unknown;
        coordinates?: unknown;
    };

    if (type !== 'MultiLineString' || !Array.isArray(coordinates)) {
        return null;
    }

    const parts: Coordinates = [];

    for (const part of coordinates) {
        if (!Array.isArray(part) || part.length < 2) {
            continue;
        }

        const positions: Position[] = [];

        for (const position of part) {
            if (!Array.isArray(position) || position.length < 2) {
                continue;
            }

            const [lng, lat] = position as unknown[];

            // NaN is rejected with the rest. It is a number that arrives by
            // arithmetic upstream, and everything downstream would carry it into
            // a saved route without a word.
            if (!isFiniteNumber(lng) || !isFiniteNumber(lat)) {
                continue;
            }

            positions.push([lng, lat]);
        }

        if (positions.length >= 2) {
            parts.push(positions);
        }
    }

    return parts.length > 0 ? parts : null;
}

/**
 * A street from a lookup response, or null if the response is not one.
 *
 * Returning null rather than a candidate with holes in it means a malformed
 * response cannot reach the offset arithmetic: there is nothing to compute a
 * delta from, so the drop simply stays where it was released.
 *
 * The counts are read leniently — a missing vote count is a missing
 * confirmation, not a broken answer — but the position and the distance are
 * required, because without them there is no snap to apply. NaN is rejected
 * alongside the non-numbers, since it is a number that arrives by arithmetic
 * and would otherwise sail through.
 */
export function snapLookupFromResponse(data: unknown): SnapLookup | null {
    if (typeof data !== 'object' || data === null) {
        return null;
    }

    const response = data as Partial<SnapWireResponse>;
    const { lat, lng } = response;
    const distance = response.distance_m;

    if (
        !isFiniteNumber(lat) ||
        !isFiniteNumber(lng) ||
        !isFiniteNumber(distance)
    ) {
        return null;
    }

    return {
        // Back to the module's own order. This is the line that would mirror
        // every vertex in the route if the two fields were ever swapped.
        candidate: { position: [lng, lat], distance },
        roadId: isFiniteNumber(response.road_id) ? response.road_id : null,
        name: typeof response.name === 'string' ? response.name : null,
        votes: isFiniteNumber(response.votes) ? response.votes : 0,
        samples: isFiniteNumber(response.samples) ? response.samples : 0,
        // A missing or unusable street leaves the drop a normal snap. The
        // position above has already been decided by this point, so a caller
        // that finds no line has lost a refinement, not an edit.
        line: snapLineFromGeometry(response.geometry),
    };
}

/**
 * One row of `POST /roads/relay`: the street a single point belongs to.
 *
 * A list rather than a single winner, because every point in a re-lay is its own
 * reference. A drop answers "which street is this drop on" and the other points
 * it is sent only vote; this one answers a question per point, and a selection
 * that turns a corner is only correct if each point is allowed its own answer.
 */
export interface RelayWireStreet {
    /** Position of the point within the selection. The only link back to a vertex. */
    index: number;
    road_id: number;
    name: string | null;
    highway: string | null;
    /** The raw OSM token, as on a drop. Never a boolean; 'no' is truthy. */
    oneway: string | null;
    votes: number;
    distance_m: number;
    geometry: unknown;
}

/**
 * A street one point belongs to, validated into the module's own order.
 *
 * The reply, as one entry per point, in the order the points were sent.
 *
 * Order is the contract and it is the whole contract: entry 7 is the seventh
 * point the caller asked about, and the route is re-laid in that order so a
 * corner can be told from a straight run. A point the server found no street for
 * is simply absent, which is how a caller tells "no street nearby" from "a street
 * to use" without reading a flag — and the absence is meaningful rather than a
 * gap to be filled.
 */
export function relayLookupsFromResponse(data: unknown): StreetLookup[] {
    if (!Array.isArray(data)) {
        return [];
    }

    const found: StreetLookup[] = [];

    for (const row of data) {
        if (typeof row !== 'object' || row === null) {
            continue;
        }

        const response = row as Partial<RelayWireStreet>;
        const index = response.index;
        const distance = response.distance_m;

        // Index, road and distance are required: without the first there is no
        // vertex to answer for, and without the other two there is nothing to
        // move. The name is not required, and that is deliberate rather than an
        // oversight � nineteen thousand of the roads in this network have no
        // name, and refusing to move a route onto an unnamed street would leave
        // most of the city unusable.
        if (
            !isFiniteNumber(index) ||
            !isFiniteNumber(response.road_id) ||
            !isFiniteNumber(distance)
        ) {
            continue;
        }

        found.push({
            roadId: response.road_id,
            name: typeof response.name === 'string' ? response.name : null,
            votes: isFiniteNumber(response.votes) ? response.votes : 0,
            distance,
            // The same validation a drop's street gets, for the same reason: this
            // is where a transposed GeoJSON puts a route's vertices, and unlike a
            // bad snap there is no correct answer sitting beside it to notice.
            line: snapLineFromGeometry(response.geometry),
        });
    }

    return found;
}

/** What `POST /roads/continue` receives. */
export interface ContinueWireResponse {
    road_id: number;
    name: string | null;
    highway: string | null;
    /** The raw OSM token, as on a drop. Never a boolean; 'no' is truthy. */
    oneway: string | null;
    distance_m: number;
    lat: number;
    lng: number;
    geometry: unknown;
}

/**
 * A validated answer about the street that continues past another one.
 *
 * Road, position and geometry are all required here, which is stricter than a
 * drop's answer and for a different reason. A drop can lose its street and still
 * be a complete snap, because the position and the distance already decided the
 * edit. A continuation has nothing else to offer: with no road there is no
 * exclusion, and with no entry point the walk would be told to carry on at a place
 * on the geometry that it cannot locate — so the whole answer is refused.
 *
 * The entry point is read in the module's order like every other position here,
 * and it is the field this whole endpoint exists to deliver. Getting it backwards
 * puts the walk's continuation at the wrong end of the street, which is a correct
 * street and a route that jumps to the wrong place.
 */
export function continuationFromResponse(
    data: unknown,
): StreetContinuation | null {
    if (typeof data !== 'object' || data === null) {
        return null;
    }

    const response = data as Partial<ContinueWireResponse>;

    if (
        !isFiniteNumber(response.road_id) ||
        !isFiniteNumber(response.lat) ||
        !isFiniteNumber(response.lng)
    ) {
        return null;
    }

    const line = snapLineFromGeometry(response.geometry);

    // A response with no usable centreline is not a continuation. Handing one back
    // with a null line would cost the caller a walk that starts from a position it
    // cannot follow, and the walk already treats a missing line as "no crossing".
    if (line === null) {
        return null;
    }

    return {
        roadId: response.road_id,
        name: typeof response.name === 'string' ? response.name : null,
        line,
        entry: [response.lng, response.lat],
    };
}
