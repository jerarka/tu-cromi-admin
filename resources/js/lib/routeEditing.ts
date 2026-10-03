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
 * it is already following. There is deliberately no tolerance for a vertex a
 * little behind the cursor — a route that wiggles a couple of metres has its
 * wiggling straightened, and one that genuinely doubles back is further than the
 * offset limit from anything in the window and ends the walk.
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

    for (let i = 0; i < last; i++) {
        if (chainage <= part.chainage[i + 1]) {
            return pointAtChainage(part, i, chainage);
        }
    }

    return pointAtChainage(part, Math.max(0, last), part.chainage[last + 1]);
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
 * What propagation does to the vertices around a drop.
 *
 * Its own function because the threshold is the snap's, not propagation's: both
 * are printed from one number so the two controls cannot appear to disagree
 * about how far a vertex has to be to count as "on the street".
 */
export function describePropagationTooltip(threshold: number): string {
    return (
        `A drop also pulls up to ${PROPAGATION_MAX_VERTICES} vertices either ` +
        `side of it onto that street, as long as each is within ${threshold} m ` +
        `of it and no more than ${PROPAGATION_MAX_ARC_METERS} m along it. Hold ` +
        'Alt on a drop to skip this along with the snap.'
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
export function describeModeHelp(mode: 'move' | 'add' | 'delete'): string {
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
    mode: 'move' | 'add' | 'delete',
    selected: number,
): string {
    if (mode === 'add' || selected === 0) {
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
