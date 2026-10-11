import { formatDistance, routeStats } from '@/lib/routeEditing';
import type { Line, LineSense } from '@/types/line';

/**
 * Read a route out of the Cruzero API's JSON, in our own shape.
 *
 * Their payload wraps a route in three layers — `data[].Lines[].Shape.shape_geom`
 * — and hands back a GeoJSON **LineString**, while a `lines` row stores a
 * **MultiLineString**. The wrap is the whole difference, and it has to happen
 * here rather than by loosening `GeoJsonMultiLineString`: that rule exists
 * because a malformed payload produces an empty map with no error anywhere, and
 * `GreatCircle::forGeometry()` walks two levels of nesting, so a LineString
 * reaching it ships a wrong ride length in the offline bundle instead of an
 * obvious failure.
 *
 * The file name names the vendor on purpose. The direction is not a GeoJSON
 * concept and it is not ours either: it arrives as an `_i_` / `_v_` token inside
 * `trip_id`, and reading it is the one piece of this that only works against
 * this API. Calling it something generic would be a promise the next feed
 * cannot keep.
 *
 * Every refusal here is a refusal to guess. A route drawn from transposed
 * coordinates saves cleanly, ships cleanly and is simply in the wrong
 * hemisphere — the one failure in this feature that nothing downstream would
 * ever catch.
 */

type RouteGeometry = NonNullable<Line['geo_json']>;

type Position = [number, number];

export interface BoundingBox {
    minLng: number;
    maxLng: number;
    minLat: number;
    maxLat: number;
}

export interface ConversionReport {
    /** Positions kept, after dropping consecutive duplicates. */
    vertices: number;
    /** Walked length, from the same measurement the map's badge reports. */
    lengthMeters: number;
    /** Consecutive duplicate positions removed, which the payload does contain. */
    droppedDuplicates: number;
    /** The extent of what was read, so a transposed pair is visible in numbers. */
    bbox: BoundingBox;
    /** The `trip_id` the shape came from, when the paste carried one. */
    tripId: string | null;
    /**
     * The direction this shape claims for itself.
     *
     * Null when its `trip_id` says nothing, which is a different situation from
     * saying the wrong thing: the shape may well be the right one, and the
     * report has to let the reviewer see that it is not known rather than
     * pretend the row's own sense settled it.
     */
    shapeSense: LineSense | null;
}

export type ConversionResult =
    | { ok: true; geoJson: RouteGeometry; report: ConversionReport }
    | { ok: false; reason: string };

/** One shape found in the paste, before it has been read or chosen. */
interface ShapeCandidate {
    tripId: string | null;
    coordinates: unknown;
}

const STOP_POINTS_REASON =
    'These look like stop points (lat/lon pairs), not a route. ' +
    'Paste the route itself, from Lines[].Shape.shape_geom.';

/**
 * The direction a trip carries in its identifier.
 *
 * `"38 CLOCKWISE_i_T01"` is the ida and `"38 COUNTERCLOCKWISE_v_T01"` the vuelta.
 * The clockwise/clockwise wording is deliberately not read: it describes the
 * shape's handedness, not which end a bus departs from, and the two shapes in a
 * real pair are not reversals of each other — they were traced separately and
 * share only their endpoints. The `_i_` / `_v_` token is the one that names the
 * direction.
 */
export function senseFromTripId(tripId: string): LineSense | null {
    if (/(^|_)i(_|$)/.test(tripId)) {
        return 'OUTBOUND';
    }

    if (/(^|_)v(_|$)/.test(tripId)) {
        return 'RETURN';
    }

    return null;
}

/**
 * Read one route out of pasted JSON, choosing the shape that matches a sense.
 *
 * Tolerant about the envelope on purpose: a reviewer pastes whatever the
 * browser had on screen, which may be the whole response, the transport
 * object, a single line, or the bare geometry. Refusing three of those four
 * would make the tool feel broken for no gain, since they all name the same
 * coordinates.
 *
 * The sense is the one thing it insists on. With several shapes in the paste,
 * picking the first one would hand the reviewer the other direction's route and
 * nothing would say so.
 */
