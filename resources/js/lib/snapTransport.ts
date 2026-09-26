import { snapSearchRadius } from '@/lib/routeEditing';
import type { Position, SnapOptions } from '@/lib/routeEditing';
import { snapLookupFromResponse, toWirePoints } from '@/lib/snapWire';
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
 * The count only speaks when it has something to say. Along a route the moved
 * vertices are mostly on different streets by definition, so a stretch of any
 * length reports something like "1 of 7" — and printing that after a perfectly
 * good snap makes a correct result read as a doubtful one, which is the exact
 * opposite of what a confirmation is for.
 *
 * So it appears only when the moved vertices back the street the snap chose,
 * which is the crossing case: the votes settled something the distances could
 * not, and the reviewer is being told which of the two nearby roads the choice
 * went to and on what grounds. Everything else just gets the street name.
 */
export function describeSnap(found: SnapLookup): string {
    const street = found.name ?? 'unnamed street';

    if (found.votes < 2 || found.votes * 2 <= found.samples) {
        return street;
    }

    return `${street} — ${found.votes} of ${found.samples} moved vertices are on it`;
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
            signal: AbortSignal.timeout(SNAP_LOOKUP_TIMEOUT_MS),
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
