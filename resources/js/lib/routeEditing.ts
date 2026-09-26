/**
 * Pure geometry helpers for the line route editor.
 *
 * Everything here is a plain function over coordinate arrays: no Vue, no
 * Leaflet, no DOM. Keeping it that way is what makes it testable — the editor
 * holds a GeoJSON payload in a ref and hands it back to the server, so a
 * mutation bug in here corrupts stored routes silently rather than throwing.
 *
 * Coordinate convention, stated once because the previous inline version
 * mixed it: a position is always `[lng, lat]` and a route is always
 * `number[][][]` of `[lng, lat]`. Leaflet's own `(lat, lng)` order appears in
 * exactly one place, toLatLngs(), which is the single conversion boundary.
 */

export type Position = [number, number];

export type Coordinates = number[][][];

/** A vertex addressed by its position inside the route. */
export interface VertexRef {
    segment: number;
    index: number;
}

export interface ClosestSegment {
    segIdx: number;
    pointIdx: number;
}

export interface RouteEndpoints {
    start: Position;
    end: Position;
}

/**
 * Perpendicular distance from a point to a segment, in degrees.
 *
 * A zero-length segment is not a line, so the distance falls back to the
 * distance to the point itself rather than dividing by zero.
 *
 * The result is in degrees, not metres: latitude and longitude are only
 * approximately interchangeable at a single latitude. Callers that need a real
 * walk distance should convert once, at the point of comparison, rather than
 * trusting a degree figure to be a distance.
 */
export function pointToSegmentDistance(
    point: Position,
    a: Position,
    b: Position,
): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
        return Math.hypot(point[0] - a[0], point[1] - a[1]);
    }

    const t = Math.max(
        0,
        Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lenSq),
    );

    return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

export interface SegmentProjection {
    /**
     * Fraction along the segment, deliberately UNCLAMPED.
     *
     * A value below 0 or above 1 is the signal that the click overshot an end,
     * which is what decides which side of the endpoint a new vertex belongs on.
     * Clamping here would silently move the insert to the wrong side of a
     * vertex.
     */
    t: number;
    /** Nearest point on the segment, with t clamped to the segment's span. */
    point: Position;
}

/**
 * Project a point onto a segment, keeping both the raw parameter and the
 * clamped foot of the perpendicular.
 */
export function projectOnSegment(
    point: Position,
    a: Position,
    b: Position,
): SegmentProjection {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
        return { t: 0, point: [a[0], a[1]] };
    }

    const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lenSq;

    return {
        t,
        point: [
            a[0] + Math.max(0, Math.min(1, t)) * dx,
            a[1] + Math.max(0, Math.min(1, t)) * dy,
        ],
    };
}

/**
 * Nearest point on a segment, clamped to its ends.
 *
 * Returns [lng, lat] like every other position here.
 */
export function closestPointOnSegment(
    point: Position,
    a: Position,
    b: Position,
): Position {
    return projectOnSegment(point, a, b).point;
}

/**
 * Index of the segment of the route closest to a point, in degrees.
 *
 * Ties resolve to the earliest segment, which makes the pick deterministic
 * rather than dependent on iteration order.
 *
 * Returns null only when the route holds no segment with two distinct
 * positions, i.e. nothing to measure against.
 */
export function findClosestSegment(
    point: Position,
    coordinates: Coordinates,
): ClosestSegment | null {
    let minDistance = Infinity;
    let result: ClosestSegment | null = null;

    coordinates.forEach((segment, segIdx) => {
        for (let i = 0; i < segment.length - 1; i++) {
            const distance = pointToSegmentDistance(
                point,
                segment[i] as Position,
                segment[i + 1] as Position,
            );

            if (distance < minDistance) {
                minDistance = distance;
                result = { segIdx, pointIdx: i };
            }
        }
    });

    return result;
}

