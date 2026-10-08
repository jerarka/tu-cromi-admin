import { RELAY_MIN_SPACING_METERS, snapSearchRadius } from '@/lib/routeEditing';
import type {
    LayStreet,
    Position,
    RelayStreetReport,
    SnapOptions,
    StreetContinuation,
    StreetLookup,
} from '@/lib/routeEditing';
import {
    continuationFromResponse,
    relayLookupsFromResponse,
    routeLookupFromResponse,
    snapLookupFromResponse,
    toWirePoints,
} from '@/lib/snapWire';
import type { RouteLookup } from '@/lib/snapWire';
import type { SnapLookup } from '@/lib/snapWire';
import roads from '@/routes/roads';

/**
 * Talking to the street lookup: the request, the answers it can give, and what
 * to say about the one it picks.
 *
 * Out of the map component because none of it is about maps. It reads no Leaflet
 * handle and no component state, which is what makes the part that matters
 * testable at all: whether a given HTTP status produces a snap, a quiet null, or
 * a warning is a decision about the reviewer's route, and until this was
 * separate there was no way to ask the question — the whole thing needed a
 * mounted map to reach.
 *
 * The cookie comes in as an argument rather than being read from `document` here,
 * for the same reason. Reading it here would make the whole module untestable
 * outside a browser, and the caller has the document anyway.
 */

/**
 * How long a street lookup may take before the drop is left unsnapped.
 *
 * The drop is already committed by the time this matters, so a timeout costs
 * only the refinement. What it does not cost is a stuck editor: without a
 * deadline, a request that never settles is indistinguishable from one that is
 * still working.
 */
export const SNAP_LOOKUP_TIMEOUT_MS = 3000;

/**
 * How long a route search may take before the preview is left unmade.
 *
 * Longer than a snap lookup, because this one is a search: the server loads a
 * corridor of the graph and runs A* over it, where a snap is one indexed
 * query. Still a deadline rather than patience — a preview that arrives after
 * the reviewer has moved on to the next click is worse than none, because the
 * map it would decorate is already stale. The revision guard is what catches
 * that case; the deadline is what keeps a stuck request from pinning it open.
 */
export const ROUTE_LOOKUP_TIMEOUT_MS = 8000;

/**
 * The CSRF token from the XSRF-TOKEN cookie.
 *
 * The route editor is the only place in the app that talks to the server
 * outside Inertia, and Inertia attaches the token itself. A plain fetch does
 * not, so without this the road lookup comes back 419 and the snap silently
 * never happens — which is exactly what it looked like.
 */
export function csrfToken(cookie: string): string {
    const prefix = 'XSRF-TOKEN=';
    const match = cookie.split('; ').find((row) => row.startsWith(prefix));

    if (!match) {
        return '';
    }

    return decodeURIComponent(match.slice(prefix.length));
}

/**
 * What to tell the reviewer about a snap.
 *
 * The vote count only speaks when it has something to say. Along a route the
 * moved vertices are mostly on different streets by definition, so a stretch of
 * any length reports something like "1 of 7" — and printing that after a
 * perfectly good snap makes a correct result read as a doubtful one, which is
 * the exact opposite of what a confirmation is for.
 *
 * So it appears only when the moved vertices back the street the snap chose,
 * which is the crossing case: the votes settled something the distances could
 * not, and the reviewer is being told which of the two nearby roads the choice
 * went to and on what grounds. Everything else just gets the street name.
 *
 * `propagated` is counted out loud for the opposite reason: those are vertices
 * the reviewer did not drag and had no other way of learning were moved. A tool
 * that quietly edits three vertices of a route is a tool nobody trusts on a
 * route nobody can check, so the number is always said when it is not zero, and
 * the message names the pull explicitly rather than implying it.
 */
export function describeSnap(found: SnapLookup, propagated = 0): string {
    const street = found.name ?? 'unnamed street';
    const parts: string[] = [];

    if (found.votes >= 2 && found.votes * 2 > found.samples) {
        parts.push(
            `${found.votes} of ${found.samples} moved vertices are on it`,
        );
    }

    if (propagated > 0) {
        parts.push(
            `${propagated} following ${propagated === 1 ? 'vertex' : 'vertices'} pulled along`,
        );
    }

    return parts.length === 0 ? street : `${street} — ${parts.join('; ')}`;
}

