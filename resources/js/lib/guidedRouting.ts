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

import {
    distanceMeters,
    findClosestSegment,
    projectOnSegment,
    RESAMPLE_SPACING_METERS,
} from '@/lib/routeEditing';
import type { Coordinates, Position } from '@/lib/routeEditing';

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
 * The distance and the street it ENTERED, and nothing else. The list this used
 * to print was written for a tramo of one or two streets; a rebuilt stretch
 * crosses six, and by the fourth the message was wrapping to four lines over
 * the map carrying less than its first word. "Starting on" is the claim a
 * reviewer can check — the answer begins at the click, so the first street says
 * whether the snap took the road they aimed at — and the total is the number
 * they can hold against the drawing.
 *
 * Unnamed streets drop out whenever anything is named, which is nearly always:
 * 71% of the imported network carries no name, so a list that keeps them is
 * mostly the words "unnamed street", four times over.
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

    const traced = `Traced ${Math.round(distanceM ?? 0)} m`;
    const named = streets.filter(
        (street): street is { name: string; meters: number } =>
            street.name !== null && street.name !== '',
    );
    const entry = named[0];

    if (entry === undefined) {
        return traced;
    }

    if (named.length < 2) {
        return `${traced}, starting on ${entry.name}`;
    }

    const rest = named.length - 1;

    return `${traced}, starting on ${entry.name} + ${rest} more ${
        rest === 1 ? 'street' : 'streets'
    }`;
}

/**
 * Why the router refused, in the reviewer's own terms.
 *
 * Every one of these ends in the same place, and that place is the `add` mode:
 * hand drawing was the third gesture in the guided mode until it was cut for
 * being a second button doing a job the mode picker already does. So the
 * sentence now names the mode the reviewer has to switch to, which is a thing
 * they can see, instead of a gesture they would have to look for.
 */