/**
 * Insert a position into a segment, choosing the side from where the click
 * projected.
 *
 * `t` is the unclamped projection parameter from projectOnSegment(). A click
 * that overshoots the start of the span belongs before the span's first
 * vertex, and one that overshoots the end belongs after its last vertex.
 * Always inserting "after the span start" would put the vertex on the wrong
 * side of an endpoint the moment a click landed slightly past it, silently
 * rerouting the segment the user was aiming at.
 *
 * Returns a new array. The input is never mutated, which is the invariant that
 * keeps a drag from quietly rewriting the route the component still holds.
 */
export function insertVertexAt(
    coordinates: Coordinates,
    segIdx: number,
    pointIdx: number,
    position: Position,
    t: number,
): Coordinates {
    const next = coordinates.map((segment) => [...segment]);
    const at = t <= 0 ? pointIdx : t >= 1 ? pointIdx + 2 : pointIdx + 1;

    next[segIdx].splice(at, 0, position);

    return next;
}

/**
 * Drop a vertex.
 *
 * A segment that already holds only two positions is removed outright rather
 * than reduced to a single point: a one-position segment cannot be drawn, and
 * ST_DumpPoints would still report a position for it, inventing a stop that
 * does not exist. A longer segment keeps the vertex it loses, because two
 * positions is still a drawable line.
 */
export function removeVertexAt(
    coordinates: Coordinates,
    segIdx: number,
    pointIdx: number,
): Coordinates {
    const next = coordinates.map((segment) => [...segment]);
    const segment = next[segIdx];

    if (segment.length <= 2) {
        next.splice(segIdx, 1);
    } else {
        segment.splice(pointIdx, 1);
    }

    return next;
}

/**
 * Every vertex inside a rectangle, in route order.
 *
 * Pure, so the marquee selection is testable: a box gesture over a line
 * catches a scattered set, and the order it returns them in is what makes the
 * selection legible and its length meaningful.
 *
 * The box is expressed in the caller's own units because the caller knows what
 * they have. Swapped corners give the same vertices.
 */
export function verticesWithinBounds(
    coordinates: Coordinates,
    inside: (position: Position) => boolean,
): VertexRef[] {
    const found: VertexRef[] = [];

    coordinates.forEach((segment, segIdx) => {
        segment.forEach((position, pointIdx) => {
            if (inside([position[0], position[1]])) {
                found.push({ segment: segIdx, index: pointIdx });
            }
        });
    });

    return found;
}

/**
 * Replace one vertex, returning a new array.
 */
export function moveVertexAt(
    coordinates: Coordinates,
    ref: VertexRef,
    position: Position,
): Coordinates {
    const next = coordinates.map((segment) => [...segment]);

    next[ref.segment][ref.index] = [position[0], position[1]];

    return next;
}

/**
 * Every vertex in an inclusive range, ordered from lower to higher.
 *
 * Order matters: a range is picked by clicking two endpoints, and which one was
 * clicked first is not information worth carrying. Normalising here means the
 * caller never has to branch on direction.
 */
export function rangeBetween(a: VertexRef, b: VertexRef): VertexRef[] {
    const segment = a.segment;

    const from = Math.min(a.index, b.index);
    const to = Math.max(a.index, b.index);

    const range: VertexRef[] = [];

    for (let i = from; i <= to; i++) {
        range.push({ segment, index: i });
    }

    return range;
}

/**
 * Clamp a range to what a segment actually holds.
 *
 * Both endpoints are included in the selection, so the guard is one past the
 * last index.
 */
export function clampRange(
    coordinates: Coordinates,
    range: VertexRef[],
): VertexRef[] {
    return range.filter((ref) => {
        const segment = coordinates[ref.segment];

        return (
            segment !== undefined &&
            ref.index >= 0 &&
            ref.index < segment.length
        );
    });
}

/**
 * Translate a set of vertices by the same offset.
 *
 * Every selected vertex moves rigidly: no falloff, no smoothing, no
 * interpolation. That is the point — this is a selection being moved, not a
 * guess about where the route should have gone.
 *
 * Returns a new array with the input left intact.
 */