export function parseCruzeroRoute(
    text: string,
    sense: LineSense,
): ConversionResult {
    if (text.trim() === '') {
        return { ok: false, reason: 'Paste a response first.' };
    }

    let payload: unknown;

    try {
        payload = JSON.parse(text);
    } catch {
        return { ok: false, reason: 'That is not valid JSON.' };
    }

    // Before any shape hunting, because a list of stops is a list and would
    // otherwise be reported as "no route found" — true, and useless to someone
    // holding a perfectly good paste of the wrong part of the response.
    if (Array.isArray(payload) && isStopRecord(payload[0])) {
        return { ok: false, reason: STOP_POINTS_REASON };
    }

    const candidates = collectCandidates(payload);

    if (candidates.length === 0) {
        return {
            ok: false,
            reason:
                'No route found. Expected a LineString, a shape_geom, or a ' +
                'response containing Lines[].Shape.shape_geom.',
        };
    }

    const chosen = chooseForSense(candidates, sense);

    if (!chosen.ok) {
        return chosen;
    }

    const positions = readPositions(chosen.candidate.coordinates);

    if (!positions.ok) {
        return positions;
    }

    const kept: Position[] = [];
    let droppedDuplicates = 0;

    for (const position of positions.value) {
        const last = kept[kept.length - 1];

        if (last && last[0] === position[0] && last[1] === position[1]) {
            droppedDuplicates += 1;

            continue;
        }

        kept.push(position);
    }

    // One part. A MultiLineString is the only shape a lines row may hold, and a
    // route that never breaks is one line string however many vertices it has.
    const coordinates: Position[][] = [kept];

    const stats = routeStats(coordinates);

    return {
        ok: true,
        geoJson: { type: 'MultiLineString', coordinates },
        report: {
            vertices: stats.vertices,
            lengthMeters: stats.lengthMeters,
            droppedDuplicates,
            bbox: boundingBox(kept),
            tripId: chosen.candidate.tripId,
            shapeSense: chosen.candidate.tripId
                ? senseFromTripId(chosen.candidate.tripId)
                : null,
        },
    };
}

/**
 * One sentence about what was just read.
 *
 * In lib/ rather than in the template because this is the only feedback the
 * reviewer gets before deciding whether to save, and it has to name the shape it
 * took: a paste that answered with the other direction would otherwise look
 * exactly like one that worked.
 */
export function describeConversion(report: ConversionReport): string {
    const from = report.tripId ? ` from ${report.tripId}` : '';
    const marker =
        report.shapeSense === null
            ? ' — it carries no direction marker, so the shape was taken on faith'
            : '';

    const dropped =
        report.droppedDuplicates > 0
            ? `, ${report.droppedDuplicates} duplicate ${
                  report.droppedDuplicates === 1 ? 'point' : 'points'
              } dropped`
            : '';

    const vertices = `${report.vertices} ${
        report.vertices === 1 ? 'vertex' : 'vertices'
    }`;

    return `Read${from}${marker}: ${vertices}, ${formatDistance(
        report.lengthMeters,
    )}${dropped}.`;
}

/**
 * The extent of the positions, for a reviewer to check against the map.
 *
 * Deliberately not folded into `routeStats()`: that function's `vertices` field
 * is contract-bound to the indexes `line_transfers` addresses, and its comments
 * show the file is kept tight on purpose. A converter that widened it to carry
 * a bounding box would make a shared contract answer a question only this tool
 * asks.
 *
 * It exists because a transposed pair cannot be caught any other way. -17.76 and
 * -63.20 are both legal longitudes and both legal latitudes, so no range check
 * sees the mistake — but the numbers here do.
 */
function boundingBox(positions: Position[]): BoundingBox {
    const bbox: BoundingBox = {
        minLng: positions[0][0],
        maxLng: positions[0][0],
        minLat: positions[0][1],
        maxLat: positions[0][1],
    };

    for (const [lng, lat] of positions) {
        bbox.minLng = Math.min(bbox.minLng, lng);
        bbox.maxLng = Math.max(bbox.maxLng, lng);
        bbox.minLat = Math.min(bbox.minLat, lat);
        bbox.maxLat = Math.max(bbox.maxLat, lat);
    }

    return bbox;
}

/**
 * Pick the one shape that claims the requested direction.
 *
 * A lone shape is taken whatever it says, because refusing it would leave the
 * reviewer with a paste that visibly contains a route and a tool that refuses
 * it. The report names the direction it actually found, which is where that
 * judgement becomes visible.
 */
function chooseForSense(
    candidates: ShapeCandidate[],
    sense: LineSense,
): { ok: true; candidate: ShapeCandidate } | { ok: false; reason: string } {
    const matching = candidates.filter(
        (candidate) =>
            candidate.tripId !== null &&
            senseFromTripId(candidate.tripId) === sense,
    );

    if (matching.length === 1) {
        return { ok: true, candidate: matching[0] };
    }

    if (matching.length > 1) {
        return {
            ok: false,
            reason: `The paste holds ${matching.length} ${senseLabel(
                sense,
            )} shapes (${matching
                .map((candidate) => candidate.tripId)
                .join(', ')}). Paste just one.`,
        };
    }

    if (candidates.length === 1) {
        return { ok: true, candidate: candidates[0] };
    }

    const found = candidates
        .map((candidate) => candidate.tripId ?? 'an unmarked shape')
        .join(', ');

    return {
        ok: false,
        reason: `The paste holds ${candidates.length} shapes (${found}) and none of them is the ${senseLabel(
            sense,
        )}. Check you are editing the direction you meant.`,
    };
}