/**
 * Ask which street a whole dropped selection belongs to.
 *
 * The first point is the one the user grabbed and the only one whose distance
 * counts; it is sent as the reference and the server holds it to the threshold.
 * The rest are how far the other moved vertices look for a street to vote for,
 * which is what settles a drop made on a crossing. They cannot widen the
 * answer: the threshold the caller sends is the same one this component then
 * applies to the result, so a street the editor would have refused is never
 * proposed.
 *
 * Every failure here is a null, because the drop has already been committed by
 * the time this runs and there is nothing left to do about a street that could
 * not be found. The one that is worth hearing about is a non-2xx status, because
 * that is a broken lookup rather than a gap in the map, and the two look
 * identical from the outside.
 */
export async function lookupSnapStreets(
    points: Position[],
    options: SnapOptions,
    cookie: string,
    /**
     * A deadline shared with the rest of the drop's lookups, when there is more
     * than one.
     *
     * Optional and defaulted so that a drop's first lookup reads as it always did,
     * and passed only by the caller that will go on to ask for a continuation. The
     * reason it exists at all: the timeout is per request, so two chained lookups
     * after a mouseup would leave the reviewer looking at a committed drop for up to
     * twice as long, and the second one is the one that has not started yet when
     * the first has already used the budget.
     */
    signal: AbortSignal = AbortSignal.timeout(SNAP_LOOKUP_TIMEOUT_MS),
): Promise<SnapLookup | null> {
    // No sample means no question worth asking the server. Answering this
    // before the request is what keeps a stale vertex reference from costing a
    // round trip on every drop.
    if (points.length === 0) {
        return null;
    }

    try {
        const response = await fetch(roads.snap.url(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-XSRF-TOKEN': csrfToken(cookie),
            },
            credentials: 'same-origin',
            signal,
            body: JSON.stringify({
                points: toWirePoints(points),
                radius: snapSearchRadius(options),
                threshold: options.threshold,
            }),
        });

        // 204 is the documented "nothing close enough" answer, not a failure.
        if (response.status === 204) {
            return null;
        }

        if (!response.ok) {
            // Worth surfacing rather than swallowing: a 419 here means the
            // lookup is not working at all, and it would otherwise look
            // identical to "no street nearby".
            console.warn('Road lookup failed', response.status);

            return null;
        }

        return snapLookupFromResponse(await response.json());
    } catch {
        return null;
    }
}

/**
 * What to tell the reviewer about a re-lay.
 *
 * By street, with a count each, because that is the claim the tool actually
 * makes and the only one a reviewer can check: an editor looking at a message
 * that says "18 points re-laid" learns only that something happened, while
 * "Calle Mercado �6, Av. Ca�oto �5" can be held against the map in a glance.
 * Naming the streets is also the honest version of a bulk change � the reviewer
 * dragged nothing and is about to have a hundred vertices move, and silence
 * about where they went is what makes a tool like that untrustworthy.
 *
 * A street with no name is named as such rather than skipped, on the same
 * grounds the lookup does not refuse to move a route onto it: two thirds of the
 * network has no name, and "unnamed street �3" is still information about where
 * three vertices went.
 *
 * The spacing is mentioned only when it had to be reduced, which is the only
 * case where it is news.
 */
export function describeRelay(
    streets: RelayStreetReport[],
    unmatched: number,
): string {
    // Checked before anything is composed, because "Re-laid 0 points onto 0
    // streets" is both clumsy and a lie about work that did not happen. Nothing
    // placed is its own outcome and it is the one a reviewer most needs stated
    // plainly: the selection was somewhere the imported network does not reach.
    if (streets.length === 0) {
        return unmatched === 0
            ? 'Nothing was selected.'
            : `No selected point had a street within range. ${unmatched} left where ${unmatched === 1 ? 'it is' : 'they are'}.`;
    }

    const parts = streets.map(
        (street) =>
            `${street.name ?? 'unnamed street'} x${street.placed}` +
            (street.closestSpacing !== null &&
            street.closestSpacing < RELAY_MIN_SPACING_METERS - 0.5
                ? ` (closest ${Math.round(street.closestSpacing)} m apart)`
                : ''),
    );

    if (unmatched > 0) {
        parts.push(
            `${unmatched} left where ${unmatched === 1 ? 'it is' : 'they are'}: no street within range`,
        );
    }

    return (
        `Re-laid ${streets.reduce((total, street) => total + street.placed, 0)} ` +
        `points onto ${streets.length} ${streets.length === 1 ? 'street' : 'streets'}: ` +
        `${parts.join(', ')}.`
    );
}

/**
 * Ask which street each point of a selected stretch belongs to.
 *
 * The same shape of call as a drop and for the same reason � the points go out in
 * route order and the answer comes back in that order, because a corner is only
 * distinguishable from a straight run by knowing which point came before which.
 *
 * Every failure is an empty list, which is what a caller needs to hear in order
 * to leave the selection alone: the geometry is already written, a stale answer
 * would move vertices the reviewer has since put somewhere else, and a point with
 * no street is an ordinary outcome rather than a fault. A non-2xx status is still
 * worth a warning, for the same reason as on a drop � a broken lookup and a gap
 * in the map look identical from the outside.
 */
