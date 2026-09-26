import type { Position, SnapCandidate } from '@/lib/routeEditing';

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
    name: string | null;
    votes: number;
    samples: number;
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
        name: typeof response.name === 'string' ? response.name : null,
        votes: isFiniteNumber(response.votes) ? response.votes : 0,
        samples: isFiniteNumber(response.samples) ? response.samples : 0,
    };
}
