/**
 * The guided mode's own geometry bookkeeping.
 *
 * Framework-free and DOM-free, like routeEditing: the map component holds the
 * reactive state, this module hands it the rules. The state it describes is
 * deliberately the minimum a reviewer can see and reason about — a list of
 * control points and the route they imply — because everything the guided
 * mode adds beyond the plain editor has to be explainable in those terms.
 *
 * One decision this file exists to state once: the routed geometry stays a
 * single-member MultiLineString, and a tramo is an editor-side concept —
 * the stretch between two adjacent waypoints. Splicing accepts the router's
 * offer by appending its interior vertices to the route's tail (excluding
 * the join vertex, which is already there), so the saved shape of an old
 * route is untouched by the presence of waypoints.
 */

import type { Position } from '@/lib/routeEditing';

/** How many control points one route may hold. */
export const WAYPOINT_LIMIT = 200;

/** What role a waypoint speaks as, decided only by its position in the list. */
export type WaypointRole = 'start' | 'via' | 'end';

export interface Waypoint {
    /**
     * Where the control point lives — snapped to the network, not where the
     * click landed. Recalculating a tramo needs an on-road point to ask the
     * router from, and the click position is the one thing that need not be.
     */
    position: Position;
    /**
     * The role the waypoint owned when it was created. The bootstrap gives
     * this to the route's two ends, and an accepted tramo creates the role
     * that one splice implies; afterwards it mostly reminds the reviewer what
     * the endpoint pins were.
     */
    role: WaypointRole;
}

/**
 * The controls an existing route already implies.
 *
 * Spec 4.1: a route that only carries vertices gets exactly two control
 * points — first vertex starts, last vertex finishes — and the existing
 * geometry counts as the initial tramo between them. Converting more of the
 * existing vertices into control points would claim an intention the route's
 * history does not hold.
 *
 * Null when there are no endpoints to give: a route needs two positions to
 * control, and inventing them from nothing is drawing, which the map's own
 * click handler already does.
 */
export function guidesFromGeometry(
    coordinates: number[][][] | undefined,
): Waypoint[] | null {
    const first = coordinates?.[0]?.[0];
    const lastSegment = coordinates?.[coordinates.length - 1];
    const last = lastSegment?.[lastSegment.length - 1];

    if (!first || !last) {
        return null;
    }

    // A route whose two ends are the same position is not a route: two
    // control points on one vertex imply a tramo of nothing, and the list
    // would lie about an intention the shape does not hold.
    if (first[0] === last[0] && first[1] === last[1]) {
        return null;
    }

    return [
        { position: [first[0], first[1]], role: 'start' as const },
        { position: [last[0], last[1]], role: 'end' as const },
    ];
}

/** The list grows any way it wants; the role comes from where it lands. */
export function waypointRoleAt(
    waypoints: Waypoint[],
    index: number,
): WaypointRole {
    return index === 0
        ? 'start'
        : index === waypoints.length - 1
          ? 'end'
          : 'via';
}

/** One row of the persisted recipe, as the server hands it over. */
export interface WaypointRecord {
    ordinal: number;
    role: string;
    lat: number;
    lng: number;
}

/**
 * The stored recipe, back in the editor's own shape.
 *
 * The server sends flat rows keyed by ordinal; the editor speaks [lng, lat]
 * positions with a derived role. Stored rows are trusted on the shape the
 * server controls (ordinal, role) and read defensively on the fields a
 * double column can hand back as either type; a row that cannot be trusted
 * at all is dropped rather than becoming a control at position [NaN, NaN].
 */
export function waypointsFromRecord(records: unknown): Waypoint[] {
    if (!Array.isArray(records)) {
        return [];
    }

    return records
        .filter(
            (record): record is WaypointRecord =>
                typeof record === 'object' &&
                record !== null &&
                typeof record.lat === 'number' &&
                Number.isFinite(record.lat) &&
                typeof record.lng === 'number' &&
                Number.isFinite(record.lng),
        )
        .map((record) => ({
            position: [record.lng, record.lat] as Position,
            role:
                record.role === 'start' || record.role === 'end'
                    ? record.role
                    : 'via',
        }));
}

