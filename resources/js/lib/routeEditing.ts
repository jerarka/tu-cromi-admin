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
function pointToSegmentDistance(
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

/** What a deletion took, said in full because it can take a segment with it. */
export interface RemovalResult {
    coordinates: Coordinates;
    /** How many vertices actually left the route. */
    removed: number;
    /**
     * How many segments went with them, for having been left too short to draw.
     *
     * Reported because it is not visible in the vertex count: a reviewer who
     * selected six vertices and lost a whole stretch of route deserves to be
     * told that, rather than to notice it on the map.
     */
    droppedSegments: number;
}

/**
 * Drop a set of vertices, all at once.
 *
 * Deleting one vertex at a time is not an option past a certain size. Every
 * removal renumbers the ones after it, so a reviewer working down a stretch
 * would be deleting indexes that have already moved — and the twentieth click
 * is the one that removes a vertex they had not chosen.
 *
 * The degenerate-segment rule is the interesting part, and it is inherited
 * rather than restated: a segment left with fewer than two positions is dropped
 * outright. A one-position segment cannot be drawn, and ST_DumpPoints would
 * still report a position for it, inventing a stop that does not exist. Kept
 * for the single-vertex case by delegation, so the rule has one implementation
 * and a bulk deletion cannot quietly disagree with a single one about what
 * happens to the segment they have in common.
 *
 * Refuses a deletion that would empty the route. A route with no segments
 * cannot be drawn or reviewed, and the alternative is a twenty-click setup that
 * ends with nothing to undo back onto.
 *
 * Returns the input untouched, by identity, when the selection holds nothing
 * the route still has. A selection addresses vertices by index, so one picked
 * against a previous geometry is stale rather than wrong, and the honest answer
 * to it is to do nothing.
 */
export function removeVertices(
    coordinates: Coordinates,
    selection: VertexRef[],
): RemovalResult {
    const nothing: RemovalResult = {
        coordinates,
        removed: 0,
        droppedSegments: 0,
    };

    if (selection.length === 0) {
        return nothing;
    }

    const doomed = new Set(
        selection.map((ref) => `${ref.segment}:${ref.index}`),
    );

    // Counted against the route before anything is written, so a selection made
    // against a geometry the route no longer has reports nothing removed instead
    // of rebuilding the route around it.
    let matched = 0;

    for (const ref of selection) {
        if (coordinates[ref.segment]?.[ref.index]) {
            matched += 1;
        }
    }

    if (matched === 0) {
        return nothing;
    }

    const next: Coordinates = [];
    let removed = 0;
    let droppedSegments = 0;

    coordinates.forEach((segment, segIdx) => {
        const kept = segment.filter(
            (_, index) => !doomed.has(`${segIdx}:${index}`),
        );
        const dropped = segment.length - kept.length;

        removed += dropped;

        // Only when this deletion is what left the segment that short. A segment
        // that arrived already degenerate is not this function's to tidy up, and
        // repairing it here would change geometry nobody selected.
        if (dropped > 0 && kept.length < 2) {
            droppedSegments += 1;

            return;
        }

        next.push(dropped === 0 ? [...segment] : kept);
    });

    if (next.length === 0) {
        return nothing;
    }

    return { coordinates: next, removed, droppedSegments };
}

/**
 * Drop a vertex.
 *
 * One call into the bulk deletion rather than a second implementation of the
 * same rule. It used to branch here on the segment's length, and the branch is
 * exactly the one a bulk deletion also has to make — a segment that cannot be
 * drawn is dropped either way, whether one vertex or six went missing — so
 * having it in one place is what keeps the two actions from disagreeing about
 * the segment they share.
 *
 * A segment that keeps two positions keeps them: two points is still a drawable
 * line.
 */
export function removeVertexAt(
    coordinates: Coordinates,
    segIdx: number,
    pointIdx: number,
): Coordinates {
    return removeVertices(coordinates, [{ segment: segIdx, index: pointIdx }])
        .coordinates;
}

/**
 * What a deletion took, in the reviewer's terms.
 *
 * The dropped segments lead the sentence when there are any. They are the part
 * that is not visible in the count of vertices removed, and the part a reviewer
 * has no other way of learning about.
 */
export function describeRemoval(result: RemovalResult): string {
    if (result.removed === 0) {
        return 'Nothing was selected to delete.';
    }

    const deleted =
        result.removed === 1
            ? 'Deleted 1 vertex.'
            : `Deleted ${result.removed} vertices.`;

    if (result.droppedSegments === 0) {
        return deleted;
    }

    const noun = result.droppedSegments === 1 ? 'segment' : 'segments';

    return (
        `${deleted} ${result.droppedSegments} ${noun} went too, ` +
        'left with too few points to draw.'
    );
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
 * Every vertex in an inclusive range, ordered from lower to higher.
 *
 * Order matters: a range is picked by clicking two endpoints, and which one was
 * clicked first is not information worth carrying. Normalising here means the
 * caller never has to branch on direction.
 *
 * Both endpoints have to be on the same segment. They were not checked, and a
 * click that landed on the next segment along silently produced a range inside
 * the *anchor's* segment instead — nine vertices the reviewer never indicated,
 * which then move together on a drag and get saved that way. Refusing is the
 * honest answer: a range across a boundary is a shape this function cannot
 * describe, and the caller has a marquee for the selection that ignores
 * segment boundaries anyway.
 */
export function rangeBetween(a: VertexRef, b: VertexRef): VertexRef[] {
    if (a.segment !== b.segment) {
        return [];
    }

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
 *
 * The widest is twice what it was, and that number is load-bearing well past
 * this table: `snapSearchRadius` doubles the threshold, so 100 m asks the
 * server for a 200 m lookup, which is exactly the ceiling `SnapRoadRequest`
 * validates against. Raising `aggressive` again means raising that ceiling too,
 * or the widest preset silently stops finding streets.
 */
export const SNAP_PRESETS: Record<Exclude<SnapPreset, 'off'>, SnapOptions> = {
    subtle: { threshold: 30 },
    normal: { threshold: 50 },
    aggressive: { threshold: 100 },
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
 *
 * The doubling is what puts the widest preset against the server's ceiling: a
 * 100 m threshold asks for 200 m, and `SnapRoadRequest` refuses a radius above
 * 200. It passes by exactly nothing, so the two numbers are a pair and belong
 * in the same thought.
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

/**
 * Metres in one degree of the equator.
 *
 * The conversion every distance in this feature eventually needs, and the reason
 * it cannot be skipped: a degree of longitude is this times the cosine of the
 * latitude, so in Santa Cruz it is about 5% shorter than a degree of latitude,
 * and a limit expressed in degrees means something different on every route in
 * the city.
 *
 * The rest of the module works in degrees because that is what GeoJSON and
 * Leaflet speak, and it is the right place to stop — but a *limit* here is in
 * metres, because that is what the reviewer calibrates against the snap
 * presets. So the comparison happens in the metric frame below and nowhere else.
 */
const METERS_PER_DEGREE = 111_320;

/** Longitude degrees shrink towards the poles; latitude degrees do not. */
export function longitudeScale(latitude: number): number {
    // Clamped rather than passed through: cos(90°) is zero, and a zero here
    // would divide by zero on the way back out of the frame.
    const clamped = Math.max(-89.9, Math.min(89.9, latitude));

    return Math.cos((clamped * Math.PI) / 180);
}

/**
 * A stretch of street, measured.
 *
 * One entry per part of the road's MultiLineString, and the split is not
 * bookkeeping: a road can be stored as more than one part with a real gap
 * between them, and a walk that stepped over that gap would lay a route across
 * empty land. Each part is therefore walked on its own and the walk stops at
 * the end of the one it started in.
 *
 * Held in a local metric frame — degrees of longitude scaled by the cosine of
 * the reference latitude — so a chainage in metres is a plain sum rather than a
 * sum that mixes two different units. See longitudeScale for why those two are
 * not the same size.
 */
interface StreetPart {
    /** Positions in the metric frame: `[lng * scale, lat]`. */
    points: Position[];
    /** `chainage[i]` is the distance in metres from the start to `points[i]`. */
    chainage: number[];
}

/** How far a walk may follow the street before it gives up, in metres. */
export const PROPAGATION_MAX_ARC_METERS = 250;

/**
 * How many following vertices a walk may consider.
 *
 * Four, and the walk stops the moment one of them is too far off the street, so
 * the honest answer to "the next two points" is usually two and never more than
 * four. The number exists to bound the worst case — a route running exactly along
 * a street would otherwise be pulled as far as the reviewer cared to look — and
 * a limit of two would cut off a legitimate correction that happens to span
 * three vertices.
 */
export const PROPAGATION_MAX_VERTICES = 4;

/**
 * How far along the street a placement has to move the walk's cursor, in metres,
 * before it is taken.
 *
 * The rule that keeps a propagation from piling points on top of each other, and
 * the counterpart of `RELAY_MIN_SPACING_METERS` on the re-lay side. The re-lay
 * enforces its spacing with a cursor per street; a propagation had a cursor and
 * nothing to stop a placement landing exactly on it — which is what a clamped
 * search does to a vertex the cursor has already passed. The gap between the two
 * features was the whole defect: one had the protection and the other did not.
 *
 * A metre, where the re-lay uses ten. The two answer different questions. The
 * re-lay's is a spacing to *reach*, because it is reshaping a stretch onto a
 * street that may be shorter than the stretch; refusing there costs the reviewer
 * a correction they asked for. This one is a floor below which two placements are
 * the same point, and the cost of being generous is nil: a route with vertices a
 * metre apart is a route that was already a metre apart, and straightening it is
 * what the walk was asked to do. Ten would instead cut a walk short the moment the
 * imported route got dense, leaving the very kink the feature exists to remove.
 */
export const PROPAGATION_MIN_ADVANCE_METERS = 1;

export interface PropagationLimits {
    /**
     * Furthest a following vertex may sit from the centreline and still be
     * taken, in metres.
     *
     * The same bar the dragged vertex itself was held to, which is why this is
     * derived from the active snap threshold rather than being a number of its
     * own: a reviewer who picked a preset has already said how far off a
     * centreline they are willing to accept, and a second number would be a
     * second thing to calibrate with no visible reason to disagree with the
     * first.
     */
    maxOffset: number;
    /** Furthest the walk may travel along the street from the drop, in metres. */
    maxArc: number;
    /** Most following vertices to consider, whatever the distances say. */
    maxVertices: number;
    /**
     * Least a placement has to move the cursor along the street to count.
     *
     * What separates a vertex from the one already placed. Without it a vertex
     * whose projection falls outside the search window is clamped to the window's
     * edge — which, for a vertex the cursor has already passed, is the cursor
     * itself — and it lands on the vertex the reviewer just dragged.
     */
    minAdvance: number;
}

/**
 * The limits a walk runs under, given the snap preset in force.
 *
 * Built here rather than at the call site so that what a preset means for the
 * drag and what it means for the vertices that follow cannot drift apart. The
 * threshold is the only input, deliberately: everything else is a bound on how
 * far the feature may reach, not a setting.
 */
export function propagationLimitsFor(threshold: number): PropagationLimits {
    return {
        maxOffset: threshold,
        maxArc: PROPAGATION_MAX_ARC_METERS,
        maxVertices: PROPAGATION_MAX_VERTICES,
        minAdvance: PROPAGATION_MIN_ADVANCE_METERS,
    };
}

/** Which way along the route a walk travels. */
export type PropagationDirection = 1 | -1;

export interface PropagationResult {
    coordinates: Coordinates;
    /** The vertices that were moved, in the order the walk reached them. */
    moved: VertexRef[];
}

/** A vertex placed on the street, with the position to put it at. */
interface Placement {
    ref: VertexRef;
    position: Position;
}

/**
 * The street's parts, measured from the reference's latitude.
 *
 * Built per call rather than cached because the reference moves with every drop
 * and the whole structure is a few hundred numbers: caching it would mean a key
 * to invalidate and a stale frame to reason about, in exchange for saving work
 * nobody can measure.
 */
function measureStreet(street: Coordinates, latitude: number): StreetPart[] {
    const scale = longitudeScale(latitude);

    return street
        .filter((part) => part.length >= 2)
        .map((points) => {
            const metric = points.map(
                (position) => [position[0] * scale, position[1]] as Position,
            );
            const chainage = [0];

            for (let i = 1; i < metric.length; i++) {
                // In metres, not in the frame's degrees. The frame removes the
                // difference between a degree of longitude and a degree of
                // latitude; this removes the difference between a degree and a
                // metre. Leaving it out scales every chainage by 111 320, which
                // makes the arc limit effectively unlimited and lets a walk run
                // the length of a street instead of the length the reviewer
                // agreed to.
                chainage.push(
                    chainage[i - 1] + metricDistance(metric[i - 1], metric[i]),
                );
            }

            return { points: metric, chainage };
        });
}

/**
 * Distance in metres between two positions *in the metric frame*.
 *
 * Named for what it needs rather than what it is, because the frame is a
 * precondition and getting it wrong is silent: a raw `[lng, lat]` pair read as
 * metric is a point at the wrong longitude, and the only symptom is a walk that
 * stops early or pulls a stretch to the wrong side of the street.
 *
 * The frame's scaling is not applied here — it is already in the positions —
 * because a route vertex is only ever *measured* against the street and never
 * rewritten by the walk, so it is converted in at the point of comparison and
 * does not travel any further.
 */
function metricDistance(a: Position, b: Position): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1]) * METERS_PER_DEGREE;
}

/**
 * Where a target lands on one part of the street, within a window of it.
 *
 * `target` must already be in the metric frame, like the part it is measured
 * against. Everything this returns is in that frame too, so the caller undoes
 * the scaling once on the way out rather than here.
 *
 * The window is what makes this a walk and not a lookup. A plain "closest point
 * on the street" would hand back the near end of the line for a vertex that sits
 * at the far end of it, and following that around a route of any length folds
 * the geometry back on itself into a scribble. Searching only the stretch ahead
 * of the cursor — bounded by how far the walk is allowed to go — is what makes
 * the result monotone by construction rather than by a check afterwards.
 */
function closestOnPart(
    part: StreetPart,
    target: Position,
    from: number,
    direction: PropagationDirection,
    maxArc: number,
): { chainage: number; point: Position; distance: number } | null {
    const low = direction === 1 ? from : from - maxArc;
    const high = direction === 1 ? from + maxArc : from;

    let best: { chainage: number; point: Position; distance: number } | null =
        null;

    for (let i = 0; i < part.points.length - 1; i++) {
        const segmentStart = part.chainage[i];
        const segmentEnd = part.chainage[i + 1];

        // Only the part of this segment the window actually covers.
        const from2 = Math.max(segmentStart, low);
        const to2 = Math.min(segmentEnd, high);

        if (to2 < from2) {
            continue;
        }

        const a = pointAtChainage(part, i, from2);
        const b = pointAtChainage(part, i, to2);
        const projection = projectOnSegment(target, a, b);

        // Clamped, and this is the whole reason the window works.
        // projectOnSegment reports its parameter unclamped on purpose — an
        // overshoot is how a click is placed on the right side of a vertex — but
        // here a and b are already the window's edges, so an overshoot means the
        // target is outside the stretch the walk may use and the answer has to be
        // the nearest edge rather than a point beyond the end of the way.
        //
        // Left unclamped this hands back a chainage outside [low, high]: a vertex
        // 106 m west of a street that begins there came back at -106, which put
        // the cursor behind the start of the way and made the spacing rule measure
        // the wrong distance. The distance was never wrong, because it was
        // measured to the already-clamped foot — which is exactly why every test
        // that only checked a refusal passed while the cursor quietly did not.
        //
        // The clamp keeps the cursor inside the window and hides one thing from
        // whoever calls this: a vertex the cursor has already passed comes back
        // *at* the cursor rather than near it. Neither caller can see it here,
        // because the distance is measured to the clamped foot and so reads as a
        // comfortable distance to the centreline. Both have to notice it
        // themselves — the re-lay through its own spacing rule, a propagation
        // through `minAdvance` — and until the propagation grew one, it placed
        // vertices straight on top of the dragged one.
        const t = Math.max(0, Math.min(1, projection.t));
        const chainage = from2 + t * (to2 - from2);
        const point: Position = [
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
        ];
        const distance = metricDistance(target, point);

        if (best === null || distance < best.distance) {
            best = { chainage, point, distance };
        }
    }

    return best;
}

/**
 * A point `chainage` metres along segment `index`, clamped to the segment.
 *
 * Needed because a window boundary rarely lands on a vertex, and reading the
 * position off the nearest stored vertex instead would put a propagated vertex
 * up to a whole segment away from the centreline — visible as the route stepping
 * sideways at the end of a stretch.
 */
function pointAtChainage(
    part: StreetPart,
    index: number,
    chainage: number,
): Position {
    const a = part.points[index];
    const b = part.points[index + 1];
    const length = part.chainage[index + 1] - part.chainage[index];
    const t = length === 0 ? 0 : (chainage - part.chainage[index]) / length;
    const clamped = Math.max(0, Math.min(1, t));

    return [a[0] + (b[0] - a[0]) * clamped, a[1] + (b[1] - a[1]) * clamped];
}

/**
 * The part of the street a position belongs to, and where along it.
 *
 * The closest part wins, ties going to the first, so the same drop on the same
 * street always starts its walk from the same place. The distance is kept only
 * to make that choice — it is not a snap decision, which `decideSnap` has
 * already made by the time anything here runs.
 */
function locateOnStreet(
    parts: StreetPart[],
    position: Position,
    scale: number,
): { part: StreetPart; chainage: number } | null {
    const metric: Position = [position[0] * scale, position[1]];
    let best: { part: StreetPart; chainage: number; distance: number } | null =
        null;

    for (const part of parts) {
        for (let i = 0; i < part.points.length - 1; i++) {
            const projection = projectOnSegment(
                metric,
                part.points[i],
                part.points[i + 1],
            );
            const length = part.chainage[i + 1] - part.chainage[i];
            const distance = metricDistance(projection.point, metric);

            if (best === null || distance < best.distance) {
                best = {
                    part,
                    chainage: part.chainage[i] + projection.t * length,
                    distance,
                };
            }
        }
    }

    return best === null ? null : { part: best.part, chainage: best.chainage };
}

/**
 * Pull the vertices that follow a snapped one onto the same street.
 *
 * A snap moves the vertices the reviewer grabbed, and nothing else, so a
 * one-vertex drag onto a street two blocks over leaves its neighbours sitting on
 * the street it came from. The route then crosses the block diagonally, and the
 * kink is the reviewer's first sign that the tool did half a job. This is the
 * other half.
 *
 * Three rules keep it from doing damage, and all three are about stopping:
 *
 * The walk is monotone. Each vertex is searched for only in the stretch ahead of
 * where the last one landed, so the route cannot be folded back along the street
 * it is already following.
 *
 * It stops at a vertex the cursor has already passed. The search clamps a
 * projection that falls outside its window to the nearest edge, and for a vertex
 * behind the cursor that edge is the cursor itself — so without a separate rule
 * the vertex is laid exactly on top of the one the reviewer dragged, and the
 * vertex after it lands there too. This used to be documented as "a route that
 * wiggles a couple of metres has its wiggling straightened, and one that
 * genuinely doubles back is further than the offset limit from anything in the
 * window"; that was a claim about a guard that did not exist. What actually
 * happened was the collapse described above, which is why the rule is a number in
 * `PropagationLimits` rather than a sentence in a comment.
 *
 * It stops at the first vertex too far from the centreline. That vertex is the
 * route announcing it has left this street — a turn, or the end of the block —
 * and everything past it is a different street's business.
 *
 * And it stops at the end of the way. One row of `roads` is one OSM way and a
 * way ends at a node, so a named street that is 38 ways long is corrected 38
 * times rather than once. That is the honest limit of what the table can answer,
 * and it is a visible one: the route straightens for a block and then stops.
 *
 * The reference is expected to already be on the centreline, which it is by the
 * time this runs — the offset is applied first and the walk starts from the
 * result. Nothing here checks that, because there is nothing useful to do if it
 * is not: starting from a cursor that is off the street would put every
 * propagated vertex that same distance off it, which is the rigid offset this
 * feature exists to replace.
 *
 * The walk never crosses a segment boundary. A route's MultiLineString segments
 * are not a continuation of each other, and a stretch that ran off the end of
 * one into the next is not a stretch on one street.
 *
 * A null street is part of the signature rather than a caller error, because
 * that is genuinely what arrives: the centreline comes off a lookup response
 * that is allowed to omit it, and the drop has already snapped by the time
 * anyone asks. It costs the propagation and nothing else.
 *
 * Returns the input untouched when nothing is taken, rather than a copy of it.
 * Most drops propagate nothing, and a route of five hundred vertices should not
 * be deep-copied to say so; callers branch on `moved` and are given a fresh
 * array in the branch where they use it.
 */
export function propagateAlongStreet(
    coordinates: Coordinates,
    reference: VertexRef,
    street: Coordinates | null,
    direction: PropagationDirection,
    limits: PropagationLimits,
): PropagationResult {
    const referencePosition = positionAt(coordinates, reference);

    if (referencePosition === null || !street) {
        return { coordinates, moved: [] };
    }

    const parts = measureStreet(street, referencePosition[1]);

    if (parts.length === 0) {
        return { coordinates, moved: [] };
    }

    const scale = longitudeScale(referencePosition[1]);
    const start = locateOnStreet(parts, referencePosition, scale);

    if (start === null) {
        return { coordinates, moved: [] };
    }

    const segment = coordinates[reference.segment];

    if (segment === undefined) {
        return { coordinates, moved: [] };
    }

    const placements: Placement[] = [];
    let cursor = start.chainage;
    let index = reference.index + direction;

    while (placements.length < limits.maxVertices) {
        if (index < 0 || index >= segment.length) {
            break;
        }

        const target = segment[index];

        if (!target) {
            break;
        }

        const found = closestOnPart(
            start.part,
            [target[0] * scale, target[1]],
            cursor,
            direction,
            limits.maxArc,
        );

        if (found === null || found.distance > limits.maxOffset) {
            break;
        }

        // A placement that does not move the cursor along the street is a vertex
        // the cursor has already passed, and it is the case the search window
        // produces on its own: a vertex whose projection falls outside the window
        // is clamped to the nearest edge, and for a vertex behind the cursor that
        // edge *is* the cursor — the exact position of the vertex the reviewer
        // dragged. The distance guard cannot see it, because distance is measured
        // to that already-clamped foot, so a neighbour a block behind the cursor
        // reads as being within a block of the centreline.
        //
        // Left alone rather than pushed forward, which is the re-lay's answer for
        // the same pile-up. Here the vertex is announcing that the route left this
        // street behind it, and moving it would edit a stretch nobody dragged to
        // fix a defect the reviewer can now see. So it stops the walk, and
        // everything past it with it.
        if (Math.abs(found.chainage - cursor) < limits.minAdvance) {
            break;
        }

        // Out of the metric frame, which is the only place the scaling is
        // undone. Getting this wrong mirrors the propagated stretch east or west
        // of the route, and unlike the walk itself nothing downstream would
        // notice.
        placements.push({
            ref: { segment: reference.segment, index },
            position: [found.point[0] / scale, found.point[1]],
        });

        cursor = found.chainage;
        index += direction;
    }

    if (placements.length === 0) {
        return { coordinates, moved: [] };
    }

    const next = coordinates.map((part) => [...part]);

    for (const placement of placements) {
        next[placement.ref.segment][placement.ref.index] = placement.position;
    }

    return {
        coordinates: next,
        moved: placements.map((placement) => placement.ref),
    };
}

/**
 * A street a lay can be laid onto, as far as laying is concerned.
 *
 * Narrower than `StreetLookup` on purpose: a re-lay answers per point and needs
 * the distance and the votes to decide, while a lay is handed the street the
 * reference already snapped to and only needs to know which street it is and
 * where it runs. Both `StreetLookup` and a drop's lookup satisfy this
 * structurally, which is what lets the editor pass either without a conversion.
 */
export interface LayStreet {
    /** The road's identity, or null when the answer did not carry one. */
    roadId: number | null;
    name: string | null;
    /** The centreline, or null when the answer carried nothing usable. */
    line: Coordinates | null;
}

/**
 * A street the walk crossed onto, and the point on it the walk carries on from.
 *
 * The entry point is asked for as a position rather than as a chainage, and that
 * is the whole reason this shape works. Two streets share exactly one node, so the
 * walk enters the new one at one of its two ends — but a chainage is only
 * meaningful against a named part, and a street's geometry can hold several parts
 * with real gaps between them. Naming the point lets the client find the part with
 * the same lookup it uses everywhere else, instead of being handed a number that
 * silently refers to the wrong piece of road.
 */
export interface StreetContinuation extends LayStreet {
    /** Where on the new street the walk continues, in this module's order. */
    entry: Position;
}

/** Where a walk ran out of street, and which way it was going. */
export interface StreetContinuationRequest {
    street: LayStreet;
    /**
     * The point where the walk left this street, in this module's order.
     *
     * Where the geometry runs out, not where the reviewer pointed: a continuation
     * is a question about the network from that node outward, and a query from
     * anywhere else answers a different one.
     */
    from: Position;
    /**
     * Which way along the route the walk is travelling.
     *
     * A drop at the far end of a street is a different question from one at the
     * near end — same position, same radius, opposite answer — and it is the
     * sign of this that tells the server which end it is being asked about.
     */
    direction: PropagationDirection;
    /**
     * The compass bearing the walk was travelling at that point, degrees
     * clockwise from north.
     *
     * Asked for rather than left to the server, because the server has no way to
     * work it out: it holds one row per OSM way and nothing records which way a
     * route runs along one. A route runs against a way's own node order about
     * half the time, and the two senses of a line are separate rows, so "which
     * way is this street going" has no answer in the data. The walk knows because
     * it knows which direction it is walking.
     */
    bearing: number;
}

/**
 * Asks what continues past the end of a street.
 *
 * Injected rather than imported for two reasons, and both of them about the
 * tests. It is the only network call this feature makes, so a test can lay a
 * stretch across two streets with a fake and assert the re-anchoring without a
 * server; and it keeps the seam where the revision guard already is, so a stale
 * answer is dropped by the same comparison that drops a stale snap.
 */
export type ContinueStreet = (
    request: StreetContinuationRequest,
) => Promise<StreetContinuation | null>;

/**
 * How many corners one drop may cross while laying a selection.
 *
 * One, and it is a cap rather than a limit because past the first corner the
 * answer is a heuristic whose confidence falls off with every branch it might
 * have taken: a four-way junction with the geometry the network actually has is
 * not decidable from geometry alone. A drop that crosses one corner is a
 * correction a reviewer can check by looking; a drop that crosses three is a
 * 400-metre stretch they now have to inspect, which is more attention than the
 * edit was worth and more than the save is reversible about.
 *
 * The alternative was to refuse any selection that turns a corner at all, which
 * is honest and useless: a corner in the middle of a stretch is the single most
 * common thing a route does.
 */
export const LAY_MAX_CROSSINGS = 1;

/**
 * How far outside a street's end a vertex may ask to be and still be placed, in
 * metres.
 *
 * A millimetre, and the asymmetry is the whole reason it exists. The chainage a
 * vertex asks for is a sum of floating-point distances, so "exactly at the end of
 * the street" is not a representable value: a selection whose spacing works out to
 * precisely the remaining street lands a few billionths of a metre past it and
 * gets dropped. Dropping costs a vertex, and a vertex shifts every transfer index
 * above it. The same comparison going the other way costs a placement a
 * millimetre off the end of the road, which nobody can see on a map — the
 * imported network's own vertices are three metres from the centreline on a median
 * route.
 *
 * The alternative — no tolerance — is a refusal decided by the last bit of a
 * floating-point sum, which is the one input in this feature nobody controls.
 */
export const LAY_EDGE_TOLERANCE_METERS = 0.001;

/**
 * How far the continuation's entry point may be from the street it claims to enter,
 * in metres.
 *
 * `locateOnStreet` answers "where on this street is that point" and it answers
 * with the nearest point on the geometry whether or not the point is anywhere near
 * it — a projection with no distance test. That is the right behaviour for the
 * reference, which is known to be on the centreline, and the wrong one for a
 * continuation's entry, which is a claim that has not been checked yet.
 *
 * Without this bound a response naming a street twelve degrees away is accepted,
 * the walk steps onto it, and the rest of the selection is laid out on a road in
 * another city: no error, a plausible-looking route, and a reviewer who has to
 * spot it by comparing against the map.
 *
 * Five metres is a kerb, which is what "the node these two ways share" can be
 * worth when the two geometries come from different OSM ways and their endpoints
 * are close rather than identical. A correct answer projects to zero.
 */
export const LAY_ENTRY_TOLERANCE_METERS = 5;

export interface LayLimits {
    /**
     * Most corners the walk may cross, counted across the whole drop rather than
     * per direction.
     *
     * Total, because the cost being capped is the reviewer's attention and a drop
     * crossing a corner at each end costs twice as much to check as one crossing
     * one. It also keeps the number of round trips after the mouseup predictable:
     * one.
     */
    maxCrossings: number;
}

/**
 * What one street did in a lay, for the message the reviewer reads.
 *
 * Same shape and same reason as `RelayStreetReport`: the number on screen has to
 * be the number in the geometry. A street 480 m long that received eleven of the
 * selection's twenty vertices has not failed, and a report that said "9 vertices
 * dropped" without saying why would read as a bug.
 */
export interface LayStreetReport {
    roadId: number | null;
    name: string | null;
    /** How many of the selection's vertices were placed on it. */
    placed: number;
    /** How far the street runs from where the walk entered it, in metres. */
    streetMeters: number;
}

export interface LayResult {
    coordinates: Coordinates;
    /** Every vertex that moved, in the order the selection was laid. */
    placed: VertexRef[];
    /**
     * Every vertex removed, because it asked for a chainage past the end of the
     * way.
     *
     * Reported as vertices rather than silently applied, and it is the one result
     * here that touches `line_transfers`: those rows address vertices by index, so
     * removing one re-points every transfer above it at a different vertex. The
     * editor marks the line as adjusted on save and `transfers:compute` has to run
     * before a bundle ships, which is the same cost any geometry change already
     * carries — but a reviewer who is not told which vertices went cannot undo it
     * selectively either.
     */
    dropped: VertexRef[];
    /** One entry per street used, in the order the walk reached them. */
    streets: LayStreetReport[];
    /** What stood between the two lookups, or why a lay cannot be applied. */
    blocked: SelectionBlock | null;
}

/**
 * A lay that did not happen, with the route handed back by identity.
 *
 * The blocked case carries a reason rather than a boolean, for the reason
 * `describeRelayHint` does: "not enough selected" is fixed by selecting more and
 * "crosses a segment" cannot be, and a hint that named only the first would send
 * a reviewer off to select more vertices they already have.
 */
function layNothing(
    coordinates: Coordinates,
    blocked: SelectionBlock | null = null,
): LayResult {
    return {
        coordinates,
        placed: [],
        dropped: [],
        streets: [],
        blocked,
    };
}

/** How far a street's part runs from its own start, in metres. */
function partLengthMeters(part: StreetPart): number {
    return part.chainage[part.chainage.length - 1] - part.chainage[0];
}

/**
 * Where a street's part runs out in the direction the walk is going, in this
 * module's order and out of the metric frame.
 *
 * The end rather than the start, chosen by the direction of travel: a walk heading
 * away from the reference runs off one end and a walk heading towards it runs off
 * the other, and the continuation is a question about the node at that end. Asking
 * from the wrong one returns a street that begins behind the route — which is a
 * plausible-looking answer and the wrong direction entirely.
 */
function endOfPart(
    part: StreetPart,
    direction: PropagationDirection,
    scale: number,
): Position {
    const edge = direction === 1 ? part.points.length - 1 : 0;

    return [part.points[edge][0] / scale, part.points[edge][1]];
}

/**
 * The compass bearing a walk leaves a street's part at, in degrees clockwise from
 * north.
 *
 * The direction of the *way*, so the difference between the last two points of the
 * part when the walk is heading away from the reference and the first two when it
 * is heading towards it. Not the bearing of the reference to the end: that is the
 * straight line across the street, which on a bend of more than a few degrees is
 * not the direction the route is travelling, and the difference is what tells a
 * continuation from the street just travelled.
 *
 * Null when the part cannot say — fewer than two points, which `measureStreet`
 * already filters out, or a degenerate leg at the end, which a street's geometry
 * does contain where a way doubles back on itself. A null costs the crossing and
 * nothing else, which is the same outcome as a lookup that finds nothing.
 */
function bearingAtEnd(
    part: StreetPart,
    direction: PropagationDirection,
): number | null {
    const last = part.points.length - 1;
    const to = direction === 1 ? last : 0;
    const from = direction === 1 ? last - 1 : 1;

    const a = part.points[from];
    const b = part.points[to];

    if (!a || !b) {
        return null;
    }

    const east = b[0] - a[0];
    const north = b[1] - a[1];

    // atan2 rather than a quadrant table, because the frame is already metric and
    // a bearing out of it is one call. The result is folded into [0, 360) because
    // that is what the request documents and because a negative compass direction
    // is a way of writing the same angle that a reader would have to translate.
    const degrees = (Math.atan2(east, north) * 180) / Math.PI;

    return ((degrees % 360) + 360) % 360;
}

/** One vertex of the selection, with where it sits along the selection. */
interface LayStep {
    ref: VertexRef;
    /**
     * Metres from the reference, signed by route direction: negative before it,
     * positive after.
     *
     * The one number this feature preserves. It is measured along the selection's
     * own path rather than as a straight line between vertices, because the point
     * is that the spacing survives — and a stretch that turns a corner has vertices
     * 40 m apart along the route that are 10 m apart through the air.
     */
    offset: number;
}

/**
 * The selection in route order, each vertex carrying its distance from the
 * reference along the selection's own path.
 *
 * A prefix sum over the span, so the total is one pass and the answer for every
 * vertex is a subtraction rather than another walk. `distanceMeters` is used
 * directly rather than the metric frame by hand, because it is the one function
 * here that takes raw positions and applies the frame itself — which is exactly
 * what this is.
 *
 * Null when the reference is not among the selection, which is a stale ref rather
 * than an error: the same thing a propagation does with it, for the same reason.
 */
function laySteps(
    coordinates: Coordinates,
    selection: VertexRef[],
    reference: VertexRef,
): LayStep[] | null {
    const segment = coordinates[reference.segment];

    if (segment === undefined) {
        return null;
    }

    const ordered = [...selection]
        .filter((ref) => ref.segment === reference.segment)
        .sort((a, b) => a.index - b.index);

    // The prefix is keyed by index into `segment` and starts at the reference, so
    // only the span between the selection's ends is ever measured.
    const anchor = segment[reference.index];

    if (!anchor) {
        return null;
    }

    const steps: LayStep[] = [];

    for (const ref of ordered) {
        const from = Math.min(ref.index, reference.index);
        const to = Math.max(ref.index, reference.index);
        let walked = 0;

        for (let i = from; i < to; i += 1) {
            const a = segment[i];
            const b = segment[i + 1];

            if (!a || !b) {
                return null;
            }

            walked += distanceMeters([a[0], a[1]], [b[0], b[1]]);
        }

        steps.push({
            ref,
            offset: ref.index >= reference.index ? walked : -walked,
        });
    }

    return steps;
}

/**
 * Lay a selected stretch of route along the street its reference vertex snapped
 * to, keeping the spacing the selection already had.
 *
 * The gap this closes. A multi-vertex drag applies one rigid offset, so the
 * reference lands on the street and the rest of the selection lands wherever the
 * translation puts it — which for anything wider than a couple of blocks is
 * nowhere near the network. The propagation that follows cannot repair it: it
 * places each neighbour by its own perpendicular projection, which preserves
 * neither spacing nor shape, and it stops at the first vertex too far off. So a
 * reviewer dragging thirty vertices onto a street gets one vertex on it and a
 * kink where the rest gave up.
 *
 * This replaces the shape of the selection with the shape of the street and keeps
 * only the spacing. That is a deliberate trade and not a refinement of the drag:
 * after a drop the stretch is no longer what was dragged, it is the road. The
 * offset is what the previous step did with the drag; this is the step after it,
 * and the reviewer asked for the road.
 *
 * Three rules keep it from doing damage:
 *
 * A vertex past the end of the way is **dropped, never clamped**. Clamping would
 * put it at the far end of the street — the vertex teleports the length of a
 * block, which is the worst thing this function could do and the one the previous
 * generation of it did. Dropping is why this one can remove vertices at all, and
 * the count is reported rather than applied quietly.
 *
 * Once the walk runs out of street it either crosses one corner or stops. Which
 * one it did is in the result, because a stretch that quietly stops halfway is
 * indistinguishable from one that quietly dropped four vertices.
 *
 * And the endpoints of the selection are moved like everything else. A lay has no
 * privileged ends: the reference is where the walk starts, not a vertex held
 * still, and holding it still would leave a gap at the exact point the reviewer
 * aimed at.
 *
 * The walk never crosses a segment boundary, for the reason it never does
 * anywhere else here: a MultiLineString's parts are not a continuation of each
 * other, so there is no leg to measure a spacing along across one.
 *
 * No offset limit, and that is worth stating because every other place in this
 * module has one. The vertices are placed at the spacing the selection already
 * had, so the distance from each one to the street is a consequence of the shape
 * the reviewer dragged rather than a correction being made — and a limit would
 * reject exactly the case the feature exists for, where a whole selection is
 * being put onto a street it was never near. What decides whether the lay happens
 * at all is `decideSnap`, on the reference, before this runs.
 */
export async function laySelectionAlongStreet(
    coordinates: Coordinates,
    selection: VertexRef[],
    reference: VertexRef,
    street: LayStreet | null,
    limits: LayLimits,
    continueStreet?: ContinueStreet,
): Promise<LayResult> {
    const blocked = resampleBlock(selection);

    if (blocked !== null || !street?.line) {
        return layNothing(coordinates, blocked);
    }

    const steps = laySteps(coordinates, selection, reference);

    if (steps === null || steps.length === 0) {
        return layNothing(coordinates);
    }

    const raw = coordinates[reference.segment]?.[reference.index];

    if (!raw) {
        return layNothing(coordinates);
    }

    // Rebuilt rather than narrowed: the stored positions are plain arrays, and
    // handing one of those to a function typed on a two-tuple is a cast that reads
    // as if the length had been checked. It has not.
    const referencePosition: Position = [raw[0], raw[1]];

    const scale = longitudeScale(referencePosition[1]);
    const opened = measureStreet(street.line, referencePosition[1]);
    const start = locateOnStreet(opened, referencePosition, scale);

    if (start === null) {
        return layNothing(coordinates);
    }

    /** One street the walk is standing on, and where on it the walk stands. */
    interface Walk {
        street: LayStreet;
        part: StreetPart;
        /** Chainage on `part` the walk stands at. */
        anchor: number;
        /** The step offset that chainage corresponds to, so the two can be added. */
        reached: number;
    }

    const walk: Walk = {
        street,
        part: start.part,
        anchor: start.chainage,
        reached: 0,
    };

    const streets: LayStreetReport[] = [];
    const reportByKey = new Map<string, LayStreetReport>();

    const reportFor = (on: LayStreet, part: StreetPart): LayStreetReport => {
        // Keyed by identity where there is one and by name where there is not,
        // because two anonymous lanes either side of a crossing are the same
        // street only by accident, and counting one of them twice would print it
        // twice.
        const key = on.roadId === null ? `n:${on.name}` : `r:${on.roadId}`;
        const existing = reportByKey.get(key);

        if (existing) {
            return existing;
        }

        const fresh: LayStreetReport = {
            roadId: on.roadId,
            name: on.name,
            placed: 0,
            streetMeters: partLengthMeters(part),
        };

        reportByKey.set(key, fresh);
        streets.push(fresh);

        return fresh;
    };

    const placements = new Map<string, Position>();
    const placed: VertexRef[] = [];
    const dropped: VertexRef[] = [];

    const crossings = { spent: 0 };

    /**
     * Step onto the continuation of the current street, or answer false.
     *
     * Every way this can fail answers false and lets the caller drop the rest of
     * that side: no callback at all, a response with no geometry, a geometry with
     * no usable part, an entry point the new street does not contain. None of them
     * is worth a different behaviour at the call site — the reviewer is told the
     * vertices were dropped either way, and a corner they have to look at is
     * better than one we guessed.
     *
     * The accounting that matters is `reached`. It is the step offset the walk stood
     * at when it left this street, and it has to be that offset rather than the one
     * that triggered the crossing: the vertex that ran out of road is asking for
     * more than the street had, so using its offset as the walk's position would
     * place it at the new street's entry point instead of the metres beyond it.
     * It is derived from the chainage the walk left at, measured against the
     * reference's own chainage on the first street, because that is the only place
     * the two numbers are on the same scale.
     */
    const cross = async (direction: PropagationDirection): Promise<boolean> => {
        if (
            continueStreet === undefined ||
            crossings.spent >= limits.maxCrossings
        ) {
            return false;
        }

        const leftAt =
            direction === 1
                ? partLengthMeters(walk.part)
                : walk.part.chainage[0];

        const bearing = bearingAtEnd(walk.part, direction);

        if (bearing === null) {
            return false;
        }

        const cont = await continueStreet({
            street: walk.street,
            from: endOfPart(walk.part, direction, scale),
            direction,
            bearing,
        });

        crossings.spent += 1;

        if (!cont?.line) {
            return false;
        }

        const parts = measureStreet(cont.line, referencePosition[1]);
        const enter = locateOnStreet(parts, cont.entry, scale);

        if (parts.length === 0 || enter === null) {
            return false;
        }

        // Located rather than trusted. `locateOnStreet` projects whatever it is
        // given onto the geometry and answers with the nearest point on it, with no
        // distance test of its own, so an entry point from a response naming some
        // other street entirely would be accepted and the walk would carry on
        // there. See LAY_ENTRY_TOLERANCE_METERS for what the five metres are.
        if (
            metricDistance(
                [cont.entry[0] * scale, cont.entry[1]],
                positionAtChainage(enter.part, enter.chainage),
            ) > LAY_ENTRY_TOLERANCE_METERS
        ) {
            return false;
        }

        walk.street = cont;
        walk.part = enter.part;
        walk.anchor = enter.chainage;
        walk.reached = leftAt - start.chainage;

        return true;
    };

    // Backwards first, for the reason the propagation does it that way: the
    // message reads the route in the order the reviewer reads it, and the crossing
    // budget goes to the earlier half of the selection if it goes anywhere.
    //
    // The reference is not in either list. It was placed by the snap, which is the
    // step before this one and the only one the reviewer watched happen — the walk
    // starts from it rather than moving it, and holding it still is what leaves a
    // gap at the exact point they aimed at.
    for (const direction of [-1, 1] as const) {
        const ordered = steps
            .filter((step) =>
                direction === 1 ? step.offset > 0 : step.offset < 0,
            )
            .sort((a, b) =>
                direction === 1 ? a.offset - b.offset : b.offset - a.offset,
            );

        for (const [i, step] of ordered.entries()) {
            // Whether this vertex is still on the street the walk is on, and it is
            // the tolerance rather than a bare comparison because the chainage
            // asked for is a sum of float distances — see the constant for why
            // refusing on the last bit is the expensive answer.
            const onStreet = () => {
                const target = walk.anchor + (step.offset - walk.reached);

                return (
                    target >= -LAY_EDGE_TOLERANCE_METERS &&
                    target <=
                        partLengthMeters(walk.part) + LAY_EDGE_TOLERANCE_METERS
                );
            };

            if (!onStreet() && !(await cross(direction))) {
                // Everything further in this direction asks for even more and the
                // offsets only grow, so the rest of this side goes with it — each
                // one would pay for its own refusal of the same missing street.
                for (const rest of ordered.slice(i)) {
                    dropped.push(rest.ref);
                }

                break;
            }

            const position = positionAtChainage(
                walk.part,
                walk.anchor + (step.offset - walk.reached),
            );

            placements.set(`${step.ref.segment}:${step.ref.index}`, [
                position[0] / scale,
                position[1],
            ]);
            placed.push(step.ref);
            reportFor(walk.street, walk.part).placed += 1;
        }
    }

    if (placed.length === 0) {
        return { ...layNothing(coordinates), streets };
    }

    // Placements first, removals second, and the order is not interchangeable: a
    // removal renumbers everything after it, so the placements still written in the
    // first pass would be addressing the wrong vertices by the time they landed.
    //
    // One call, never a loop. `removeVertexAt` drops a whole segment when it is
    // left with two positions, which moves the segment field of every later
    // reference — so the second removal in such a loop would already be aimed at
    // the wrong vertex.
    const written = coordinates.map((part) => [...part]);

    for (const [key, position] of placements) {
        const [segIdx, pointIdx] = key.split(':').map(Number);
        written[segIdx][pointIdx] = position;
    }

    const removal = removeVertices(written, dropped);

    return {
        coordinates: removal.coordinates,
        placed,
        dropped: removal.removed > 0 ? dropped : [],
        streets,
        blocked: null,
    };
}

/**
 * A validated answer about one street, from either of the two lookups.
 *
 * Lives here rather than in the wire module because it is a domain shape � a
 * street, in this module's own coordinate order, with the geometry already
 * checked � and the wire module's job is to produce one. The dependency runs
 * that way already, so putting it here keeps it pointing one direction.
 */
export interface StreetLookup {
    /** The road's identity, which is what keeps one street's cursor its own. */
    roadId: number;
    name: string | null;
    /** How many neighbouring points recognised this street. */
    votes: number;
    /** How far the point sits from it, in metres. */
    distance: number;
    /** The centreline, or null when the response carried nothing usable. */
    line: Coordinates | null;
}

/**
 * How far apart two vertices on the same street have to end up, in metres.
 *
 * The project already had a number for this and this is it: adding a vertex
 * within ten metres of an existing one is refused, so ten metres is what a
 * reviewer already expects two distinct points on a route to look like. Reusing
 * it rather than inventing a second figure is why this is not a setting.
 *
 * It applies *within one street* and nowhere else, and that is the rule that
 * makes a corner work. Where a route turns, the street it came along ends and
 * the street it turned onto begins a metre or two away, and those two vertices
 * belong exactly where they are. Enforcing the minimum across a street change
 * would shove them ten metres down their own streets and flatten every turn in
 * the selection into a rounded corner that is not on the map.
 */
export const RELAY_MIN_SPACING_METERS = 10;

export interface RelayLimits {
    /**
     * Furthest a vertex may sit from a street and still be moved onto it, in
     * metres.
     *
     * The snap preset's threshold, for the same reason it is on a propagation: it
     * is the one number the reviewer has already calibrated. A vertex beyond it is
     * somewhere the imported network does not reach, and those are left exactly
     * where they are rather than pulled towards the nearest thing that happens to
     * be nearby.
     */
    maxOffset: number;
    /** The separation enforced between two vertices on the same street. */
    minSpacing: number;
}

export function relayLimitsFor(threshold: number): RelayLimits {
    return {
        maxOffset: threshold,
        minSpacing: RELAY_MIN_SPACING_METERS,
    };
}

/** What one street was asked to do, for the message the reviewer reads. */
export interface RelayStreetReport {
    roadId: number;
    name: string | null;
    /** How many vertices were moved onto it. */
    placed: number;
    /**
     * The smallest separation actually achieved between two vertices on it, or
     * null while only one has been placed and there is no pair to measure.
     *
     * Reported because the target cannot always be met: a street shorter than the
     * number of vertices put on it cannot give them ten metres each. Printing the
     * target when the result was four metres would be a claim about the geometry
     * that the reviewer has no way to check.
     */
    closestSpacing: number | null;
}

export interface RelayResult {
    coordinates: Coordinates;
    /** Every vertex that moved, in the order the selection was re-laid. */
    moved: VertexRef[];
    /** One entry per street used, in the order first reached. */
    streets: RelayStreetReport[];
    /** How many selected vertices had no street to move onto. */
    unmatched: number;
}

/**
 * A position a given number of metres along a street, clamped to its end.
 *
 * Distinct from pointAtChainage, which is told which segment to look in and is
 * used where the segment is already known. This one does not know, and answers
 * the question a caller placing a vertex actually has: put it here, and if that
 * is past the end of the way then put it at the end. Clamping is the right
 * answer for that caller, because it has already decided the vertex belongs on
 * this street, and the alternative is leaving it off the street entirely.
 */
function positionAtChainage(part: StreetPart, chainage: number): Position {
    const last = part.points.length - 2;

    for (let i = 0; i < last; i += 1) {
        if (chainage <= part.chainage[i + 1]) {
            return pointAtChainage(part, i, chainage);
        }
    }

    // The last segment, reached with the chainage as asked for rather than the
    // segment's own end.
    //
    // It used to pass `part.chainage[last + 1]` here, on the reasoning that a
    // chainage past the loop has to be past the end and clamping is the answer.
    // The loop is `i < last`, so it never covers the last segment: a chainage
    // anywhere inside it fell through and was answered with the end of the way.
    // Every vertex the walk put in a street's final segment was therefore placed
    // on its last vertex instead — three vertices on one point at the end of a
    // block, which is the exact pile-up the spacing rules exist to prevent, and
    // `pointAtChainage` clamps on its own so nothing is lost by asking properly.
    return pointAtChainage(part, Math.max(0, last), chainage);
}

/**
 * Re-lay a selected stretch of route onto the street network, one vertex at a
 * time.
 *
 * The two things that came before this both *move* geometry. A drag applies one
 * rigid offset to the selection; a propagation walks a few vertices onto the
 * street a dropped vertex happened to land on. Neither can reshape anything, and
 * that is precisely why a straight run drawn over a road that curves cannot be
 * fixed by either � no offset turns a line into a curve. This projects each
 * vertex onto its own street, so the shape comes from the network rather than
 * from the drag.
 *
 * Per vertex is also what lets a selection that turns a corner come out right.
 * The point before the corner belongs to the street the route came along, the
 * point after belongs to the one it turned onto, and neither is wrong. A rule
 * insisting on one street for the whole selection would have to be wrong about
 * one of them.
 *
 * Two invariants make the result a route rather than a pile of points.
 *
 * Each street keeps a cursor, so a vertex can never land behind one already
 * placed on that same street � including when it is not adjacent in the route,
 * since a street can be left and rejoined further along. Without it, a vertex
 * sitting nearer the start of its street would send the route backwards down the
 * road it is already on.
 *
 * And two vertices on one street are kept `minSpacing` apart, which is the
 * answer to a reviewer's worry about points piling up. The rule is per street
 * precisely so that a corner is exempt, because there two vertices legitimately
 * a metre apart *are* the turn.
 *
 * The target can be unmeetable � a street shorter than the vertices put on it �
 * and then it is reduced to what fits rather than refused, because the
 * alternatives are overlapping points or a correction the reviewer cannot make
 * in one action. What was really achieved is reported, so the number on screen
 * is the number in the geometry.
 *
 * A vertex with no street inside the limit keeps its position and does not move
 * any street's cursor. Nothing is invented for it, so a selection that turns out
 * to be mostly off-network comes back mostly untouched.
 *
 * Never adds or removes a vertex, so point indexes survive and precomputed
 * transfers stay valid � the property that makes this safe to offer on a route
 * of five hundred vertices.
 *
 * Returns the input untouched when nothing is moved, by identity rather than a
 * copy, for the same reason the propagation does.
 */
export function relaySelectionOntoNetwork(
    coordinates: Coordinates,
    selection: VertexRef[],
    lookups: StreetLookup[],
    limits: RelayLimits,
): RelayResult {
    const nothing = (unmatched: number): RelayResult => ({
        coordinates,
        moved: [],
        streets: [],
        unmatched,
    });

    if (selection.length === 0 || lookups.length === 0) {
        return nothing(0);
    }

    // In route order, because both invariants are statements about order: a
    // cursor is about what came before, and a corner is about what comes next. A
    // selection arrives from a box gesture, which has no order at all until one
    // is given to it.
    const ordered = [...selection].sort((a, b) =>
        a.segment !== b.segment ? a.segment - b.segment : a.index - b.index,
    );

    // Where each street's walk has reached, keyed by road id. Two ways of the
    // same named street are two rows in the network and get two cursors: a cursor
    // that crossed between them would be a cursor on no street at all, since the
    // ways are not connected in the data.
    const cursors = new Map<number, number>();
    const reportByRoad = new Map<number, RelayStreetReport>();
    const streets: RelayStreetReport[] = [];
    const placed = new Map<string, Position>();
    const moved: VertexRef[] = [];
    let unmatched = 0;

    for (const [i, ref] of ordered.entries()) {
        // Matched by position, not by identity. The reply is a list in the order
        // the points were sent and the selection was sorted above, so the position
        // in the sorted selection is the only thing the two share.
        const lookup = lookups[i];
        const point = positionAt(coordinates, ref);

        if (!point || !lookup || lookup.line === null) {
            unmatched += 1;
            continue;
        }

        if (lookup.distance > limits.maxOffset) {
            unmatched += 1;
            continue;
        }

        const parts = measureStreet(lookup.line, point[1]);

        if (parts.length === 0) {
            unmatched += 1;
            continue;
        }

        const scale = longitudeScale(point[1]);
        const start = locateOnStreet(parts, point, scale);

        if (start === null) {
            unmatched += 1;
            continue;
        }

        // Bounded to the part of the street this vertex may occupy rather than
        // the whole way, and that bound is what keeps the cursor meaningful.
        // Without it a vertex near the far end of a street would project back onto
        // its near end and the route would fold onto itself. The floor is the
        // cursor itself, so a first vertex on this street is unconstrained and a
        // later one cannot be placed behind an earlier one.
        const found = closestOnPart(
            start.part,
            [point[0] * scale, point[1]],
            cursors.get(lookup.roadId) ?? 0,
            1,
            Number.POSITIVE_INFINITY,
        );

        if (found === null) {
            unmatched += 1;
            continue;
        }

        // Where the street would put it, and where the spacing rule will not let
        // it sit. The two are the same number when the projection is already
        // clear, which is the common case and the reason this does not distort a
        // route that is merely a little off.
        const end = start.part.chainage[start.part.chainage.length - 1];
        const previous = cursors.get(lookup.roadId);
        const wanted =
            previous === undefined
                ? found.chainage
                : Math.max(found.chainage, previous + limits.minSpacing);
        const target = Math.min(wanted, end);
        const separation = previous === undefined ? null : target - previous;

        const position = positionAtChainage(start.part, target);
        const next: Position = [position[0] / scale, position[1]];

        cursors.set(lookup.roadId, target);
        placed.set(`${ref.segment}:${ref.index}`, next);
        moved.push(ref);

        const report = reportByRoad.get(lookup.roadId);

        if (report) {
            report.placed += 1;
            report.closestSpacing =
                separation === null
                    ? report.closestSpacing
                    : report.closestSpacing === null
                      ? separation
                      : Math.min(report.closestSpacing, separation);
        } else {
            const fresh: RelayStreetReport = {
                roadId: lookup.roadId,
                name: lookup.name,
                placed: 1,
                closestSpacing: null,
            };

            reportByRoad.set(lookup.roadId, fresh);
            streets.push(fresh);
        }
    }

    if (moved.length === 0) {
        return nothing(unmatched);
    }

    const next = coordinates.map((part) => [...part]);

    for (const ref of moved) {
        const position = placed.get(`${ref.segment}:${ref.index}`);

        if (position) {
            next[ref.segment][ref.index] = position;
        }
    }

    return { coordinates: next, moved, streets, unmatched };
}

/**
 * The spacings a resample may be asked for, in metres.
 *
 * The type is derived from this rather than written beside it, for the reason
 * the snap presets are: the set the UI offers, the set a stored preference is
 * checked against, and the set a handler narrows to cannot disagree. A spacing
 * missing from this list does not exist anywhere else either.
 *
 * Every one of them is an order of magnitude above `RELAY_MIN_SPACING_METERS`,
 * and that is a constraint rather than a coincidence. A resample able to place
 * vertices ten metres apart would contradict the separation the re-lay
 * enforces, and a reviewer could build a route that the re-lay then reported as
 * too crowded and asked them to fix.
 */
export const RESAMPLE_SPACING_METERS = [100, 200, 300] as const;

/** How far apart a resample is asked to leave two vertices, in metres. */
export type ResampleSpacing = (typeof RESAMPLE_SPACING_METERS)[number];

/**
 * Below this, in degrees, two positions count as the same point.
 *
 * Interpolation error on a boundary that lands exactly on a vertex is a few
 * parts in a hundred million, which is a fraction of a millimetre — so this is
 * about refusing to call a vertex duplicated because of float noise, not about
 * being precise.
 */
const RESAMPLE_EPSILON = 1e-7;

/**
 * Distance in metres between two route positions, given as raw `[lng, lat]`.
 *
 * Distinct from metricDistance, which takes positions already in the metric
 * frame and says so in its name precisely because reading them the other way is
 * silent: a raw pair treated as metric is a point at the wrong longitude, and
 * the only symptom is a resample that spaces its new vertices by the wrong
 * amount. The frame is applied here, once, at the point of comparison, which is
 * where this module says a limit in metres has to be decided.
 *
 * Scaled at the midpoint latitude of the pair rather than at either end, so a
 * leg is measured on the scale that applies to the ground it actually covers
 * instead of whichever of its two ends the code happened to read first. Over one
 * block the difference is centimetres; along a route that climbs out of the
 * city it is not, and a per-pair average is the honest answer at both.
 */
export function distanceMeters(a: Position, b: Position): number {
    const scale = longitudeScale((a[1] + b[1]) / 2);

    return metricDistance([a[0] * scale, a[1]], [b[0] * scale, b[1]]);
}

/**
 * A position `metres` along the leg from `a` to `b`, or null past its end.
 *
 * Null rather than a clamp, for the reason projectOnSegment reports its
 * parameter unclamped: overshooting a leg is how the caller knows to stop
 * walking, and a clamped answer would place a point on the vertex the route
 * already has.
 */
function pointAlongLeg(
    a: Position,
    b: Position,
    metres: number,
): Position | null {
    const legLength = distanceMeters(a, b);

    if (legLength <= 0 || metres > legLength) {
        return null;
    }

    const t = metres / legLength;

    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** What a re-spacing did, said in full because it rewrites the vertex list. */
export interface ResampleResult {
    coordinates: Coordinates;
    /** How many vertices the re-spacing introduced. */
    added: number;
    /** How many of the selected vertices it dropped. */
    removed: number;
    /**
     * True when the stretch could not be filled in whole spacings and the last
     * leg came out short.
     *
     * The honest answer to a target the geometry cannot meet: the tail is
     * whatever is left over, and saying so is better than a reviewer measuring
     * the final gap, finding eighteen metres, and concluding the tool rounds
     * silently.
     */
    raggedTail: boolean;
}

/**
 * Re-space a selected stretch of route to roughly equal intervals.
 *
 * The one action in this editor that changes how many vertices a route has
 * without changing where the line runs. A drag moves geometry, a propagation
 * walks a few vertices onto a street, a re-lay bends a straight run into a
 * curve — none of them touch how the vertices are distributed along it. This
 * does, which is what makes it the answer to a stretch a reviewer placed by hand
 * at four metres and then twelve hundred.
 *
 * It is a re-spacing and deliberately not a simplification. Nothing is dropped
 * for carrying no shape: a vertex at a corner survives even two metres from its
 * neighbour, because a re-spacing that flattened corners would be a different
 * tool wearing a destructive name. The interior vertices are cleared and the
 * stretch is walked again from scratch.
 *
 * Because every new point is interpolated along a leg that already exists, all
 * of them are collinear with the line the reviewer drew. The route's shape is
 * untouched — this changes the sample rate, not the path. That is the property
 * the re-lay does not have, and it is why this is safe to offer on a route of
 * five hundred vertices and why it needs no network round trip at all.
 *
 * The cost is the thing worth knowing before pressing it. `line_transfers`
 * addresses vertices by index, so re-spacing a line invalidates every transfer
 * computed for it and `transfers:compute` has to run again before the offline
 * bundle ships. No other edit here moves those indexes, which is exactly why the
 * re-lay's own contract is that it never adds or removes a vertex.
 *
 * Measured along the route rather than between endpoints, because the
 * difference is invisible right up until it is a disaster. A straight-line walk
 * across a selection that turns a corner places the new vertices off the
 * corner, cutting the inside of the turn and drawing a route nobody approved.
 *
 * The first and last selected vertices are held exactly where they are. They are
 * shared with the stretches either side, so moving one edits geometry outside
 * the selection — not what a reviewer who boxed a stretch and pressed a button
 * asked for.
 *
 * Refuses a selection spanning two segments. A route's MultiLineString parts are
 * not a continuation of each other, so there is no leg to walk between the end
 * of one and the start of the next; bridging that gap is what a re-spacing must
 * never do. Two vertices is the floor for the same reason — one vertex has no
 * stretch to re-space.
 *
 * Returns the input untouched, by identity, when the stretch already complies.
 * A reviewer who presses the button twice should get a page that is not dirty
 * the second time, not a rewrite of coordinates that differ in the ninth
 * decimal.
 */
export function resampleSelection(
    coordinates: Coordinates,
    selection: VertexRef[],
    spacing: ResampleSpacing,
): ResampleResult {
    const nothing: ResampleResult = {
        coordinates,
        added: 0,
        removed: 0,
        raggedTail: false,
    };

    const sorted = [...selection].sort((a, b) =>
        a.segment !== b.segment ? a.segment - b.segment : a.index - b.index,
    );

    // Deduplicated in route order. A marquee can hand back the same vertex only
    // if two boxes overlapped, but the cost of finding out mid-walk is a
    // duplicated endpoint rather than an error.
    const ordered: VertexRef[] = [];

    for (const ref of sorted) {
        const previous = ordered[ordered.length - 1];

        if (
            previous === undefined ||
            previous.segment !== ref.segment ||
            previous.index !== ref.index
        ) {
            ordered.push(ref);
        }
    }

    const segment = ordered[0]?.segment;
    const source = segment === undefined ? undefined : coordinates[segment];

    if (
        ordered.length < 2 ||
        source === undefined ||
        ordered.some((ref) => ref.segment !== segment)
    ) {
        return nothing;
    }

    const from = ordered[0].index;
    const to = ordered[ordered.length - 1].index;

    if (from < 0 || to >= source.length || to <= from) {
        return nothing;
    }

    const at = (index: number): Position | null => {
        const point = source[index];

        return point ? [point[0], point[1]] : null;
    };

    const start = at(from);
    const end = at(to);

    if (!start || !end) {
        return nothing;
    }

    // The walk. `consumed` is the distance already placed as a vertex, `walked`
    // the distance covered by legs so far, and a boundary belongs on the leg
    // that crosses it — which is what keeps a new vertex on the road the
    // reviewer drew rather than across it.
    const resampled: Position[] = [start];
    let consumed = 0;
    let walked = 0;

    for (let i = from; i < to; i += 1) {
        const a = at(i);
        const b = at(i + 1);

        if (!a || !b) {
            return nothing;
        }

        const leg = distanceMeters(a, b);

        // A zero-length leg is not a road. Skipped without advancing, so a
        // boundary that falls inside it is placed on the next real leg.
        if (leg <= 0) {
            continue;
        }

        while (consumed + spacing <= walked + leg) {
            const point = pointAlongLeg(a, b, consumed + spacing - walked);

            if (!point) {
                break;
            }

            resampled.push(point);
            consumed += spacing;
        }

        walked += leg;
    }

    // The end is a vertex the reviewer already had, so it is always kept — and
    // it is the only one that can be a no-op, because the walk can land a point
    // on it exactly.
    const tail = distanceMeters(resampled[resampled.length - 1], end);
    const raggedTail =
        tail > RESAMPLE_EPSILON && tail < spacing - RESAMPLE_EPSILON;

    if (tail > RESAMPLE_EPSILON) {
        resampled.push(end);
    } else {
        resampled[resampled.length - 1] = end;
    }

    // Both endpoints are held, so every interior original is gone and every
    // interior point now in the list is one this function created. Counting them
    // off the ends is more reliable than tracking them through the walk.
    const removed = to - from - 1;
    const added = resampled.length - 2;

    const next = coordinates.map((part) => [...part]);

    next[segment] = [
        ...source.slice(0, from),
        ...resampled,
        ...source.slice(to + 1),
    ];

    // Whether anything actually moved. Not by count: a stretch already at the
    // interval still gets its interior vertices replaced — with copies of
    // themselves — so both counts are non-zero and the only honest test is
    // whether the geometry came out the same. A reviewer who presses the button
    // twice gets a page that is not dirty the second time.
    const unchanged =
        next[segment].length === source.length &&
        next[segment].every(
            (point, index) =>
                Math.abs(point[0] - source[index][0]) < RESAMPLE_EPSILON &&
                Math.abs(point[1] - source[index][1]) < RESAMPLE_EPSILON,
        );

    if (unchanged) {
        return nothing;
    }

    return { coordinates: next, added, removed, raggedTail };
}

/**
 * What a re-spacing did, in the reviewer's terms.
 *
 * The two counts lead rather than the interval, because those are what the
 * reviewer can check against the map — the interval is the number they chose.
 *
 * A no-op says so instead of reporting two zeroes, which would read like a
 * failure rather than like an answer.
 */
export function describeResample(
    result: ResampleResult,
    spacing: ResampleSpacing,
): string {
    if (result.added === 0 && result.removed === 0) {
        return `This stretch was already spaced every ${spacing} m.`;
    }

    const parts: string[] = [];

    if (result.removed > 0) {
        parts.push(
            `${result.removed} vertex${result.removed === 1 ? '' : 'es'} dropped`,
        );
    }

    if (result.added > 0) {
        parts.push(`${result.added} added`);
    }

    const tail = result.raggedTail
        ? ` The stretch is not a whole number of ${spacing} m intervals, so the last leg is short.`
        : '';

    return `Re-spaced to ${spacing} m: ${parts.join(', ')}.${tail}`;
}

/** What a route is measured by, for the reviewer to read off the map. */
/**
 * Why a selection cannot be acted on, or null when it can.
 *
 * Named rather than left as a boolean because the two failures are not
 * interchangeable to a reviewer. "Not enough selected" is fixed by selecting
 * more; "crosses a segment" cannot be fixed by selecting more, and a button that
 * says "select at least two vertices" while six are selected is a tool
 * confidently reporting the wrong reason.
 */
export type SelectionBlock = 'too-few' | 'spans-segments';

/**
 * What stands between a selection and a re-spacing, if anything.
 *
 * Pure, so the rule is testable away from the map. Two conditions: a single
 * vertex has no stretch to re-space, and a selection straddling two segments has
 * no leg to interpolate along — a route's MultiLineString parts are not a
 * continuation of each other, and a walk that crossed the gap would lay points
 * over ground the route never touches.
 */
export function resampleBlock(selection: VertexRef[]): SelectionBlock | null {
    if (selection.length < 2) {
        return 'too-few';
    }

    return new Set(selection.map((ref) => ref.segment)).size === 1
        ? null
        : 'spans-segments';
}

/**
 * What the re-lay will do, or why it cannot be applied.
 *
 * The blocked case leads. A tooltip the reviewer only reaches for because the
 * button is greyed out has already failed to do its job if it opens by
 * explaining what the button would do.
 */
export function describeRelayHint(block: SelectionBlock | null): string {
    if (block === 'too-few') {
        return 'Select at least two vertices to re-lay.';
    }

    return (
        'Move each selected vertex onto the street it belongs to, which is how ' +
        'a straight run drawn over a curving road gets its shape back. Points ' +
        'with no street in range stay where they are.'
    );
}

/**
 * What the re-space will do, or why it cannot be applied.
 *
 * The two refusals are spelled out rather than collapsed into "unavailable",
 * because they need different things from the reviewer: one needs a selection,
 * the other needs a different one. A hint that named only the first would send
 * someone off to select more vertices that they already have.
 */
export function describeResampleHint(block: SelectionBlock | null): string {
    if (block === 'too-few') {
        return 'Select at least two vertices to re-space.';
    }

    if (block === 'spans-segments') {
        return 'A re-space walks one segment, so the selection cannot cross a segment boundary.';
    }

    return (
        'Spread the selected stretch at even intervals along the route, ' +
        'dropping the vertices that are too close and adding the ones that are ' +
        'missing. The line itself does not move, only the points on it.'
    );
}

/**
 * What a lay did, in the reviewer's terms.
 *
 * The one message in this editor that has to carry a consequence rather than a
 * count, because a lay is the only action here that can remove a vertex. It says
 * how many went, and it says that the line's transfers will have to be recomputed
 * before a bundle ships — the second clause is the whole reason the first one is
 * allowed to exist at all, and it is the sentence `lines:export-offline` does not
 * say on its own.
 *
 * A lay that dropped nothing is reported as what it is, with the streets named:
 * a reviewer who dragged thirty vertices and sees "21 placed" needs to know they
 * are on a road and how far it runs, or the number tells them nothing about
 * whether the result is the one they wanted.
 */
export function describeLay(result: LayResult): string {
    if (result.blocked === 'too-few') {
        return 'Nothing to lay: a single vertex stays where it is dropped.';
    }

    if (result.blocked === 'spans-segments') {
        return 'Nothing to lay: the selection crosses a segment boundary.';
    }

    const streets = result.streets
        .map((street) => {
            const what = street.name ?? 'an unnamed street';

            return `${street.placed} on ${what} (${formatDistance(
                street.streetMeters,
            )} long)`;
        })
        .join(', ');

    const laid = `Laid ${result.placed.length} vertices along ${streets}.`;

    if (result.dropped.length === 0) {
        return `${laid} Spacing kept.`;
    }

    const dropped = ` ${result.dropped.length} past the end of the street were dropped, and this line's transfers now need transfers:compute before a bundle ships.`;

    return `${laid}${dropped}`;
}

/**
 * What a lay will do, or why it cannot be applied.
 *
 * The blocked case leads for the same reason it leads in the re-lay's hint: a
 * tooltip the reviewer only reaches for because the action is unavailable has
 * already failed if it opens by explaining what the action would do.
 */
export function describeLayHint(block: SelectionBlock | null): string {
    if (block === 'too-few') {
        return 'Select at least two vertices to lay them along a street.';
    }

    if (block === 'spans-segments') {
        return 'A lay walks one segment, so the selection cannot cross a segment boundary.';
    }

    return (
        'Lay the selected stretch along the street the dragged vertex lands on, ' +
        'keeping the spacing between them and taking the shape of the street. ' +
        'It crosses one corner if the street runs out. Hold Alt to drop it off ' +
        'the centreline entirely.'
    );
}

/**
 * How each preset reads to a reviewer, beside the distance it actually means.
 *
 * Kept apart from `SNAP_PRESETS` rather than folded into it: the numbers are
 * domain and the wording is presentation, and one table carrying both would make
 * a copy change look like a behaviour change.
 */
export const SNAP_PRESET_LABELS: Record<SnapPreset, string> = {
    off: 'Off',
    subtle: 'Subtle',
    normal: 'Normal',
    aggressive: 'Aggressive',
};

/**
 * The preset as the picker shows it: a name, and the distance behind it.
 *
 * The distance is the part that matters, and "Normal" alone does not say it. It
 * is also the whole reason there used to be a paragraph under this control
 * explaining what the preset would do — a reviewer could not calibrate from the
 * name, so the number was printed somewhere else and had to be found. Putting it
 * on the control is the difference between reading the setting and reading about
 * it, and it deleted thirty-one words of screen to do it.
 *
 * Derived from the preset's own threshold rather than from a second table, so the
 * number in the label cannot drift away from the number the snap will enforce.
 */
export function describeSnapPreset(preset: SnapPreset): string {
    const options = snapOptionsFor(preset);

    if (options === null) {
        return SNAP_PRESET_LABELS.off;
    }

    return `${SNAP_PRESET_LABELS[preset]} · ${options.threshold} m`;
}

/**
 * What the snap does with a drop, in detail.
 *
 * A tooltip because it is reference rather than setting: the distance is on the
 * control, and what is left here is the part a reviewer needs when a drop landed
 * somewhere unexpected and they have to work out why. The crossing rule is the
 * clearest case — it only becomes observable at an intersection where two streets
 * overlap, which is exactly when a reviewer wants the explanation and never
 * before.
 */
export function describeSnapTooltip(preset: SnapPreset): string {
    const options = snapOptionsFor(preset);

    if (options === null) {
        return 'Drops land exactly where you release them, with no street lookup.';
    }

    return (
        `Moves a drop onto a street within ${options.threshold} m of where you ` +
        'released it. When a selection is dropped on a crossing, the street more ' +
        'of the moved vertices are already on wins.'
    );
}

/**
 * What propagation does to the vertices around a drop, and what a lay does to a
 * dragged stretch.
 *
 * Its own function because the threshold is the snap's, not propagation's: both
 * are printed from one number so the two controls cannot appear to disagree
 * about how far a vertex has to be to count as "on the street".
 *
 * Both behaviours are in here because they answer the same question — what happens
 * to the vertices you did not grab — and they are the same question at two scales.
 * A single dragged vertex pulls up to four neighbours each side; a dragged stretch
 * is laid along the street at the spacing it already had. One checkbox, one
 * tooltip, two scales: the reviewer who turns it off gets a rigid offset and
 * nothing else at either size.
 *
 * The stopping clause is there because "up to 4 vertices" is otherwise a promise
 * with three ways to fall short and no way for the reviewer to tell which one
 * happened — a walk that ended after one looks identical to a bug.
 */
export function describePropagationTooltip(threshold: number): string {
    return (
        `A drop also pulls up to ${PROPAGATION_MAX_VERTICES} vertices either ` +
        `side of it onto that street, as long as each is within ${threshold} m ` +
        `of it and no more than ${PROPAGATION_MAX_ARC_METERS} m along it, and ` +
        'it stops at the first one it cannot place. Dragging a whole stretch ' +
        'instead lays it along the street at the spacing it already had, ' +
        'dropping any vertex that runs past the end and crossing one corner if ' +
        'the street stops. Hold Alt on a drop to skip this along with the snap.'
    );
}

/**
 * How to select vertices in the mode currently on.
 *
 * Behind the help toggle rather than printed under the map, which is where it
 * used to live. It was never short enough to be worth scanning — thirty-six
 * words of the same three instructions in three different modes — and a reviewer
 * who has used the editor twice already knows it. Someone who does not is the
 * audience a help button exists for.
 *
 * The mode is spelled as a literal union rather than imported from the composable
 * that defines `EditMode`, because that type is a Vue-adjacent concern and this
 * module has no business importing it. The two are structurally identical, so a
 * new mode fails to compile at the call site rather than quietly falling through
 * to the default branch below.
 */
export function describeModeHelp(
    mode: 'move' | 'add' | 'delete' | 'guide',
): string {
    if (mode === 'guide') {
        return (
            'Anchors re-lays part of a route that already exists: pin two or ' +
            'more points around the stretch that is wrong, then Preview rebuild ' +
            're-routes only the stretch between the outermost ones, and dragging ' +
            'a pinned point re-traces the batch in place. It is where a visit ' +
            'starts on a route with geometry. Trace lays tramos between control ' +
            'points instead, and shows each one dashed for you to accept or ' +
            'reject. A click near the route splits the span it lands in; a click ' +
            'away from it grows the end chosen in "Extend at". The dots on the ' +
            'map are your control points: drag one to move it, click one to ' +
            'select it, then Remove control takes it away. Where the router ' +
            'cannot find a way, place the vertex in Add mode. Escape cancels a ' +
            'pending proposal and discards anchors.'
        );
    }

    if (mode === 'add') {
        return (
            'Click on the route to add a vertex. A click within about 10 m of one ' +
            'already there is ignored, so a second click on the same spot does ' +
            'nothing.'
        );
    }

    if (mode === 'delete') {
        return (
            'Click a vertex to delete just that one. To delete several, Shift-click ' +
            'two vertices to take everything between them, or Shift-drag on the map ' +
            'to box a set out, then press Delete.'
        );
    }

    return (
        'Drag a vertex to move it. Click a vertex, then Shift-click another to ' +
        'grab everything between them, or Shift-drag on the map to box a set ' +
        'out, then drag any of them to move the whole stretch together. A drop ' +
        'snaps onto the nearest street — hold Alt to place it off the centreline.'
    );
}

/**
 * How many vertices are selected, and nothing else.
 *
 * The one piece of the old hints that stays on screen, and it stays because it
 * is state rather than instruction: it changes with what the reviewer just did,
 * and it is what tells them the next press will act on the set they can see
 * highlighted. An empty string means print nothing — "0 vertices selected" under
 * a move instruction nobody asked for is noise, and the help toggle is one click
 * away.
 *
 * The count is the whole of it, which is a change and not a trim. This used to
 * append what to do next — "drag any of them to move the whole stretch", "press
 * Delete to remove it, or Escape to deselect" — and both halves were already
 * said by `describeModeHelp`, nearly word for word. So the sentence was paying
 * for a line of vertical space, on a page whose layout moved every time it
 * appeared, in order to repeat text one click away.
 *
 * What it buys is a string short enough to render anywhere. Sixty characters
 * wrapped to two or three lines depending on how much width the action buttons
 * left it, and the count changing altered the wrap, so the readout was never the
 * same height twice. It now floats over the map as a badge, which cannot move
 * anything at all — but only because it has nothing left to wrap.
 *
 * Keep it that way. A clause added back here has to be short enough not to wrap
 * in a badge, and if there is a clause worth that much it belongs in
 * `describeModeHelp` instead.
 */
export function describeSelectionState(
    mode: 'move' | 'add' | 'delete' | 'guide',
    selected: number,
): string {
    if (mode === 'add' || mode === 'guide' || selected === 0) {
        return '';
    }

    const what = selected === 1 ? 'vertex' : 'vertices';

    return `${selected} ${what} selected`;
}

export interface RouteStats {
    /**
     * Every position the route holds, degenerate segments included.
     *
     * A one-position segment is not drawable and does not look like a vertex on
     * the map, but it still occupies a slot in the coordinates array — and that
     * array is what `line_transfers` addresses by index, so excluding it would
     * make this number disagree with the thing it exists to inform.
     */
    vertices: number;
    /**
     * Average spacing between consecutive vertices, in metres.
     *
     * Null below two positions: one vertex has no gap to average, and reporting
     * zero would read as "the points are on top of each other" rather than as
     * "there is nothing to measure yet".
     */
    spacingMeters: number | null;
    /**
     * The walked length, in metres.
     *
     * The length of the route as it is travelled, not the straight line between
     * its ends. Only ever accumulated within a segment, so it never reports
     * distance across a gap the route does not cover.
     */
    lengthMeters: number;
}

/**
 * Measure a route: how many points, how long, how far apart.
 *
 * The three numbers are one measurement shown three ways rather than three
 * facts. The count alone is not readable — 591 could be dense or sparse
 * depending on the route — while 591 vertices, 30 km and 51 m apart tell the
 * reviewer at a glance that this route is heavily sampled, which is what makes
 * the re-space interval a decision instead of a guess.
 *
 * Every sum here is per segment, and that is the part worth stating twice. A
 * route's MultiLineString parts are not a continuation of each other: there can
 * be a real gap between them, and accumulating across it would report distance
 * and spacing for ground the route never runs over. It is also why the spacing
 * is measured per leg rather than derived as `length / (vertices - 1)` — the two
 * agree exactly for a single-segment route and quietly disagree for a route of
 * several, which is the only case where being wrong looks like being right.
 */
export function routeStats(coordinates: Coordinates): RouteStats {
    let vertices = 0;
    let lengthMeters = 0;
    let legs = 0;

    for (const segment of coordinates) {
        vertices += segment.length;

        for (let i = 0; i < segment.length - 1; i += 1) {
            const a = segment[i];
            const b = segment[i + 1];

            lengthMeters += distanceMeters([a[0], a[1]], [b[0], b[1]]);
            legs += 1;
        }
    }

    return {
        vertices,
        spacingMeters: legs === 0 ? null : lengthMeters / legs,
        lengthMeters,
    };
}

/**
 * A distance in the unit that makes it readable.
 *
 * Three cuts, chosen so no magnitude is rendered in a unit that makes it sound
 * more precise or less legible than it is. Below a kilometre the metres are the
 * honest unit — "0.6 km" is harder to picture and to check against the map than
 * "640 m" — and past a hundred kilometres the decimal is noise on a number the
 * reviewer is not going to measure.
 */
export function formatDistance(meters: number): string {
    if (meters < 1000) {
        return `${Math.round(meters)} m`;
    }

    const km = meters / 1000;

    if (km < 100) {
        return `${km.toFixed(1)} km`;
    }

    return `${Math.round(km)} km`;
}

/**
 * The three measurements as one line, or an empty string for a route with
 * nothing on it.
 *
 * A function rather than template markup because vitest runs without a DOM, so
 * anything worth asserting has to live here and the component is left with
 * nothing to do but print it. The plural of "vertex", the omitted spacing clause
 * and the distance unit are all decided in one place, which is the only way they
 * stay decided the same way on the two pages that show them.
 */
export function describeRouteStats(stats: RouteStats): string {
    if (stats.vertices === 0) {
        return '';
    }

    const parts = [
        `${stats.vertices} ${stats.vertices === 1 ? 'vertex' : 'vertices'}`,
    ];

    if (stats.spacingMeters !== null) {
        // Whole metres, always. A tenth of a metre of spacing is a fiction the
        // imported network cannot resolve and nobody needs to read.
        parts.push(`${Math.round(stats.spacingMeters)} m apart`);
    }

    // Omitted for a single vertex, which is a route of no length rather than a
    // route of zero metres, and the two read very differently.
    if (stats.lengthMeters > 0) {
        parts.push(formatDistance(stats.lengthMeters));
    }

    return parts.join(' · ');
}