export function applyDeltaToSelection(
    coordinates: Coordinates,
    selection: VertexRef[],
    delta: Position,
): Coordinates {
    const selected = new Set(
        selection.map((ref) => `${ref.segment}:${ref.index}`),
    );

    return coordinates.map((segment, segIdx) =>
        segment.map((position, pointIdx) => {
            if (!selected.has(`${segIdx}:${pointIdx}`)) {
                return [position[0], position[1]];
            }

            return [position[0] + delta[0], position[1] + delta[1]];
        }),
    );
}

/**
 * First position of the first segment and last position of the last one.
 *
 * Null below two positions in total, so a single clicked vertex does not get
 * two pins stacked on the same point. Counting across the whole route rather
 * than per segment is deliberate: a MultiLineString of two one-position
 * segments has two positions and therefore two distinct ends, even though
 * neither segment can be drawn on its own.
 */
export function routeEndpoints(
    coordinates: Coordinates,
): RouteEndpoints | null {
    const total = coordinates.reduce(
        (count, segment) => count + segment.length,
        0,
    );

    if (total < 2) {
        return null;
    }

    const first = coordinates[0]?.[0];
    const lastSegment = coordinates[coordinates.length - 1];
    const last = lastSegment?.[lastSegment.length - 1];

    if (!first || !last) {
        return null;
    }

    return {
        start: [first[0], first[1]],
        end: [last[0], last[1]],
    };
}

/** A street the user dropped near, with the point projected onto it. */
export interface SnapCandidate {
    position: Position;
    distance: number;
}

export interface SnapDecision {
    apply: boolean;
    position: Position | null;
    candidate: SnapCandidate | null;
}

export interface SnapOptions {
    /** How far a street can be from the reference point and still count. */
    threshold: number;
    /** The user is holding a modifier and does not want a snap at all. */
    bypass?: boolean;
}

/**
 * Decide whether a dropped vertex should move onto a street centreline.
 *
 * The caller owns the two judgements this defers: `bypass` is the user holding
 * a modifier, and `threshold` is how far a street can be and still count. A
 * candidate beyond the threshold is declined rather than clamped, because
 * pulling a vertex a hundred metres sideways to reach a road is a worse edit
 * than leaving it where it was dropped.
 *
 * Distance is the whole decision, and the candidate carries nothing else to
 * decide by. An earlier version also required a share of the moved vertices to
 * agree on the street, which looked like a safeguard and was the opposite: a
 * route is not a straight run along one street, it goes down one, turns, and
 * carries on along another, so spread across a real route the agreement is
 * about one in seven. That gate passed for two vertices and refused almost
 * everything from three upward, which meant multi-vertex dragging — the main way
 * anyone corrects a route — silently did nothing. The sampled points are still
 * worth asking about, but only for picking the street, which the server does;
 * whether to snap stays a question about the point the user actually grabbed.
 */
export function decideSnap(
    candidate: SnapCandidate | null,
    options: SnapOptions,
): SnapDecision {
    if (
        options.bypass ||
        candidate === null ||
        candidate.distance > options.threshold
    ) {
        return { apply: false, position: null, candidate };
    }

    return {
        apply: true,
        position: [candidate.position[0], candidate.position[1]],
        candidate,
    };
}

/**
 * Every preset, in the order a control should offer them — least to most
 * aggressive.
 *
 * The type is derived from this rather than written beside it, so the set the
 * UI renders, the set that validates a stored preference, and the set the
 * switch handles cannot disagree. A preset missing from this list does not
 * exist anywhere else either.
 */
export const SNAP_PRESET_NAMES = [
    'off',
    'subtle',
    'normal',
    'aggressive',
] as const;

/** How aggressively a drop is pulled onto the street network. */
export type SnapPreset = (typeof SNAP_PRESET_NAMES)[number];

/**
 * How far a drop may be from a street, per preset.
 *
 * One number each, because one number is all there is to decide. The presets
 * used to carry a second setting for how much of the moved selection had to
 * agree on the street, and it is gone: the moved selection did not have to
 * agree on anything, so the number described a rule that refused the work
 * people were doing. Kept next to decideSnap so what a preset claims and what
 * the decision uses cannot drift apart.
 */