/**
 * A control point appended, with every role re-derived from the new order.
 *
 * Roles are derived state rather than accumulated: the previous tail was an
 * end until this one arrived, and carrying a stale role forward is exactly
 * the kind of drift that shows up in a persisted record. Re-deriving all of
 * them from the new list keeps one rule for what a role is.
 */
export function appendWaypoint(
    waypoints: Waypoint[],
    position: Position,
): Waypoint[] {
    const next = [...waypoints, { position, role: 'end' as const }];

    return next.map((waypoint, index) => ({
        position: waypoint.position,
        role: waypointRoleAt(next, index),
    }));
}

/**
 * A control point prepended — the mirror of appendWaypoint for extending a
 * route at its start. The whole list's roles re-derive, so the previous
 * start becomes a via the moment something lands before it.
 */
export function prependWaypoint(
    waypoints: Waypoint[],
    position: Position,
): Waypoint[] {
    const next = [{ position, role: 'start' as const }, ...waypoints];

    return next.map((waypoint, index) => ({
        position: waypoint.position,
        role: waypointRoleAt(next, index),
    }));
}

/** The compass bearing from one position to another, or null for a point. */
export function headingBetween(from: Position, to: Position): number | null {
    if (from[0] === to[0] && from[1] === to[1]) {
        return null;
    }

    const east = (to[0] - from[0]) * Math.cos((from[1] * Math.PI) / 180);
    const north = to[1] - from[1];
    const degrees = (Math.atan2(east, north) * 180) / Math.PI;

    return ((degrees % 360) + 360) % 360;
}

/**
 * A vertex appended at the tail by hand — the guided mode's manual fallback.
 *
 * The mirror of spliceTramo for a tramo the router never proposed: the click
 * itself is the vertex, and the route keeps being one continuous member.
 * Where the route is fresh, this is also how its first vertex arrives.
 */
export function appendVertexToTail(
    coordinates: number[][][],
    position: Position,
): number[][][] {
    const next = (coordinates.length > 0 ? coordinates : [[]]).map(
        (segment) => [...segment],
    );

    next[0] = [...next[0], position];

    return next;
}

/** Whose route end an extension grows at, said in one place. */
export type GuideEnd = 'tail' | 'head';

/**
 * One accepted tramo spliced into the route.
 *
 * Sent to the tail, the incoming vertices are appended after the tail and
 * the join vertex (the head of the reject) is left out. The result is a new
 * array — the map emits it and the composable stores it — but the interior
 * positions are the router's own objects, which is safe because every emit
 * past this point treats coordinates as read-only.
 */
export function spliceTramo(
    coordinates: number[][][],
    tramo: Position[],
): number[][][] {
    if (tramo.length === 0) {
        return coordinates;
    }

    const fresh = coordinates.length === 0 || coordinates[0].length === 0;

    // A routed tramo starts at the join vertex — the route's own tail — so
    // that position must not appear twice. Only the FIRST position drops:
    // the last one is where the tramo ends, and dropping it would leave the
    // route shy of the destination the reviewer aimed at. A fresh route has
    // no tail yet, so the whole answer arrives.
    const interior = fresh ? tramo : tramoInterior(tramo);

    const next = (coordinates.length > 0 ? coordinates : [[]]).map(
        (segment) => [...segment],
    );

    next[0] = [...next[0], ...interior];

    return next;
}

/** The vertices of a router answer minus its join head, said once. */
export function tramoInterior(tramo: Position[]): Position[] {
    return tramo.slice(1);
}

/**
 * The two points an extension asks the router about.
 *
 * The router answers in the order the path is TRAVELLED, and an extension at
 * the head travels backwards: the route will now go from the new point TO the
 * start it already had. Asking it the other way round — old start to new
 * point, the order the reviewer drew it on screen — produces two defects that
 * look like one: the answer has to be reversed before it can be prepended, and
 * one-ways and turn restrictions get evaluated against the direction the route
 * will never run. The snap bearing rides along on the new point for the same
 * reason: it is the approach the reviewer is arriving with.
 */