/**
 * Read positions, or say precisely why they are not positions.
 */
function readPositions(
    value: unknown,
): { ok: true; value: Position[] } | { ok: false; reason: string } {
    if (!Array.isArray(value)) {
        return { ok: false, reason: 'The route carries no coordinates.' };
    }

    // The one shape worth naming rather than rejecting generically. Stops are in
    // the same response, hold the same coordinates, and are written as separate
    // scalars in the opposite order — so a reviewer pasting the wrong part of the
    // payload gets a route that is silently in the wrong hemisphere unless this
    // says what went wrong.
    if (isStopRecord(value[0])) {
        return { ok: false, reason: STOP_POINTS_REASON };
    }

    if (value.length < 2) {
        return {
            ok: false,
            reason: `A route needs at least two points; this one has ${
                value.length === 0 ? 'none' : 'one'
            }.`,
        };
    }

    const positions: Position[] = [];

    for (const [index, entry] of value.entries()) {
        if (
            !Array.isArray(entry) ||
            entry.length < 2 ||
            typeof entry[0] !== 'number' ||
            typeof entry[1] !== 'number'
        ) {
            return {
                ok: false,
                reason: `Point ${index + 1} is not a [longitude, latitude] pair of numbers.`,
            };
        }

        positions.push([entry[0], entry[1]]);
    }

    return { ok: true, value: positions };
}

/**
 * Every shape the paste contains, however deeply it is wrapped.
 */
function collectCandidates(payload: unknown): ShapeCandidate[] {
    if (Array.isArray(payload)) {
        const bare = candidateFromCoordinates(payload);

        return bare === null ? [] : [bare];
    }

    const record = asRecord(payload);

    if (record === null) {
        return [];
    }

    const nested: ShapeCandidate[] = [];

    if (Array.isArray(record.data)) {
        for (const entry of record.data) {
            nested.push(...collectCandidates(entry));
        }
    }

    if (Array.isArray(record.Lines)) {
        for (const entry of record.Lines) {
            const candidate = candidateFrom(asRecord(entry));

            if (candidate !== null) {
                nested.push(candidate);
            }
        }
    }

    if (nested.length > 0) {
        return nested;
    }

    const own = candidateFrom(record);

    return own === null ? [] : [own];
}

/**
 * One shape from an object that holds one, in any of the three shapes it
 * arrives in: a `Lines` entry with its `Shape`, a bare `shape_geom`, or the
 * geometry itself.
 */
function candidateFrom(
    record: Record<string, unknown> | null,
): ShapeCandidate | null {
    if (record === null) {
        return null;
    }

    const tripId = typeof record.trip_id === 'string' ? record.trip_id : null;

    for (const holder of [record.Shape, record.shape_geom, record]) {
        const geometry = geometryOf(asRecord(holder));

        if (geometry !== null) {
            return { tripId, coordinates: geometry };
        }
    }

    return null;
}

function candidateFromCoordinates(value: unknown[]): ShapeCandidate | null {
    const first = value[0];

    return Array.isArray(first) ? { tripId: null, coordinates: value } : null;
}

/** The coordinates of a GeoJSON LineString, from whatever wraps it. */
function geometryOf(record: Record<string, unknown> | null): unknown {
    if (record === null) {
        return null;
    }

    if (record.type === 'LineString' && 'coordinates' in record) {
        return record.coordinates;
    }

    const nested = asRecord(record.shape_geom);

    return nested?.type === 'LineString' && 'coordinates' in nested
        ? nested.coordinates
        : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/**
 * A passenger stop rather than a route position.
 *
 * Named in one place because it has to be recognised at two depths — a pasted
 * `intermediate[]` and a `coordinates` array holding the same objects — and two
 * definitions of "this is a stop" would eventually disagree about one of them.
 */
function isStopRecord(value: unknown): boolean {
    const record = asRecord(value);

    return (
        record !== null &&
        typeof record.lat === 'number' &&
        typeof record.lon === 'number'
    );
}

function senseLabel(sense: LineSense): string {
    return sense === 'RETURN' ? 'vuelta' : 'ida';
}