export const SNAP_PRESETS: Record<Exclude<SnapPreset, 'off'>, SnapOptions> = {
    subtle: { threshold: 12 },
    normal: { threshold: 25 },
    aggressive: { threshold: 50 },
};

/**
 * The settings behind a preset, or null when snapping is off.
 *
 * `off` is deliberately not a row in the table. A preset named "off" carrying
 * a threshold of zero still snaps a vertex dropped at exactly zero metres —
 * rare enough to look like it works, real enough to make the setting a lie —
 * and expressing it as a threshold invites every caller to re-derive that guard
 * for itself. Returning null makes off mean off, and TypeScript makes the
 * caller narrow before it can read a threshold.
 */
export function snapOptionsFor(preset: SnapPreset): SnapOptions | null {
    if (preset === 'off') {
        return null;
    }

    return SNAP_PRESETS[preset];
}

/**
 * How many points a single drop may ask about.
 *
 * Seven is enough to tell a stretch that lies along one street from one that
 * straddles three, and the lookup stays a single round trip, so there is no
 * reason to spend more.
 */
export const SNAP_SAMPLE_LIMIT = 7;

/**
 * The search radius to request for a preset.
 *
 * Derived rather than a fourth magic number: the radius only has to be wider
 * than the threshold, because a candidate further out than the radius is
 * declined anyway and never becomes a candidate. `aggressive` therefore looks
 * further without needing its own constant to keep in sync.
 */
export function snapSearchRadius(options: SnapOptions): number {
    return Math.max(60, options.threshold * 2);
}

/** Position addressed by a vertex ref, or null if the ref is out of range. */
function positionAt(coordinates: Coordinates, ref: VertexRef): Position | null {
    const point = coordinates[ref.segment]?.[ref.index];

    if (!point) {
        return null;
    }

    return [point[0], point[1]];
}

function isSameVertex(a: VertexRef, b: VertexRef): boolean {
    return a.segment === b.segment && a.index === b.index;
}

/** Take `count` items spread evenly across `items`, endpoints included. */
function spread<T>(items: T[], count: number): T[] {
    if (count >= items.length) {
        return [...items];
    }

    if (count <= 1) {
        return items.slice(0, 1);
    }

    const step = (items.length - 1) / (count - 1);

    return Array.from({ length: count }, (_, i) => items[Math.round(i * step)]);
}

/**
 * The points one drop should ask the server about, reference first.
 *
 * The reference is the vertex the user actually grabbed, and it has to lead:
 * the caller applies one rigid offset to the whole selection, and that offset
 * is computed from this point, so a response describing a different point would
 * move the stretch to a place nobody dropped it.
 *
 * The rest are spread across the selection in route order, endpoints included,
 * so a long stretch is sampled at its far end too — a stretch that only agrees
 * with itself near the grabbed vertex is exactly the case agreement exists to
 * catch. Duplicate positions are dropped, because two vertices on the same
 * corner would otherwise spend two of the seven sample slots voting for the
 * same answer.
 */
export function snapSample(
    coordinates: Coordinates,
    selection: VertexRef[],
    reference: VertexRef,
    limit = SNAP_SAMPLE_LIMIT,
): Position[] {
    const anchor = positionAt(coordinates, reference);

    if (anchor === null) {
        return [];
    }

    // Deduplicated across the whole sample, not just against the anchor: two
    // vertices sharing a corner would otherwise each spend a slot voting for
    // the same street and inflate the agreement it gets.
    const seen = new Set([`${anchor[0]},${anchor[1]}`]);

    const others = [...selection]
        .filter((ref) => !isSameVertex(ref, reference))
        .sort((a, b) =>
            a.segment !== b.segment ? a.segment - b.segment : a.index - b.index,
        )
        .map((ref) => positionAt(coordinates, ref))
        .filter((position): position is Position => position !== null)
        .filter((position) => {
            const key = `${position[0]},${position[1]}`;

            if (seen.has(key)) {
                return false;
            }

            seen.add(key);

            return true;
        });

    return [anchor, ...spread(others, Math.max(0, limit - 1))];
}