export function extensionEndpoints(
    frontier: GuideEnd,
    from: Position,
    clicked: Position,
): { origin: Position; destination: Position } {
    return frontier === 'head'
        ? { origin: clicked, destination: from }
        : { origin: from, destination: clicked };
}

/**
 * What to tell the reviewer about a route the router found.
 *
 * By street, with the distance each covered, because that is the claim the
 * tramo makes and the only one a reviewer can check against the map: "Av.
 Cristo Redentor —240 m" can be held against the drawing, whereas a "1 km
 * traced" is a number that went nowhere.
 *
 * An unnamed street is named as such rather than skipped — most of the
 * imported network carries no name and the vertices it contributed are real.
 */
export function describeRoute(
    streets: Array<{ name: string | null; meters: number }>,
    distanceM: number | null,
): string {
    if (streets.length === 0) {
        return distanceM === null || distanceM === 0
            ? 'The two control points snapped to the same road vertex.'
            : `Traced ${Math.round(distanceM)} m`;
    }

    const parts = streets.map(
        (street) =>
            `${street.name ?? 'unnamed street'} —${Math.round(street.meters)} m`,
    );

    return `Traced ${parts.join(', ')}`;
}

/** Why the router refused, in the reviewer's own terms. */
export function describeRouteRefusal(reason: string | null): string {
    switch (reason) {
        case 'origin-too-far':
            return 'The control point is too far from any street. Move it closer or draw this part by hand.';
        case 'destination-too-far':
            return 'The new point is too far from any street. Move it closer or draw this part by hand.';
        case 'no-path':
            return 'No legal connection was found between the two points. Add a control point between them or draw this part by hand.';
        case 'budget':
            return 'The search gave up before finding a connection. Add a control point between them or draw this part by hand.';
        case 'graph-not-built':
            return 'The road graph is not built on this server. This cannot be fixed from here; draw the route by hand.';
        default:
            // A null reason is a lookup that failed rather than one that
            // answered — worth saying as waiting, because trying again is
            // likely to succeed.
            return 'The route lookup did not answer. Try again, or draw this part by hand.';
    }
}

/** The one message a reviewer needs while the router is thinking. */
export function describeRoutedPending(): string {
    return 'Tracing the route…';
}

/**
 * The endpoint's warnings as sentences, instead of a generic hand-wave.
 *
 * The wire carries short tokens with the metre count in them, and the count
 * is the news: a control point that snapped 8 m off is a rounding, one that
 * snapped 90 m off is a different street than the reviewer aimed at. The
 * generic "(snapped to the network)" said nothing about which of those
 * happened. Unknown tokens pass through verbatim — a warning invented on the
 * server must not be silently dropped by a client that has not caught up.
 */
export function describeRouteWarnings(warnings: string[]): string {
    if (warnings.length === 0) {
        return '';
    }

    const parts = warnings.map((warning) => {
        const originMatch = /^origin-snapped-(\d+)m$/.exec(warning);
        const destinationMatch = /^destination-snapped-(\d+)m$/.exec(warning);

        if (originMatch) {
            const meters = Number(originMatch[1]);

            return `the control point sat ${meters} m away from the road`;
        }

        if (destinationMatch) {
            const meters = Number(destinationMatch[1]);

            return `the new point sat ${meters} m away from the road`;
        }

        return warning;
    });

    return `Warning: ${parts.join('; ')}.`;
}

/**
 * The §3 warning when a stored control point is no longer on its route.
 *
 * Not an error and not auto-repaired: the waypoint may be exactly where the
 * reviewer's history put it, while the route was hand-edited since. The
 * sentence offers the two fixes that exist (retrace or remove) instead of
 * pretending the state is fine.
 */
export function describeDetached(count: number): string {
    if (count === 0) {
        return '';
    }

    return count === 1
        ? 'One control point no longer sits on the route. Redraw its tramo or remove the control.'
        : `${count} control points no longer sit on the route. Redraw their tramos or remove them.`;
}

// ---------------------------------------------------------------------------
// Spec §4: editing a route's control points and tramos.
// ---------------------------------------------------------------------------