export async function lookupRelayStreets(
    points: Position[],
    options: { threshold: number },
    cookie: string,
): Promise<StreetLookup[]> {
    if (points.length === 0) {
        return [];
    }

    try {
        const response = await fetch(roads.relay.url(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-XSRF-TOKEN': csrfToken(cookie),
            },
            credentials: 'same-origin',
            signal: AbortSignal.timeout(SNAP_LOOKUP_TIMEOUT_MS),
            body: JSON.stringify({
                points: toWirePoints(points),
                radius: snapSearchRadius(options),
                threshold: options.threshold,
            }),
        });

        if (!response.ok) {
            console.warn('Road lookup failed', response.status);

            return [];
        }

        return relayLookupsFromResponse(await response.json());
    } catch {
        return [];
    }
}

/**
 * Ask which street continues past the end of another one.
 *
 * The third road lookup, and the only one whose answer is a judgement rather than a
 * measurement: there is no graph in the table, so "what continues" is decided by
 * where the caller says it was heading. That is why the bearing is sent rather than
 * derived here — only the walk knows which way along the route it was going.
 *
 * Every failure is a null for the same reason the other two have one: the drop has
 * already been committed, so a street that could not be asked about costs the
 * crossing and nothing else. A street with no identity is refused rather than
 * passed on, because without one the server cannot exclude the road the walk is
 * leaving and would hand back the street the route is already on — a loop that
 * never leaves the block, which looks like a working answer.
 */
export async function continueRoad(
    street: LayStreet,
    from: Position,
    bearing: number,
    cookie: string,
    signal: AbortSignal = AbortSignal.timeout(SNAP_LOOKUP_TIMEOUT_MS),
): Promise<StreetContinuation | null> {
    // Asking about a street with no identity would ask the server to exclude
    // nothing, and the answer it gives then is the street the walk is on.
    if (street.roadId === null) {
        return null;
    }

    try {
        const response = await fetch(roads.continue.url(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-XSRF-TOKEN': csrfToken(cookie),
            },
            credentials: 'same-origin',
            signal,
            body: JSON.stringify({
                road_id: street.roadId,
                lat: from[1],
                lng: from[0],
                bearing,
            }),
        });

        // 204 is the documented "nothing continues here" answer, not a failure.
        if (response.status === 204) {
            return null;
        }

        if (!response.ok) {
            console.warn('Road continuation lookup failed', response.status);

            return null;
        }

        return continuationFromResponse(await response.json());
    } catch {
        return null;
    }
}

/**
 * Ask the server to trace a route between two control points.
 *
 * The fourth lookup and the first one that is a search. The origin carries
 * the bearing the walk was travelling — only the caller knows, for the same
 * reason as continueRoad above — and it is what the server uses to pick the
 * carriageway when two one-way halves run side by side.
 *
 * Unlike the other three lookups, `status: 'none'` with a reason IS the
 * answer, not a failure to paper over: the editor tells the reviewer which
 * correction applies. So this returns the validated shape on 200 whatever
 * the status inside it, and only a broken lookup (non-2xx, network, garbage)
 * is null.
 */
export async function lookupRoute(
    origin: Position,
    destination: Position,
    bearing: number | null,
    cookie: string,
    signal: AbortSignal = AbortSignal.timeout(ROUTE_LOOKUP_TIMEOUT_MS),
): Promise<RouteLookup | null> {
    try {
        const response = await fetch(roads.route.url(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-XSRF-TOKEN': csrfToken(cookie),
            },
            credentials: 'same-origin',
            signal,
            body: JSON.stringify({
                origin: { lat: origin[1], lng: origin[0] },
                destination: { lat: destination[1], lng: destination[0] },
                ...(bearing !== null ? { bearing } : {}),
            }),
        });

        if (!response.ok) {
            // 404 is the graph's own "not built yet" answer, and it is a real
            // outcome with its own message — surfaced as a refusal rather
            // than swallowed, because a reviewer stuck on it deserves to know
            // no edit of theirs fixes it.
            if (response.status === 404) {
                return {
                    status: 'none' as const,
                    coordinates: null,
                    streets: null,
                    distanceM: null,
                    warnings: [],
                    reason: 'graph-not-built',
                };
            }

            console.warn('Route lookup failed', response.status);

            return null;
        }

        return routeLookupFromResponse(await response.json());
    } catch {
        return null;
    }
}