export function describeRouteRefusal(reason: string | null): string {
    switch (reason) {
        case 'origin-too-far':
            return 'The control point is too far from any street. Move it closer, or place a vertex in Add mode.';
        case 'destination-too-far':
            return 'The new point is too far from any street. Move it closer, or place a vertex in Add mode.';
        case 'no-path':
            return 'No legal connection was found between the two points. Add a control point between them, or place a vertex in Add mode.';
        case 'budget':
            return 'The search gave up before finding a connection. Add a control point between them, or place a vertex in Add mode.';
        case 'graph-not-built':
            return 'The road graph is not built on this server. Draw the route in Add mode.';
        default:
            // A null reason is a lookup that failed rather than one that
            // answered - worth saying as waiting, because trying again is
            // likely to succeed.
            return 'The route lookup did not answer. Try again, or place a vertex in Add mode.';
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
/**
 * The §3 warning when a stored control point is no longer on its route.
 *
 * Every fix it names has to be a gesture the reviewer can actually perform
 * right now, which is the standard this message was failing: it offered to
 * "redraw its tramo", which is not a gesture in this editor, while the two that
 * are — drag it onto the route, or remove it — went unmentioned. A warning that
 * names an action the reviewer cannot take is the same defect as a silent
 * refusal, with more words in it.
 */
export function describeDetached(count: number): string {
    if (count === 0) {
        return '';
    }

    return count === 1
        ? 'One control point no longer sits on the route. Drag it onto it, or remove the control.'
        : `${count} control points no longer sit on the route. Drag them onto it, or remove them.`;
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

/**
 * Why the removal control cannot be pressed, or '' when it can.
 *
 * The refusal has to be said out loud. removeWaypoint() returns null for a
 * route's two ends, and the caller had nowhere to say so: a reviewer who
 * selected the start control, pressed Remove control, and watched nothing happen
 * had been told the truth by omission. A button that cannot act explains itself
 * in its own tooltip, which is also why it is never hidden.
 *
 * An empty string is the answer for an interior control rather than a third
 * sentence, because the caller uses it to decide whether the button is disabled
 * and there is nothing left to say when the answer is no.
 */
export function describeRemoveControlBlock(
    selected: number | null,
    total: number,
): string {
    if (selected === null) {
        return 'Click a control on the map to select it, then this takes it away.';
    }

    // A one-control recipe is both ends at once, so this needs no special case
    // for it: index 0 is the start by the same test either way.
    if (selected <= 0 || selected >= total - 1) {
        return (
            'The start and end of a route are not removable — they are what ' +
            'the route is, not how it was traced. Drag it instead.'
        );
    }

    return '';
}

/**
 * What a removal that could not re-route did instead.
 *
 * Said, because the alternative is the worse version of this edit: a control
 * quietly dropped from the recipe with no re-route leaves the stretch it used
 * to pin as whatever the geometry happened to be, and the reviewer who wanted
 * that stretch gone is left looking at it.
 */
export function describeRemoveWithoutReroute(): string {
    return (
        'Removed without re-routing: the controls around it are not on the ' +
        'route, so the tramo was left exactly as it is.'
    );
}

// ---------------------------------------------------------------------------
// Where a point meets a route.
//
// One projection, shared by everything that has to say "this point belongs to
// the route at that place": the anchors of a rebuild, and the reconnect a drag
// does on a control that has drifted off its own route.
//
// It matters that there is only one. The projection is what makes an off-route
// control editable at all — the span it used to pin can be delimited by where it
// projects rather than by a vertex it does not have — and a second copy of the
// arithmetic is a second place for the two to disagree about where the cut is.
// ---------------------------------------------------------------------------

/** Where a point lands on the route, and the part of it to address it by. */
export interface RouteProjection {
    /** The vertex index of the segment it lands on. */
    index: number;
    /** How far along that segment, clamped to it. */
    t: number;
    /** The nearest point on the route itself. */
    point: Position;
}

/**
 * Where a position meets the route, or null when there is none to meet.
 *
 * Single member, like every other route in the editor, so the segment is member
 * zero and the answer does not have to carry which one it came from.
 */
export function projectOnRoute(
    coordinates: Coordinates,
    position: Position,
): RouteProjection | null {
    const segment = coordinates[0];

    if (!segment || segment.length < 2) {
        return null;
    }

    const hit = findClosestSegment(position, coordinates);

    if (hit === null || hit.segIdx !== 0) {
        return null;
    }

    const a = segment[hit.pointIdx] as Position | undefined;
    const b = segment[hit.pointIdx + 1] as Position | undefined;

    if (!a || !b) {
        return null;
    }

    const projection = projectOnSegment(position, a, b);

    return {
        index: hit.pointIdx,
        // Clamped, deliberately: where a point meets the route is the nearest
        // point ON it, and an unclamped parameter would place the cut past the
        // end of a segment the point never reaches.
        t: Math.min(1, Math.max(0, projection.t)),
        point: projection.point,
    };
}

/** A route cut at a point, and where the cut vertex ended up. */
export interface RouteCut {
    coordinates: Coordinates;
    /** The index of the vertex the cut left on the route. */
    index: number;
    /**
     * Whether a vertex was written.
     *
     * Reported because a caller cutting twice in a row has to know whether the
     * second cut renumbered the first one's vertex: an inserted vertex pushes
     * everything after it along by one, and a span bound read before the insert
     * then points one vertex too far.
     */
    inserted: boolean;
}

/**
 * The route with a vertex at the point a projection names.
 *
 * The primitive behind every operation that replaces a stretch whose boundary
 * is not a vertex — a rebuild's regions, and the drag that reconnects a control
 * which has drifted off its route. Without it those operations have no way to
 * say where the replaced stretch ended.
 *
 * A projection that lands exactly on an existing vertex cuts nothing: inserting
 * there would duplicate a vertex the route already has, and every "span
 * degenerate" check downstream would trip over a zero-length segment the cut
 * invented. The coordinates come back untouched in that case, which is the same
 * promise the callers make about the spans they do not touch.
 */
export function cutRouteAt(
    coordinates: Coordinates,
    projection: RouteProjection,
): RouteCut | null {
    const segment = coordinates[0];

    if (!segment) {
        return null;
    }

    if (projection.t <= 0) {
        return {
            coordinates,
            index: Math.min(projection.index, segment.length - 1),
            inserted: false,
        };
    }

    const at = projection.index + 1;
    const next = coordinates.map((part) => [...part]);

    (next[0] as Position[]).splice(at, 0, projection.point);

    return { coordinates: next, index: at, inserted: true };
}

// ---------------------------------------------------------------------------
// Rectifying a stretch: anchors placed inside a route, rebuilding only the
// stretch they bound.
//
// The bound is the region between the outermost anchors, never the whole span
// they sit in. Re-routing a span because a control landed inside it would move
// the parts of the route that were already right, and a reviewer rectifying the
// middle of a line does not want the ends handed back as collateral.
//
// It is also the only gesture that can: a click near the route splits a span
// (both halves re-laid), a click far from it extends an end, and neither can
// say "keep the first three kilometres and re-lay the next one".
// ---------------------------------------------------------------------------

/**
 * One anchor a reviewer placed for a rebuild, and where it falls on the route.
 *
 * `clicked` is the raw click and `projection` the point of the route it belongs
 * to; the difference between them is the connector the reviewer is asking for,
 * and it is drawn rather than hidden because a pin thirty metres off its street
 * is a visible choice, not a rounding.
 *
 * `snapped` is null until the router has spoken: the router snaps its own
 * origin and destination, so the position a control is committed at is the one
 * its answer starts and ends with — the same rule the extension and the
 * insertion already follow, and the reason this feature needs no snap calls of
 * its own.
 */
export interface RegionAnchor {
    clicked: Position;
    /** The vertex index of the segment the anchor projects onto. */
    index: number;
    /** The projection along that segment, clamped to it. */
    t: number;
    /** Where the anchor meets the route. */
    projection: Position;
    /** Its route order as a fraction, so two on one segment still order. */
    order: number;
    snapped: Position | null;
}

/**
 * The anchors in the order the route runs, each carrying where it lands.
 *
 * Ordered by position along the route rather than by click order, because a
 * reviewer rectifying the middle of a route clicks wherever the wrong turn is,
 * and a recipe that took the clicks at face value would hand the server a
 * scrambled ordinal — the role of every control after it follows from that
 * order, so the damage would not show until the line was reopened.
 *
 * Null when the route has no segment to project onto.
 */
export function orderAnchorsByRoute(
    anchors: Position[],
    coordinates: Coordinates,
): RegionAnchor[] | null {
    const placed: RegionAnchor[] = [];

    for (const clicked of anchors) {
        const projection = projectOnRoute(coordinates, clicked);

        if (projection === null) {
            return null;
        }

        placed.push({
            clicked,
            index: projection.index,
            t: projection.t,
            projection: projection.point,
            order: projection.index + projection.t,
            snapped: null,
        });
    }

    return placed.sort((left, right) => left.order - right.order);
}
/**
 * The controls the region would destroy, by waypoint index.
 *
 * The rebuild replaces every vertex between the region's two boundaries, so a
 * control standing in there loses its vertex and would survive as a detached
 * one. Reported instead of dropped: the recipe is the reviewer's own list of
 * pins, and losing one to an edit they thought only added things is not a
 * trade they were offered. The remedy is in reach — remove it first, or bound
 * the region tighter.
 */
export function controlsInsideRegion(
    waypoints: Waypoint[],
    coordinates: Coordinates,
    region: RegionAnchor[],
): number[] {
    if (region.length < 2) {
        return [];
    }

    const first = region[0] as RegionAnchor;
    const last = region[region.length - 1] as RegionAnchor;
    const inside: number[] = [];

    waypoints.forEach((waypoint, index) => {
        const vertex = findVertexForWaypoint(coordinates, waypoint);

        if (vertex === null || vertex.segment !== 0) {
            return;
        }

        if (vertex.index > first.order && vertex.index < last.order) {
            inside.push(index);
        }
    });

    return inside;
}

/** What a rebuild attempt produced, refusals included. */
export interface RegionRebuild {
    coordinates: Coordinates;
    /** False when the region cannot be rebuilt; coordinates is then the input. */
    rebuilt: boolean;
    reason: 'no-route' | 'empty-chain' | 'degenerate-region' | null;
}

/**
 * The route with the stretch between two anchors replaced by a routed chain.
 *
 * The cut is the whole trick. Both boundaries land where an anchor PROJECTS
 * onto the route, not where the anchor sits, so the polylines meet: the old
 * route runs up to its projection, the chain leaves from the anchor that sits
 * on the street there, and the difference between the two is the connector the
 * reviewer asked for. Cutting first and splicing second is what lets
 * replaceTramoSpan do the rest, and therefore what leaves the vertices outside
 * the region as the same objects they were — the byte-identity that lets a
 * reviewer trust the rest of their route did not move.
 *
 * The cuts go in back to front because the earlier one renumbers everything
 * after it, so a boundary index read before the second cut would point one
 * vertex too far along.
 */
export function rebuildRegion(
    coordinates: Coordinates,
    region: RegionAnchor[],
    chain: Position[],
): RegionRebuild {
    const segment = coordinates[0];

    if (region.length < 2 || !segment || segment.length < 2) {
        return { coordinates, rebuilt: false, reason: 'no-route' };
    }

    if (chain.length < 2) {
        return { coordinates, rebuilt: false, reason: 'empty-chain' };
    }

    const first = region[0] as RegionAnchor;
    const last = region[region.length - 1] as RegionAnchor;

    // Before any cut, because two anchors on the same spot have to be refused
    // rather than cut twice: both would land on one vertex and the region would
    // rebuild a stretch of nothing between them. The order field is the anchors'
    // own position along the route, so this is the same comparison the sorting
    // that produced them already made.
    if (first.order >= last.order) {
        return { coordinates, rebuilt: false, reason: 'degenerate-region' };
    }

    // Both cuts go in back to front, and each one renumbers what came after it,
    // so the earlier boundary is read only after the later cut is already in the
    // geometry. The rule about a projection that lands on an existing vertex
    // cutting nothing lives in cutRouteAt, once.
    const endCut = cutRouteAt(coordinates, {
        index: last.index,
        t: last.t,
        point: last.projection,
    });

    if (endCut === null) {
        return { coordinates, rebuilt: false, reason: 'degenerate-region' };
    }

    const startCut = cutRouteAt(endCut.coordinates, {
        index: first.index,
        t: first.t,
        point: first.projection,
    });

    if (startCut === null) {
        return { coordinates, rebuilt: false, reason: 'degenerate-region' };
    }

    // The start cut went in second, so it shifted the end boundary — and only
    // when it wrote a vertex to shift it past.
    const endIndex = endCut.index + (startCut.inserted ? 1 : 0);

    if (startCut.index >= endIndex) {
        return { coordinates, rebuilt: false, reason: 'degenerate-region' };
    }

    return {
        coordinates: replaceTramoSpan(
            startCut.coordinates,
            startCut.index,
            endIndex,
            [first.projection, ...chain, last.projection],
        ),
        rebuilt: true,
        reason: null,
    };
}

/**
 * The recipe with a region's anchors threaded in, roles re-derived.
 *
 * Every anchor lands in the same slot — between the same two controls — because
 * the region refuses to span a control it would destroy, so one index serves
 * the whole batch. The positions committed are the snapped ones: a control that
 * does not sit on the road it claims is the disagreement a saved record must
 * not carry.
 */
export function anchorsIntoRecipe(
    waypoints: Waypoint[],
    coordinates: Coordinates,
    region: RegionAnchor[],
): Waypoint[] {
    if (region.length === 0) {
        return waypoints;
    }

    const first = region[0] as RegionAnchor;
    const slot = waypoints.reduce((count, waypoint) => {
        const vertex = findVertexForWaypoint(coordinates, waypoint);

        if (
            vertex === null ||
            vertex.segment !== 0 ||
            vertex.index > first.order
        ) {
            return count;
        }

        return count + 1;
    }, 0);

    const added = region.map((anchor) => ({
        position: anchor.snapped ?? anchor.clicked,
        role: 'via' as const,
    }));

    const next = [
        ...waypoints.slice(0, slot),
        ...added,
        ...waypoints.slice(slot),
    ];

    return next.map((waypoint, index) => ({
        position: waypoint.position,
        role: waypointRoleAt(next, index),
    }));
}

// ---------------------------------------------------------------------------
// How many vertices a routed answer keeps.
//
// A router answer has one vertex per graph node, and a node is every junction
// in the imported network — so a straight avenue crossed by twenty side streets
// comes back with twenty vertices, none of which carries any shape at all. The
// editor's own re-spacing presets put normal spacing for this data at a hundred
// metres or more; the graph's edges median under forty. That gap is what makes
// an assisted route look like it grew a rash.
// ---------------------------------------------------------------------------

/**
 * How far the line may move, in metres, for a vertex to be worth keeping.
 *
 * Started deliberately high and meant to be lowered once real routes have been
 * through it — the knob a reviewer adjusts after seeing the result, not the one
 * they have to defend before they have seen any.
 *
 * The ceiling it is bounded by is the editor's own: a line that moves less than
 * DETACHED_TOLERANCE_METERS (25 m) is somewhere the editor already treats as
 * the same place a control is, so nothing here can take a control off its route
 * that it would not have accepted there anyway.
 */
export const ROUTED_SIMPLIFY_TOLERANCE_METERS = 5;

/**
 * The longest gap a simplified answer may leave between two vertices.
 *
 * The tolerance above cannot do this job, and the reason is worth stating
 * because it is what a tolerance is: Douglas-Peucker measures deviation from a
 * chord and says nothing about how long that chord is. A four-hundred-metre
 * straight run deviates zero metres from its chord, so any tolerance at all
 * authorises collapsing it to two vertices four hundred metres apart — the line
 * keeps its shape perfectly and ends up with gaps nobody drew. Lowering the
 * tolerance does not help; that run is not a rounding, it is a span.
 *
 * Borrowed from the editor's own finest re-spacing preset rather than invented:
 * it is a number this project already uses to describe how far apart the
 * vertices of a line are meant to sit, and a rebuilt stretch denser than its
 * surroundings is harmless while one sparser is not.
 */
export const ROUTED_MAX_SPAN_METERS = RESAMPLE_SPACING_METERS[0];

/**
 * A turn this sharp survives on its own, whatever the distance says.
 *
 * Without it, a high tolerance eats corners: two thirty-metre legs meeting at a
 * right angle deviate about twelve metres from their chord, which a twenty-metre
 * budget calls free — and a bus route that cuts a corner is wrong in a way no
 * vertex count makes up for. So vertices are dropped by distance and kept by
 * angle, and this is the line between a turn and a drift.
 */
export const ROUTED_CORNER_DEGREES = 45;

/** What a simplification did, in the numbers a reviewer can check it against. */
export interface SimplifiedChain {
    positions: Position[];
    /** How many vertices went, and therefore how many the route stops carrying. */
    dropped: number;
    /**
     * The furthest the line moved, in metres.
     *
     * Only the collapsed stretches count: a vertex that survived carries its own
     * deviation where it stands, so reporting it would claim movement that never
     * happened.
     */
    maxDeviation: number;
}

/** The angle a polyline turns at a vertex, in degrees, with null meaning no turn. */
function turnAt(chain: Position[], index: number): number {
    const incoming = headingBetween(chain[index - 1] as Position, chain[index]);
    const outgoing = headingBetween(chain[index], chain[index + 1] as Position);

    if (incoming === null || outgoing === null) {
        return 0;
    }

    const raw = Math.abs(incoming - outgoing);

    return raw > 180 ? 360 - raw : raw;
}

/**
 * A routed answer with the vertices that carry no shape taken out of it.
 *
 * Douglas-Peucker, with two additions the plain algorithm needs for street data.
 * The split point is chosen by priority: a pinned index first, because a control
 * that lost its vertex goes detached and the reviewer's own pin is what put it
 * there; then a stretch too long to leave without a vertex, then the vertex
 * furthest from the chord; then the sharpest corner, which a large tolerance
 * would otherwise flatten. Only when none of those earns the split does the
 * stretch collapse into its two ends.
 *
 * The two ends are never candidates. A routed answer begins at the caller's join
 * and ends where the reviewer aimed, so both are structure rather than sample
 * points — the same reason spliceTramo drops only the head.
 *
 * Reported rather than applied quietly: this is the one edit in the guided mode
 * that removes vertices the router put there, and a reviewer who cannot see how
 * many cannot tell a clean line from a mangled one.
 */
export function simplifyRoutedChain(
    chain: Position[],
    pinned: number[] = [],
    tolerance: number = ROUTED_SIMPLIFY_TOLERANCE_METERS,
    maxSpan: number = ROUTED_MAX_SPAN_METERS,
): SimplifiedChain {
    if (chain.length < 3) {
        return { positions: [...chain], dropped: 0, maxDeviation: 0 };
    }

    const kept: number[] = [0];
    const isPinned = new Set(pinned);
    let dropped = 0;
    let maxDeviation = 0;

    // An explicit stack rather than recursion: a chain of a few hundred vertices
    // nested as deeply as it is long is a stack depth nobody should depend on.
    const pending: Array<[number, number]> = [[0, chain.length - 1]];

    while (pending.length > 0) {
        const range = pending.pop() as [number, number];
        const [from, to] = range;

        if (to - from < 2) {
            continue;
        }

        let split = -1;

        for (let i = from + 1; i < to; i += 1) {
            if (isPinned.has(i)) {
                split = i;

                break;
            }
        }

        if (split === -1) {
            // The furthest vertex and the decision to keep it are separate
            // findings. Assigning the split index as the search runs made the
            // collapse below unreachable for any stretch whose centreline
            // wobbles by so much as a centimetre — which is every straight run
            // in a real network — and the whole point is that those are the
            // stretches that lose their vertices.
            let furthest = 0;
            let furthestIndex = -1;
            const span = distanceMeters(
                chain[from] as Position,
                chain[to] as Position,
            );

            for (let i = from + 1; i < to; i += 1) {
                const projection = projectOnSegment(
                    chain[i] as Position,
                    chain[from] as Position,
                    chain[to] as Position,
                );
                const distance = distanceMeters(
                    chain[i] as Position,
                    projection.point,
                );

                if (distance > furthest) {
                    furthest = distance;
                    furthestIndex = i;
                }
            }

            if (span > maxSpan || furthest > tolerance) {
                // A collinear range has no furthest vertex at all — every
                // interior vertex sits on the chord, at a distance of zero — and
                // the span rule wants a split from one anyway. It wants the
                // MIDDLE one: splitting at the first interior index marches
                // along the run one vertex at a time and keeps all of them,
                // which spends the whole span rule to achieve nothing. Halving
                // is what turns four hundred metres of avenue into a handful of
                // vertices instead of a slightly shorter version of every one.
                split =
                    furthestIndex === -1
                        ? from + 1 + Math.floor((to - from - 1) / 2)
                        : furthestIndex;
            } else {
                // Nothing here bends the line. A corner still does, whatever the
                // chord says, so it gets its split before the stretch closes.
                let sharpest = ROUTED_CORNER_DEGREES;

                for (let i = from + 1; i < to; i += 1) {
                    const turn = turnAt(chain, i);

                    if (turn > sharpest) {
                        sharpest = turn;
                        split = i;
                    }
                }

                if (split === -1) {
                    dropped += to - from - 1;
                    maxDeviation = Math.max(maxDeviation, furthest);

                    continue;
                }
            }
        }

        pending.push([from, split], [split, to]);
        kept.push(split);
    }

    kept.push(chain.length - 1);

    return {
        positions: [...new Set(kept)]
            .sort((left, right) => left - right)
            .map((index) => chain[index] as Position),
        dropped,
        maxDeviation,
    };
}

/**
 * What a simplification did, said in the numbers that back it.
 *
 * Empty when nothing was dropped, because a line that says "0 vertices
 * dropped" teaches the reviewer to read past the sentence that matters.
 */
export function describeSimplification(
    dropped: number,
    maxDeviation: number,
): string {
    if (dropped === 0) {
        return '';
    }

    return (
        ` ${dropped} ${dropped === 1 ? 'vertex' : 'vertices'} dropped, ` +
        `max ${Math.round(maxDeviation)} m off the line`
    );
}

/**
 * Which of the two things a click in guided mode can do.
 *
 * One state rather than the two booleans it replaced, and the reason is not
 * tidiness: "add anchors" and "draw by hand" could both be on at once, the row
 * then said the reviewer was drawing by hand while the click handler was
 * pinning anchors, and nothing on screen contradicted it. A single field cannot
 * hold a state the row would have to contradict.
 *
 * Drawing by hand is not the third option here: the `add` mode already places
 * a vertex per click, and a second way to do it was one button too many in a
 * row that has to fit without wrapping.
 */
export type GuideGesture = 'trace' | 'anchors';

/**
 * The batch's router answers as one chain.
 *
 * Each answer begins where the previous ended, so every head after the first
 * is dropped — the same join spliceTramo drops, and for the same reason.
 */
export function stitchedChain(tramos: Position[][]): Position[] {
    return tramos.reduce<Position[]>(
        (chain, tramo, index) =>
            index === 0 ? [...tramo] : [...chain, ...tramo.slice(1)],
        [],
    );
}

/**
 * Where each anchor actually sits, read off the batch's answers.
 *
 * One more position than there are answers: the first answer's head is the
 * first anchor, every answer's tail is the next one. They are the router's own
 * snap, which is why the anchors need no lookup of their own — and why two
 * anchors are never committed from two separate snaps of one click.
 */
export function anchorSnaps(tramos: Position[][]): Position[] {
    const snaps: Position[] = [];
    const first = tramos[0];

    if (first && first.length > 0) {
        snaps.push(first[0] as Position);
    }

    for (const tramo of tramos) {
        const last = tramo[tramo.length - 1];

        if (last) {
            snaps.push(last);
        }
    }

    return snaps;
}

/** Why a rebuild was refused, said as the correction that would clear it. */
export function describeRectifyRefusal(reason: string | null): string {
    return (
        {
            'no-route': 'There is no route to rebuild yet.',
            'empty-chain': 'The router returned nothing for that stretch.',
            'degenerate-region':
                'Those anchors bound no stretch. Move them further apart.',
        }[reason ?? ''] ?? 'That stretch cannot be rebuilt.'
    );
}

/** Not enough anchors to bound anything, with the number that is missing. */
export function describeAnchorsNeeded(placed: number): string {
    return placed === 0
        ? 'Click the map to place anchors first. Two of them bound a stretch.'
        : 'One more anchor: two of them bound a stretch to rebuild.';
}

/**
 * Controls the region would destroy, named so the reviewer can act on them.
 *
 * A control that stood inside the stretch loses its vertex, so the rebuild
 * refuses rather than quietly dropping it — the reviewer removes it, or bounds
 * the region tighter. Both are one gesture, and either is a decision they get
 * to make instead of a loss they discover later.
 */
export function describeBlockedControls(indices: number[]): string {
    const named = indices.map((index) => `control ${index + 1}`).join(', ');

    return (
        `The stretch holds ${named}, which the rebuild would remove. ` +
        'Remove it first, or bound the anchors tighter.'
    );
}