/**
 * How far a waypoint may sit from the nearest vertex and still count as on
 * its route.
 *
 * The same figure the snap presets call "normal", and for the same reason:
 * it is the distance below which nobody can tell a rounded placement from an
 * exact one. A waypoint beyond it is not wrong — the route may have been
 * dragged since — but it is no longer the control point of what is on
 * screen, and the spec asks for the warning instead of a silent guess.
 */
export const DETACHED_TOLERANCE_METERS = 25;

/**
 * A vertex's identity, addressed the way the editor addresses vertices.
 */
export interface VertexAddress {
    segment: number;
    index: number;
    distance: number;
}

/** Metres between two positions, the editor's own metric. */
function waypointDistance(a: Position, b: Position): number {
    // The latitude-scaled frame routeEditing walks in, reduced to the one
    // operation a nearest-vertex test needs. Exact enough at these scales:
    // the tolerance is 25 m and the ways' own vertices sit metres apart.
    const scale = Math.cos((a[1] * Math.PI) / 180);

    return Math.hypot((b[0] - a[0]) * scale, b[1] - a[1]) * 111320;
}

/**
 * The heading a route arrives at one of its vertices with.
 *
 * Reads backwards from the vertex for the nearest previous leg that is real
 * (two coincident vertices make no leg); null when nothing behind has one —
 * the same honest answer finalHeading gives a route that cannot say.
 *
 * This is the bearing a mid-route recalculator needs: the tramo AFTER a
 * moved control must leave in the direction the route was travelling when
 * it got there, and that is a property of the geometry behind the vertex,
 * not of the click that moved it.
 */
export function headingAtVertex(
    coordinates: number[][][] | null,
    segment: number,
    vertex: number,
): number | null {
    if (coordinates === null) {
        return null;
    }

    for (let segIdx = segment; segIdx >= 0; segIdx -= 1) {
        const current = coordinates[segIdx];

        if (current === undefined) {
            continue;
        }

        const start = segIdx === segment ? vertex : current.length - 1;

        for (let index = start; index > 0; index -= 1) {
            const a = current[index - 1];
            const b = current[index];

            if (a[0] === b[0] && a[1] === b[1]) {
                continue;
            }

            const east = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180);
            const north = b[1] - a[1];
            const degrees = (Math.atan2(east, north) * 180) / Math.PI;

            return ((degrees % 360) + 360) % 360;
        }
    }

    return null;
}

/** The heading of the route's last drawn leg, degrees clockwise from north. *
 *
 * The router snaps the origin onto the carriageway whose outgoing direction
 * agrees with it, so the approach heading must be the route's own last leg
 * rather than the click position. A folded straight route can ask with
 * nothing; a route whose last two vertices coincide has no leg to offer, and
 * null is the honest "this one you figure out yourself" answer.
 */
export function finalHeading(coordinates: number[][][] | null): number | null {
    if (coordinates === null) {
        return null;
    }

    const lastSegment = coordinates.length - 1;

    return headingAtVertex(
        coordinates,
        lastSegment,
        (coordinates[lastSegment]?.length ?? 1) - 1,
    );
}

/**
 * The vertex a waypoint currently lives on, or null when detached.
 *
 * Waypoint positions are on-road positions (spec §5), but the geometry can
 * move under them — a hand edit, a drag elsewhere. The tramo boundaries are
 * therefore re-derived on demand instead of stored as indexes: storing them
 * would go stale on the first edit that changed a span's length.
 */
export function findVertexForWaypoint(
    coordinates: number[][][],
    waypoint: Waypoint,
    tolerance: number = DETACHED_TOLERANCE_METERS,
): VertexAddress | null {
    let best: VertexAddress | null = null;

    coordinates.forEach((segment, segIdx) => {
        segment.forEach((position, index) => {
            const distance = waypointDistance(waypoint.position, [
                position[0],
                position[1],
            ]);

            if (
                distance <= tolerance &&
                (best === null || distance < best.distance)
            ) {
                best = { segment: segIdx, index, distance };
            }
        });
    });

    return best;
}

/** The waypoints no longer sitting on their route, for the §3 warning. */
export function detachedWaypoints(
    coordinates: number[][][],
    waypoints: Waypoint[],
    tolerance: number = DETACHED_TOLERANCE_METERS,
): Waypoint[] {
    return waypoints.filter(
        (waypoint) =>
            findVertexForWaypoint(coordinates, waypoint, tolerance) === null,
    );
}

/**
 * One accepted tramo spliced into the route, replacing the span it governs.
 *
 * The uniform rule every accepted guided edit shares — extension, insertion,
 * move-recalc, removal alike: the stretch between two adjacent waypoints is
 * replaced by the router's answer, whose first and last positions ARE the
 * two waypoint positions afterwards. The endpoint vertices are re-read from
 * the answer rather than kept, because the router's own snapped ends are
 * what keeps a control on its route; the reviewer sees the two ends move
 * onto the road, which is exactly the promise of the preview.
 *
 * `from` and `to` are the CURRENT vertex indexes of the two bounding
 * waypoints (re-derived by the caller), and everything between them
 * disappears. Indexes shift when the span's length changes — that is why
 * they are never stored.
 *
 * Single-member routes are the invariant (every stored line is one), so the
 * span must live in member 0; anything else returns the input untouched.
 */
export function replaceTramoSpan(
    coordinates: number[][][],
    from: VertexAddress | number,
    to: VertexAddress | number,
    tramo: Position[],
): number[][][] {
    if (tramo.length < 2 || coordinates.length === 0) {
        return coordinates;
    }

    const fromIndex = typeof from === 'number' ? from : from.index;
    const toIndex = typeof to === 'number' ? to : to.index;

    if (toIndex <= fromIndex) {
        return coordinates;
    }

    const segment = coordinates[0];

    if (segment === undefined || fromIndex < 0 || toIndex >= segment.length) {
        return coordinates;
    }

    const next = coordinates.map((part) => [...part]);

    next[0] = [
        ...segment.slice(0, fromIndex),
        ...tramo,
        ...segment.slice(toIndex + 1),
    ];

    return next;
}

/**
 * A routed tramo prepended — extending the route at its start.
 *
 * The answer runs from the new control to the old start; the old start
 * vertex is the join and its own first vertex must not appear twice, so the
 * answer contributes everything up to it and the route keeps its rest.
 */
export function prependTramo(
    coordinates: number[][][],
    tramo: Position[],
): number[][][] {
    if (tramo.length < 2) {
        return coordinates;
    }

    if (coordinates.length === 0) {
        return [[...tramo]];
    }

    const next = coordinates.map((segment) => [...segment]);

    next[0] = [...tramo.slice(0, -1), ...next[0]];

    return next;
}

/**
 * A control point inserted between two others, roles re-derived.
 *
 * Insertion splits the tramo the click landed on, so the new waypoint takes
 * the index after the span's first bound — between the two, exactly where
 * the click aimed.
 */
export function insertWaypointAt(
    waypoints: Waypoint[],
    index: number,
    position: Position,
): Waypoint[] {
    if (index <= 0 || index >= waypoints.length) {
        return waypoints;
    }

    const next = [
        ...waypoints.slice(0, index),
        { position, role: 'via' as const },
        ...waypoints.slice(index),
    ];

    return next.map((waypoint, position2) => ({
        position: waypoint.position,
        role: waypointRoleAt(next, position2),
    }));
}

/**
 * A control point removed, roles re-derived.
 *
 * Only an interior waypoint may go: removing a route's start or end changes
 * what the route is rather than how it was traced, and that is the reviewer's
 * move, not this helper's. Null says so.
 */
export function removeWaypoint(
    waypoints: Waypoint[],
    index: number,
): Waypoint[] | null {
    if (waypoints.length < 3 || index <= 0 || index >= waypoints.length - 1) {
        return null;
    }

    const next = waypoints.filter((_, i) => i !== index);

    return next.map((waypoint, i) => ({
        position: waypoint.position,
        role: waypointRoleAt(next, i),
    }));
}
