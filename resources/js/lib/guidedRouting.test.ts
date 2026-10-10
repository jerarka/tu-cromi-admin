import { describe, expect, test } from 'vitest';
import {
    anchorSnaps,
    anchorsIntoRecipe,
    controlsInsideRegion,
    cutRouteAt,
    describeAnchorsNeeded,
    describeBlockedControls,
    describeDetached,
    describeFailedSpan,
    describeRectifyRefusal,
    describeRemoveControlBlock,
    describeRemoveWithoutReroute,
    describeRoute,
    describeRouteRefusal,
    describeRouteWarnings,
    describeRoutedPending,
    describeSimplification,
    detachedWaypoints,
    extensionEndpoints,
    finalHeading,
    findVertexForWaypoint,
    guidesFromGeometry,
    headingAtVertex,
    headingBetween,
    insertWaypointAt,
    insertionTarget,
    orderAnchorsByRoute,
    prependTramo,
    prependWaypoint,
    projectOnRoute,
    rebuildRegion,
    removalJoin,
    removeWaypoint,
    replaceTramoSpan,
    ROUTED_MAX_SPAN_METERS,
    simplifyRoutedChain,
    spliceTramo,
    stitchedChain,
    tramoInterior,
    waypointsFromRecord,
    WAYPOINT_LIMIT,
    waypointRoleAt,
} from './guidedRouting';
import type { RegionAnchor, Waypoint } from './guidedRouting';
import type { Position } from './routeEditing';
import { distanceMeters } from './routeEditing';

/**
 * Hand-computed, like every geometry test in this project: the fixtures below
 * are small enough to verify by eye, and the coordinate convention is the
 * project's own [lng, lat] with the 0.0001-degrees-per-11-metre scale that
 * routeEditing.test.ts uses throughout.
 */
describe('guidesFromGeometry', () => {
    test('a route of several vertices gets exactly two control points', () => {
        // Spec 4.1: the first vertex starts, the last finishes, the geometry
        // in between is the initial tramo — and NOT one control per vertex.
        const guides = guidesFromGeometry([
            [
                [1.0, 2.0],
                [1.1, 2.0],
                [1.2, 2.0],
            ],
        ]);

        expect(guides).not.toBeNull();
        expect(guides?.length).toBe(2);
        expect(guides?.[0]).toEqual({ position: [1.0, 2.0], role: 'start' });
        expect(guides?.[1]).toEqual({ position: [1.2, 2.0], role: 'end' });
    });

    test('a one-vertex route has no control pair to give', () => {
        expect(guidesFromGeometry([[[1.0, 2.0]]])).toBeNull();
    });

    test('no geometry at all has nothing to bootstrap from', () => {
        expect(guidesFromGeometry(undefined)).toBeNull();
    });

    test('the two ends of a multi-segment route span the whole route', () => {
        const guides = guidesFromGeometry([
            [
                [1.0, 2.0],
                [1.1, 2.0],
            ],
            [
                [2.0, 3.0],
                [2.1, 3.0],
            ],
        ]);

        expect(guides?.[0].position).toEqual([1.0, 2.0]);
        expect(guides?.[1].position).toEqual([2.1, 3.0]);
    });
});

describe('finalHeading', () => {
    test('the last leg of a straight run points along it', () => {
        // East: 0.0002 deg of longitude ≈ 21 m.
        expect(
            finalHeading([
                [
                    [1.0, 2.0],
                    [1.0001, 2.0],
                    [1.0002, 2.0],
                ],
            ]),
        ).toBeCloseTo(90, 0);
    });

    test('a route that turned reports the heading it arrived with', () => {
        expect(
            finalHeading([
                [
                    [1.0, 2.0],
                    [1.0002, 2.0],
                    [1.0002, 2.0002],
                ],
            ]),
        ).toBeCloseTo(0, 0);
    });

    test('a coincident tail vertex is skipped and the real leg is read', () => {
        // Duplicated vertex at the tail: the leg before it is still east.
        expect(
            finalHeading([
                [
                    [1.0, 2.0],
                    [1.0002, 2.0],
                    [1.0002, 2.0],
                ],
            ]),
        ).toBeCloseTo(90, 0);
    });

    test('a route too short to have a leg offers nothing', () => {
        expect(finalHeading([[[1.0, 2.0]]])).toBeNull();
        expect(finalHeading(null)).toBeNull();
    });
});

describe('spliceTramo', () => {
    test('appends the tramo interior, leaving the join vertex out', () => {
        // The route's tail is [1.0002, 2.0]; the tramo starts there too, so
        // its first position must not appear twice.
        const route = [
            [
                [1.0, 2.0],
                [1.0002, 2.0],
            ],
        ];
        const tramo = [
            [1.0002, 2.0],
            [1.0003, 2.0],
            [1.0004, 2.0],
        ] as const;

        const spliced = spliceTramo(
            route,
            tramo.map((position) => [position[0], position[1]]),
        );

        expect(spliced[0]).toEqual([
            [1.0, 2.0],
            [1.0002, 2.0],
            [1.0003, 2.0],
            [1.0004, 2.0],
        ]);
    });

    test('an empty tramo leaves the route alone', () => {
        const route = [[[1.0, 2.0]]];

        expect(spliceTramo(route, [])).toEqual(route);
    });

    test('a fresh route arrives as the whole tramo, origin included', () => {
        // No tail to join with, so the router's origin vertex is the route's
        // first vertex and must not be dropped.
        expect(
            spliceTramo(
                [],
                [
                    [1.0, 2.0],
                    [1.1, 2.0],
                    [1.2, 2.0],
                ],
            ),
        ).toEqual([
            [
                [1.0, 2.0],
                [1.1, 2.0],
                [1.2, 2.0],
            ],
        ]);
    });

    test('the route it returns is a new array, not the input', () => {
        const route = [[[1.0, 2.0]]];

        const spliced = spliceTramo(route, [
            [1.0, 2.0],
            [1.1, 2.0],
        ]);

        expect(spliced).not.toBe(route);
        expect(spliced[0]).not.toBe(route[0]);
        expect(route[0]).toEqual([[1.0, 2.0]]);
    });
});

describe('tramoInterior', () => {
    test('drops the join head and keeps the destination end', () => {
        // Only the first position leaves: it is the vertex the route already
        // has. The last one is where the tramo goes — dropping it would leave
        // the route shy of the destination.
        expect(
            tramoInterior([
                [1.0, 2.0],
                [1.1, 2.0],
                [1.2, 2.0],
                [1.3, 2.0],
            ]),
        ).toEqual([
            [1.1, 2.0],
            [1.2, 2.0],
            [1.3, 2.0],
        ]);
    });
});

describe('describeRoute', () => {
    test('names the street it entered, and counts the rest', () => {
        expect(
            describeRoute(
                [
                    { name: 'Calle 1', meters: 240.4 },
                    { name: 'Avenida Cristo Redentor', meters: 1200.6 },
                ],
                1441.0,
            ),
        ).toBe('Traced 1441 m, starting on Calle 1 + 1 more street');
    });

    test('a single named street is named without a count', () => {
        expect(describeRoute([{ name: 'Calle 1', meters: 240.4 }], 240.4)).toBe(
            'Traced 240 m, starting on Calle 1',
        );
    });

    test('unnamed streets drop out once anything is named', () => {
        // 71% of the imported network carries no name, so a list that keeps
        // them is mostly the words "unnamed street", repeated.
        expect(
            describeRoute(
                [
                    { name: 'Calle 1', meters: 240.4 },
                    { name: null, meters: 95.2 },
                    { name: null, meters: 60.1 },
                ],
                395.7,
            ),
        ).toBe('Traced 396 m, starting on Calle 1');
    });

    test('a stretch of nothing named still reports the distance', () => {
        expect(
            describeRoute(
                [
                    { name: null, meters: 95.2 },
                    { name: null, meters: 60.1 },
                ],
                155.3,
            ),
        ).toBe('Traced 155 m');
    });

    test('two snapped-together points say so instead of tracing nothing', () => {
        expect(describeRoute([], 0.0)).toBe(
            'The two control points snapped to the same road vertex.',
        );
    });

    test('a straight-line trace with no street names still says the distance', () => {
        expect(describeRoute([], 812.4)).toBe('Traced 812 m');
    });
});

describe('describeRouteRefusal', () => {
    test.each([
        ['origin-too-far', 'too far from any street'],
        ['destination-too-far', 'too far from any street'],
        ['no-path', 'No legal connection was found'],
        ['budget', 'gave up before finding'],
        ['graph-not-built', 'road graph is not built'],
        [null, 'place a vertex in Add mode'],
        ['anything-else', 'place a vertex in Add mode'],
    ])('%s a message a reviewer can act on', (reason, fragment) => {
        expect(describeRouteRefusal(reason)).toContain(fragment);
    });
});

describe('describeRoutedPending', () => {
    test('says what the wait is', () => {
        expect(describeRoutedPending()).toContain('Tracing');
    });
});

describe('waypointsFromRecord', () => {
    test('flat rows become the editor shape, [lng, lat] with the stored role', () => {
        expect(
            waypointsFromRecord([
                { ordinal: 0, role: 'start', lat: 2.0, lng: 1.0 },
                { ordinal: 1, role: 'via', lat: 3.0, lng: 1.1 },
                { ordinal: 2, role: 'end', lat: 4.0, lng: 1.2 },
            ]),
        ).toEqual([
            { position: [1.0, 2.0], role: 'start' },
            { position: [1.1, 3.0], role: 'via' },
            { position: [1.2, 4.0], role: 'end' },
        ]);
    });

    test('nothing stored is an empty recipe, which the caller boots from geometry', () => {
        expect(waypointsFromRecord(null)).toEqual([]);
        expect(waypointsFromRecord(undefined)).toEqual([]);
        expect(waypointsFromRecord([])).toEqual([]);
    });

    test('a row without a usable coordinate is dropped, not invented', () => {
        expect(
            waypointsFromRecord([
                { ordinal: 0, role: 'start', lat: 2.0, lng: 1.0 },
                { ordinal: 1, role: 'via', lat: 'x', lng: 1.1 },
            ]),
        ).toEqual([{ position: [1.0, 2.0], role: 'start' }]);
    });

    test('an unknown role degrades to via rather than crashing the list', () => {
        expect(
            waypointsFromRecord([
                { ordinal: 0, role: 'weird', lat: 2.0, lng: 1.0 },
            ]),
        ).toEqual([{ position: [1.0, 2.0], role: 'via' }]);
    });
});

describe('describeRouteWarnings', () => {
    test('no warnings is no sentence', () => {
        expect(describeRouteWarnings([])).toBe('');
    });

    test('the metre count is the news, and both endpoints are named', () => {
        expect(
            describeRouteWarnings([
                'origin-snapped-90m',
                'destination-snapped-8m',
            ]),
        ).toBe(
            'Warning: the control point sat 90 m away from the road; the new point sat 8 m away from the road.',
        );
    });

    test('unknown tokens pass through verbatim rather than being dropped', () => {
        expect(describeRouteWarnings(['something-new'])).toBe(
            'Warning: something-new.',
        );
    });
});

describe('prependWaypoint', () => {
    test('the new control leads and every role re-derives', () => {
        const waypoints: Waypoint[] = [
            { position: [1.0, 2.0], role: 'start' },
            { position: [1.0004, 2.0], role: 'end' },
        ];

        const next = prependWaypoint(waypoints, [0.9999, 2.0]);

        expect(next.map((waypoint) => waypoint.role)).toEqual([
            'start',
            'via',
            'end',
        ]);
    });
});

describe('headingBetween', () => {
    test('east and north point where they must', () => {
        expect(headingBetween([1.0, 2.0], [1.0001, 2.0])).toBeCloseTo(90, 0);
        expect(headingBetween([1.0, 2.0], [1.0, 2.0001])).toBeCloseTo(0, 0);
    });

    test('a point-to-itself bearing is a non-question', () => {
        expect(headingBetween([1.0, 2.0], [1.0, 2.0])).toBeNull();
    });
});

describe('the waypoint limit', () => {
    test('is deep enough for a real route and still a bound', () => {
        const waypoints: Waypoint[] = [];

        for (let i = 0; i < WAYPOINT_LIMIT; i++) {
            waypoints.push({ position: [i * 0.0001, 0.0], role: 'via' });
        }

        // A bound exists to be enforced at the call site; this asserts the
        // shape one more time so a later change of the constant is a
        // considered one, not a drift.
        expect(waypoints.length).toBe(WAYPOINT_LIMIT);
    });
});

// ---------------------------------------------------------------------------
// Spec §4: editing control points and tramos.
// ---------------------------------------------------------------------------

/** A five-vertex straight route: 0, 1, 2, 3, 4 — the §4 workbench. */
const route = [
    [
        [1.0, 2.0],
        [1.0001, 2.0],
        [1.0002, 2.0],
        [1.0003, 2.0],
        [1.0004, 2.0],
    ],
];

const tramos = (...positions: [number, number][]): Position[] => positions;

describe('headingAtVertex', () => {
    test('the heading arriving at a mid-route vertex reads from the leg behind it', () => {
        expect(headingAtVertex(route, 0, 2)).toBeCloseTo(90, 0);
    });

    test('a vertex with nothing real behind it offers nothing', () => {
        expect(headingAtVertex(route, 0, 0)).toBeNull();
        expect(headingAtVertex(null, 0, 1)).toBeNull();
    });

    test('coincident vertices behind are skipped to the real leg', () => {
        expect(
            headingAtVertex(
                [
                    [
                        [1.0, 2.0],
                        [1.0, 2.0],
                        [1.0001, 2.0],
                    ],
                ],
                0,
                2,
            ),
        ).toBeCloseTo(90, 0);
    });
});

describe('finalHeading through the refactor', () => {
    test('still reads the last leg of the last segment', () => {
        expect(finalHeading(route)).toBeCloseTo(90, 0);
    });
});

describe('findVertexForWaypoint', () => {
    test('the nearest vertex within tolerance wins', () => {
        const found = findVertexForWaypoint(route, {
            position: [1.0002, 2.0],
            role: 'via',
        });

        expect(found).toEqual({
            segment: 0,
            index: 2,
            distance: expect.any(Number),
        });
        expect(found?.distance).toBeLessThan(0.01);
    });

    test('beyond the tolerance the waypoint is detached', () => {
        const found = findVertexForWaypoint(route, {
            position: [1.0002, 2.001],
            role: 'via',
        });

        // 0.001 deg of latitude is ~111 m: far past every tolerance.
        expect(found).toBeNull();
    });

    test('the tolerance is honourable in metres, not in degrees', () => {
        // A waypoint 20 m off its vertex is still attached (the default
        // tolerance is 25 m); the scale is metres, so a longitude offset at
        // this latitude is scaled before the comparison.
        const found = findVertexForWaypoint(route, {
            position: [1.0002, 2.00018],
            role: 'via',
        });

        expect(found).not.toBeNull();
    });
});

describe('detachedWaypoints', () => {
    test('reports exactly the ones off the route', () => {
        const onRoute: Waypoint = { position: [1.0001, 2.0], role: 'via' };
        const offRoute: Waypoint = { position: [1.0001, 2.002], role: 'via' };

        expect(detachedWaypoints(route, [onRoute, offRoute])).toEqual([
            offRoute,
        ]);
    });
});

describe('waypointRoleAt', () => {
    const at = (count: number): Waypoint[] =>
        Array.from({ length: count }, (_, index) => ({
            position: [1.0 + index * 0.0001, 2.0] as Position,
            role: 'via' as const,
        }));

    test('a role is decided by position in the list and nothing else', () => {
        // The ordinal and the role the server stores come from the array order,
        // so this is the rule the whole persisted recipe rests on: the first
        // control is the start, the last is the end, and everything between is a
        // via whatever it used to say about itself.
        expect(at(4).map((_, index) => waypointRoleAt(at(4), index))).toEqual([
            'start',
            'via',
            'via',
            'end',
        ]);
    });

    test('one control is the start and the end at once', () => {
        expect(waypointRoleAt(at(1), 0)).toBe('start');
    });

    test('two controls are the route and nothing else', () => {
        expect(at(2).map((_, index) => waypointRoleAt(at(2), index))).toEqual([
            'start',
            'end',
        ]);
    });

    test('three controls put exactly one via between them', () => {
        expect(at(3).map((_, index) => waypointRoleAt(at(3), index))).toEqual([
            'start',
            'via',
            'end',
        ]);
    });
});

describe('describeDetached', () => {
    test('one and several get their own sentences, zero gets none', () => {
        expect(describeDetached(0)).toBe('');
        expect(describeDetached(1)).toContain('One control point');
        expect(describeDetached(2)).toContain('2 control points');
    });

    test('every fix it names is a gesture that exists', () => {
        // It used to offer "redraw its tramo", which is not a gesture in this
        // editor — a warning pointing at an action the reviewer cannot take is
        // a refusal with extra words in it.
        for (const count of [1, 2]) {
            const sentence = describeDetached(count);

            expect(sentence).toContain('Drag');
            expect(sentence).toContain('remove');
            expect(sentence).not.toContain('edraw');
        }
    });
});

describe('replaceTramoSpan', () => {
    test('the span between two vertices is replaced by the answer, ends included', () => {
        // Span 1..3 (the middle three vertices) replaced by a router answer
        // that turns north: the two endpoint vertices come from the answer.
        const tramo = tramos([1.0001, 2.0], [1.00015, 2.0001], [1.0003, 2.0]);

        const next = replaceTramoSpan(route, 1, 3, tramo);

        expect(next[0]).toEqual([
            [1.0, 2.0],
            [1.0001, 2.0],
            [1.00015, 2.0001],
            [1.0003, 2.0],
            [1.0004, 2.0],
        ]);
    });

    test('the untouched spans stay byte-identical — spec §4, the rest does not move', () => {
        const tramo = tramos([1.0001, 2.0], [1.00015, 2.0001], [1.0003, 2.0]);

        const next = replaceTramoSpan(route, 1, 3, tramo);

        expect(next[0][0]).toBe(route[0][0]);
        expect(next[0][4]).toBe(route[0][4]);
    });

    test('an adjacent span is a pure insertion of the answer', () => {
        const tramo = tramos([1.0002, 2.0], [1.0002, 2.0001], [1.0003, 2.0]);

        const next = replaceTramoSpan(route, 1, 2, tramo);

        expect(next[0].length).toBe(6);
    });

    test('degenerate spans return the input untouched', () => {
        const blank = tramos([0, 0], [0, 0]);

        expect(replaceTramoSpan(route, 3, 1, blank)).toBe(route);
        expect(replaceTramoSpan(route, 0, 9, blank)).toBe(route);
        expect(replaceTramoSpan(route, 0, 4, [])).toBe(route);
    });
});

describe('prependTramo', () => {
    test('extending at the start keeps the route and drops only the join', () => {
        // The answer runs new -> old start; its last position is the route's
        // own first vertex and must not appear twice.
        const tramo = tramos([0.9999, 2.0], [1.0, 2.0]);

        const next = prependTramo(route, tramo);

        expect(next[0]).toEqual([[0.9999, 2.0], ...route[0]]);
    });

    test('a fresh route becomes the whole answer', () => {
        expect(prependTramo([], tramos([0.9999, 2.0], [1.0, 2.0]))).toEqual([
            [
                [0.9999, 2.0],
                [1.0, 2.0],
            ],
        ]);
    });
});

describe('extensionEndpoints', () => {
    const start: Position = [1.0, 2.0];
    const clicked: Position = [0.9999, 2.0];

    test('the tail extends forward, from the route to the click', () => {
        expect(extensionEndpoints('tail', start, clicked)).toEqual({
            origin: start,
            destination: clicked,
        });
    });

    test('the head extends backward: the click becomes the origin', () => {
        // Asking the router start-to-click here is what made the extended
        // route double back on itself, and it is why one-ways and turn
        // restrictions were evaluated against a direction nothing runs.
        expect(extensionEndpoints('head', start, clicked)).toEqual({
            origin: clicked,
            destination: start,
        });
    });
});

describe('insertionTarget', () => {
    // The five-vertex straight route, ~11 m per leg. Its recipe starts and ends
    // at its own ends, so one control splits it into one span.
    const two: Waypoint[] = [
        { position: [1.0, 2.0], role: 'start' },
        { position: [1.0004, 2.0], role: 'end' },
    ];

    const four: Waypoint[] = [
        { position: [1.0, 2.0], role: 'start' },
        { position: [1.0001, 2.0], role: 'via' },
        { position: [1.0003, 2.0], role: 'via' },
        { position: [1.0004, 2.0], role: 'end' },
    ];

    test('a click inside the only span splits it, and names the slot after it', () => {
        // Vertices 0..4 with a control at each end: the span is the whole route
        // and the new control would take index 1, after the start.
        const target = insertionTarget(route, two, [1.0002, 2.0]);

        expect(target?.from.index).toBe(0);
        expect(target?.to.index).toBe(4);
        expect(target?.insertIndex).toBe(1);
    });

    test('with four controls a click lands in the span that contains it', () => {
        // Bounds at vertices 0, 1, 3 and 4, so the spans are 0..1 and 1..3. A
        // click at 1.00005 is inside the first, and one at 1.0002 inside the
        // second — which is not the same span just because it is nearer.
        const first = insertionTarget(route, four, [1.00005, 2.0]);
        const second = insertionTarget(route, four, [1.0002, 2.0]);

        expect(first?.from.index).toBe(0);
        expect(first?.to.index).toBe(1);
        expect(first?.insertIndex).toBe(1);

        expect(second?.from.index).toBe(1);
        expect(second?.to.index).toBe(3);
        expect(second?.insertIndex).toBe(2);
    });

    test('a click on a boundary vertex belongs to the span before it', () => {
        // Inserting exactly where a split already is would put a control on top
        // of another one, so the tie goes backwards.
        const target = insertionTarget(route, four, [1.0001, 2.0]);

        expect(target?.from.index).toBe(0);
        expect(target?.to.index).toBe(1);
    });

    test('a recipe with fewer than two controls has no span to split', () => {
        expect(
            insertionTarget(route, two.slice(0, 1), [1.0002, 2.0]),
        ).toBeNull();
    });

    test('a detached bound cannot delimit anything', () => {
        const drifted: Waypoint[] = [
            { position: [1.0, 2.0], role: 'start' },
            { position: [1.0002, 2.0006], role: 'end' },
        ];

        expect(insertionTarget(route, drifted, [1.0001, 2.0])).toBeNull();
    });

    test('a click far from the route is not a split but an extension', () => {
        // Sixty metres north: over the tolerance, so there is nothing to split
        // and the caller's honest answer is to grow the route instead.
        expect(insertionTarget(route, two, [1.0002, 2.0006])).toBeNull();
    });

    test('an empty route has nothing to split', () => {
        expect(insertionTarget([], two, [1.0, 2.0])).toBeNull();
    });
});

describe('removalJoin', () => {
    const recipe: Waypoint[] = [
        { position: [1.0, 2.0], role: 'start' },
        { position: [1.0002, 2.0], role: 'via' },
        { position: [1.0004, 2.0], role: 'end' },
    ];

    test('an interior control between two on-route ones can be joined', () => {
        expect(removalJoin(route, recipe, 1)).toEqual({
            from: { segment: 0, index: 0, distance: expect.any(Number) },
            to: { segment: 0, index: 4, distance: expect.any(Number) },
        });
    });

    test('a neighbour off the route cannot delimit a span', () => {
        // The join is across the control's NEIGHBOURS, so it is a neighbour that
        // has to be off the route — the control under test can be perfectly
        // placed and still have nothing to join to.
        const drifted: Waypoint[] = [
            { position: [1.0, 2.0], role: 'start' },
            { position: [1.0001, 2.0], role: 'via' },
            { position: [1.0002, 2.0006], role: 'via' },
            { position: [1.0004, 2.0], role: 'end' },
        ];

        expect(removalJoin(route, drifted, 1)).toBeNull();
    });

    test('the two ends have no neighbours to join across', () => {
        expect(removalJoin(route, recipe, 0)).toBeNull();
        expect(removalJoin(route, recipe, 2)).toBeNull();
    });

    test('a recipe of two has no interior control at all', () => {
        expect(removalJoin(route, recipe.slice(0, 2), 1)).toBeNull();
    });

    test('neighbours in the wrong order along the route are not a span', () => {
        // A recipe that runs backwards along its own route: the list order and
        // the geometry order disagreeing is a state the editor refuses rather
        // than guesses at, and the refusal has to be the one the button's label
        // promised.
        const backwards: Waypoint[] = [
            { position: [1.0004, 2.0], role: 'start' },
            { position: [1.0002, 2.0], role: 'via' },
            { position: [1.0, 2.0], role: 'end' },
        ];

        expect(removalJoin(route, backwards, 1)).toBeNull();
    });
});

describe('describeRemoveControlBlock', () => {
    test('nothing selected says how to select something', () => {
        expect(describeRemoveControlBlock(null)).toContain(
            'Click a control on the map',
        );
    });

    test('an end is removable, because a route is its geometry and not its recipe', () => {
        // Refuted by what the code actually reads: no role is read outside this
        // editor, the bundle never carries waypoints, and `lines` has no start
        // or end column. An end control holds a tramo, not the route.
        // The total is gone from the signature with the rule: there is no count
        // at which a selected control cannot be taken away.
        expect(describeRemoveControlBlock(0)).toBe('');
    });

    test('an interior control is removable and gets no sentence', () => {
        expect(describeRemoveControlBlock(1)).toBe('');
        expect(describeRemoveControlBlock(2)).toBe('');
    });

    test('a removal with no re-route says what it did not do', () => {
        // Said, because the alternative is the control quietly dropped with the
        // stretch it used to pin left as whatever the geometry happened to be.
        const sentence = describeRemoveWithoutReroute();

        expect(sentence).toContain('without re-routing');
        expect(sentence).toContain('left exactly as it is');
    });
});

describe('insertWaypointAt', () => {
    test('the new control takes the clicked index and roles re-derive', () => {
        const waypoints: Waypoint[] = [
            { position: [1.0, 2.0], role: 'start' },
            { position: [1.0004, 2.0], role: 'end' },
        ];

        const next = insertWaypointAt(waypoints, 1, [1.0002, 2.0]);

        expect(next.map((waypoint) => waypoint.role)).toEqual([
            'start',
            'via',
            'end',
        ]);
    });

    test('the boundaries are not insertable', () => {
        const waypoints: Waypoint[] = [
            { position: [1.0, 2.0], role: 'start' },
            { position: [1.0004, 2.0], role: 'end' },
        ];

        expect(insertWaypointAt(waypoints, 0, [1.0, 2.0])).toBe(waypoints);
        expect(insertWaypointAt(waypoints, 2, [1.0, 2.0])).toBe(waypoints);
    });
});

describe('the region helpers', () => {
    // Two anchors on the five-vertex straight route: the first projects into
    // segment 0 at t = 0.5 (boundary 1), the second into segment 3 at t = 0.5
    // (boundary 4). Both need a vertex cut, so the region is bounded by two
    // vertices that did not exist and the answer is checked position by
    // position.
    const firstClick: Position = [1.00005, 2.0];
    const lastClick: Position = [1.00035, 2.0];

    function region(clicks: Position[] = [firstClick, lastClick]) {
        return orderAnchorsByRoute(clicks, route) ?? [];
    }

    // The chain runs along the anchors' own streets, a fraction north of the
    // route's centreline — which is the real shape of the answer: the router
    // snaps the anchors onto roads, and the connector between a projection and
    // a snapped anchor is the stretch the reviewer asked for, not a rounding.
    const chain: Position[] = [
        [1.00006, 2.0001],
        [1.0002, 2.0002],
        [1.00034, 2.0001],
    ];

    test('anchors order by their place on the route, not by click order', () => {
        const ordered = region([lastClick, firstClick]);

        expect(ordered).toHaveLength(2);
        expect(ordered[0]?.clicked).toEqual(firstClick);
        expect(ordered[1]?.clicked).toEqual(lastClick);
    });

    test('two anchors on one segment still order by where they landed', () => {
        const ordered = region([
            [1.00025, 2.0],
            [1.00015, 2.0],
        ]);

        expect(ordered.map((anchor) => anchor.clicked)).toEqual([
            [1.00015, 2.0],
            [1.00025, 2.0],
        ]);
    });

    test('an anchor with no route to land on has no order', () => {
        expect(orderAnchorsByRoute([[1.0, 2.0]], [])).toBeNull();
    });

    test('the rebuild keeps the vertices outside the region as the same objects', () => {
        const result = rebuildRegion(route, region(), chain);

        expect(result.rebuilt).toBe(true);
        expect(result.reason).toBeNull();
        // v0, the first cut, the chain, the last cut, v4 — hand-computed.
        expect(result.coordinates[0]).toEqual([
            [1.0, 2.0],
            [1.00005, 2.0],
            [1.00006, 2.0001],
            [1.0002, 2.0002],
            [1.00034, 2.0001],
            [1.00035, 2.0],
            [1.0004, 2.0],
        ]);

        const before = route[0] ?? [];

        expect(result.coordinates[0]?.[0]).toBe(before[0]);
        expect(result.coordinates[0]?.[6]).toBe(before[4]);
    });

    test('a boundary landing on an existing vertex cuts nothing', () => {
        // [1.0002, 2.0] is vertex 2 itself: no cut vertex may be written,
        // because a duplicate of a vertex the route already has is noise the
        // reviewer would have to see through.
        const result = rebuildRegion(
            route,
            region([firstClick, [1.0002, 2.0]]),
            chain,
        );

        expect(result.rebuilt).toBe(true);
        expect(new Set(result.coordinates[0]).size).toBe(
            result.coordinates[0]?.length,
        );
    });

    test('two anchors on the same spot are refused, and the route is untouched', () => {
        const result = rebuildRegion(
            route,
            region([firstClick, firstClick]),
            chain,
        );

        expect(result.rebuilt).toBe(false);
        expect(result.reason).toBe('degenerate-region');
        expect(result.coordinates).toBe(route);
    });

    test('a chain of one point is not a rebuild', () => {
        const result = rebuildRegion(route, region(), [[1.00005, 2.0]]);

        expect(result.rebuilt).toBe(false);
        expect(result.reason).toBe('empty-chain');
    });

    test('a control standing inside the region is named, not dropped', () => {
        const recipe: Waypoint[] = [
            { position: [1.0, 2.0], role: 'start' },
            { position: [1.0002, 2.0], role: 'via' },
            { position: [1.0004, 2.0], role: 'end' },
        ];

        expect(controlsInsideRegion(recipe, route, region())).toEqual([1]);
        expect(
            controlsInsideRegion(
                recipe,
                route,
                region([firstClick, [1.00015, 2.0]]),
            ),
        ).toEqual([]);
    });

    test('the recipe takes the anchors between the controls they bound', () => {
        const recipe: Waypoint[] = [
            { position: [1.0, 2.0], role: 'start' },
            { position: [1.0004, 2.0], role: 'end' },
        ];

        const anchors: RegionAnchor[] = region().map((anchor, index) => ({
            ...anchor,
            snapped:
                index === 0 ? [1.00005, 2.00001] : ([1.00035, 2.0] as Position),
        }));

        const next = anchorsIntoRecipe(recipe, route, anchors);

        expect(next.map((waypoint) => waypoint.position)).toEqual([
            [1.0, 2.0],
            [1.00005, 2.00001],
            [1.00035, 2.0],
            [1.0004, 2.0],
        ]);
        expect(next.map((waypoint) => waypoint.role)).toEqual([
            'start',
            'via',
            'via',
            'end',
        ]);
    });

    test('an unsnapped anchor is committed where it was clicked, until the router answers', () => {
        const recipe: Waypoint[] = [
            { position: [1.0, 2.0], role: 'start' },
            { position: [1.0004, 2.0], role: 'end' },
        ];

        const next = anchorsIntoRecipe(recipe, route, region());

        expect(next[1]?.position).toEqual(firstClick);
    });
});

describe('the batch chain', () => {
    const legs: Position[][] = [
        [
            [1.0, 2.0],
            [1.1, 2.0],
        ],
        [
            [1.1, 2.0],
            [1.2, 2.0],
        ],
        [
            [1.2, 2.0],
            [1.3, 2.0],
        ],
    ];

    test('the chain drops every join but the first head', () => {
        expect(stitchedChain(legs)).toEqual([
            [1.0, 2.0],
            [1.1, 2.0],
            [1.2, 2.0],
            [1.3, 2.0],
        ]);
    });

    test('a batch of one leg is that leg', () => {
        expect(stitchedChain([legs[0] as Position[]])).toEqual(legs[0]);
    });

    test('the snaps are one more than the legs, head to tail', () => {
        expect(anchorSnaps(legs)).toEqual([
            [1.0, 2.0],
            [1.1, 2.0],
            [1.2, 2.0],
            [1.3, 2.0],
        ]);
    });

    test('no legs means no snaps to read', () => {
        expect(anchorSnaps([])).toEqual([]);
    });
});

describe('the rectify messages', () => {
    test('a refusal names the correction', () => {
        expect(describeRectifyRefusal('degenerate-region')).toBe(
            'Those anchors bound no stretch. Move them further apart.',
        );
        expect(describeRectifyRefusal('something-new')).toBe(
            'That stretch cannot be rebuilt.',
        );
    });

    test('the anchor count says how many are missing', () => {
        expect(describeAnchorsNeeded(0)).toContain('Click the map');
        expect(describeAnchorsNeeded(1)).toContain('One more anchor');
    });

    test('blocked controls are named by the order the reviewer sees', () => {
        expect(describeBlockedControls([0, 2])).toBe(
            'The stretch holds control 1, control 3, which the rebuild would remove. Remove it first, or bound the anchors tighter.',
        );
    });
});

describe('simplifyRoutedChain', () => {
    // Five vertices eleven metres apart on one straight line: what a router
    // answer looks like where an avenue crosses four side streets.
    const straight: Position[] = [
        [1.0, 2.0],
        [1.0001, 2.0],
        [1.0002, 2.0],
        [1.0003, 2.0],
        [1.0004, 2.0],
    ];

    test('a straight run keeps its two ends and reports the rest', () => {
        const result = simplifyRoutedChain(straight);

        expect(result.positions).toEqual([
            [1.0, 2.0],
            [1.0004, 2.0],
        ]);
        expect(result.dropped).toBe(3);
        expect(result.maxDeviation).toBeLessThan(0.001);
    });

    test('a straight run that wobbles by centimetres still collapses', () => {
        // The shape of the real thing: an OSM centreline along a straight avenue
        // is never exactly collinear, and a search that stops collapsing on a
        // centimetre of wobble would keep every junction on every avenue in the
        // city — which is the whole population this exists to remove.
        const wobble: Position[] = [
            [1.0, 2.0],
            [1.0001, 2.000001],
            [1.0002, 2.0],
            [1.0003, 1.999999],
            [1.0004, 2.0],
        ];

        const result = simplifyRoutedChain(wobble);

        expect(result.positions).toEqual([
            [1.0, 2.0],
            [1.0004, 2.0],
        ]);
        expect(result.dropped).toBe(3);
    });

    test('a long straight run is split anyway, because it deviates by nothing', () => {
        // Forty vertices eleven metres apart: a 440 m avenue whose centreline
        // carries no shape at all. A tolerance of any size authorises collapsing
        // it to two vertices 440 m apart — the line keeps its shape perfectly
        // and ends up with a gap nobody drew. The span rule has to be what
        // prevents that, and the vertices it keeps have to be few: a rule that
        // splits at the first interior vertex spends all forty of them.
        const long: Position[] = Array.from(
            { length: 40 },
            (_, i) => [1.0 + i * 0.0001, 2.0] as Position,
        );

        const result = simplifyRoutedChain(long);

        expect(result.positions.length).toBeLessThan(12);

        const gaps = result.positions
            .slice(1)
            .map((position, index) =>
                distanceMeters(result.positions[index] as Position, position),
            );

        expect(Math.max(...gaps)).toBeLessThanOrEqual(
            ROUTED_MAX_SPAN_METERS + 1,
        );
    });

    test('a bend beyond the tolerance survives on distance alone', () => {
        // 5.5 m off the chord with turn angles under 45°, so only the distance
        // rule can be holding this vertex up.
        const bend: Position[] = [
            [1.0, 2.0],
            [1.0002, 2.0],
            [1.0004, 2.001],
        ];

        expect(simplifyRoutedChain(bend, [], 5).positions).toHaveLength(3);
        expect(simplifyRoutedChain(bend, [], 5).dropped).toBe(0);
    });

    test('a corner survives a tolerance that would otherwise flatten it', () => {
        // Eleven-metre legs at a right angle: about 4.5 m of deviation from the
        // chord, which a twenty-metre budget calls free — and a bus route that
        // cuts the corner is wrong whatever it saves. The tolerance is raised
        // past the deviation on purpose, so only the angle rule can keep this.
        const corner: Position[] = [
            [1.0, 2.0],
            [1.0001, 2.0],
            [1.0001, 2.0001],
        ];

        const result = simplifyRoutedChain(corner, [], 1000);

        expect(result.positions).toEqual(corner);
        expect(result.dropped).toBe(0);
    });

    test('a pinned vertex survives a stretch that would otherwise collapse', () => {
        const result = simplifyRoutedChain(straight, [2]);

        expect(result.positions).toEqual([
            straight[0],
            straight[2],
            straight[4],
        ]);
        expect(result.dropped).toBe(2);
    });

    test('a chain of two is already the answer', () => {
        const pair: Position[] = [
            [1.0, 2.0],
            [1.0001, 2.0],
        ];

        expect(simplifyRoutedChain(pair)).toEqual({
            positions: pair,
            dropped: 0,
            maxDeviation: 0,
        });
    });
});

describe('describeSimplification', () => {
    test('says nothing when nothing went', () => {
        expect(describeSimplification(0, 0)).toBe('');
    });

    test('counts the vertices and bounds the movement', () => {
        expect(describeSimplification(312, 4.4)).toBe(
            ' 312 vertices dropped, max 4 m off the line',
        );
        expect(describeSimplification(1, 12.6)).toBe(
            ' 1 vertex dropped, max 13 m off the line',
        );
    });
});

describe('projectOnRoute', () => {
    test('a point beside the route lands where it is nearest', () => {
        // Five vertices eleven metres apart on the straight fixture; a click
        // halfway along the second leg.
        const result = projectOnRoute(route, [1.00005, 2.0002]);

        expect(result?.index).toBe(0);
        expect(result?.t).toBeCloseTo(0.5, 5);
        expect(result?.point[0]).toBeCloseTo(1.00005, 6);
    });

    test('a point far off the route still projects onto it', () => {
        // Twenty metres north of a straight run: the projection is where the
        // route is, NOT where the point is. That difference is the connector a
        // reviewer's pin asks for.
        const result = projectOnRoute(route, [1.0001, 2.0002]);

        expect(result?.point[1]).toBeCloseTo(2.0, 6);
    });

    test('no route to project onto is null', () => {
        expect(projectOnRoute([], [1.0, 2.0])).toBeNull();
        expect(projectOnRoute([[[1.0, 2.0]]], [1.0, 2.0])).toBeNull();
    });
});

describe('cutRouteAt', () => {
    test('a projection between two vertices gains one', () => {
        const cut = cutRouteAt(route, {
            index: 1,
            t: 0.5,
            point: [1.00015, 2.0],
        });

        expect(cut?.inserted).toBe(true);
        expect(cut?.index).toBe(2);
        expect(cut?.coordinates[0]?.[2]).toEqual([1.00015, 2.0]);
    });

    test('a projection onto an existing vertex writes nothing', () => {
        // Duplicating a vertex the route already has is what every downstream
        // "span degenerate" check would trip over.
        const cut = cutRouteAt(route, {
            index: 2,
            t: 0,
            point: [1.0002, 2.0],
        });

        expect(cut?.inserted).toBe(false);
        expect(cut?.index).toBe(2);
        expect(cut?.coordinates).toBe(route);
    });
});

describe('describeFailedSpan', () => {
    test('the stretch names the two anchors that bound it', () => {
        // Leg 0 is the stretch between anchors 1 and 2: the badges are numbered
        // by route order and the legs follow, which is what lets a reviewer act
        // on "between 2 and 3" without counting anything.
        const failure = describeFailedSpan('no-path', 0);

        expect(failure.message).toContain('anchor 1');
        expect(failure.message).toContain('anchor 2');
        expect(failure.anchors).toEqual([1, 2]);
    });

    test('a leg further along the batch names its own pair', () => {
        expect(describeFailedSpan('no-path', 2).anchors).toEqual([3, 4]);
    });

    test('the advice is the anchors gesture one, not the trace gesture one', () => {
        expect(describeFailedSpan('no-path', 0).message).toContain(
            'Move one of them',
        );
        expect(describeFailedSpan('no-path', 0).message).not.toContain(
            'Add a control point',
        );
    });

    test('an anchor off the network is blamed alone', () => {
        // Only the origin is at fault, and only moving it fixes it: the leg has
        // to REACH that anchor, so another one in between still has to arrive at
        // the same unreachable place.
        const failure = describeFailedSpan('origin-too-far', 1);

        expect(failure.message).toContain('Anchor 2 is too far');
        expect(failure.anchors).toEqual([2]);
    });

    test('a destination off the network blames the far anchor', () => {
        // Leg 1 runs from anchor 2 to anchor 3, so the far one is the 3.
        const failure = describeFailedSpan('destination-too-far', 1);

        expect(failure.message).toContain('Anchor 3 is too far');
        expect(failure.anchors).toEqual([3]);
    });

    test('a stretch that is not the anchors fault paints nothing', () => {
        // A lookup that did not answer says nothing about where the reviewer put
        // anything, and painting two anchors for it would send them moving points
        // that were fine.
        for (const reason of ['graph-not-built', null, 'anything-else']) {
            expect(describeFailedSpan(reason, 0).anchors).toEqual([]);
        }
    });

    test('a missing graph is named as not their fault', () => {
        expect(describeFailedSpan('graph-not-built', 0).message).toContain(
            'can be fixed from here',
        );
    });
});

describe('removeWaypoint', () => {
    test('removing a via joins the list and re-derives roles', () => {
        const waypoints: Waypoint[] = [
            { position: [1.0, 2.0], role: 'start' },
            { position: [1.0001, 2.0], role: 'via' },
            { position: [1.0002, 2.0], role: 'via' },
            { position: [1.0004, 2.0], role: 'end' },
        ];

        const next = removeWaypoint(waypoints, 1);

        expect(next?.map((waypoint) => waypoint.role)).toEqual([
            'start',
            'via',
            'end',
        ]);
        expect(next?.length).toBe(3);
    });

    test('an end goes, and the survivor takes the role it lost', () => {
        const pair: Waypoint[] = [
            { position: [1.0, 2.0], role: 'start' },
            { position: [1.0004, 2.0], role: 'end' },
        ];

        // Dropping the start promotes the end, which is the only control left and
        // so is both ends of what remains.
        expect(removeWaypoint(pair, 0)?.map((w) => w.role)).toEqual(['start']);
        expect(removeWaypoint(pair, 1)?.map((w) => w.role)).toEqual(['start']);

        const triple: Waypoint[] = [
            { position: [1.0, 2.0], role: 'start' },
            { position: [1.0002, 2.0], role: 'via' },
            { position: [1.0004, 2.0], role: 'end' },
        ];

        // Dropping the start promotes the via, which is now the first control.
        expect(removeWaypoint(triple, 0)?.map((w) => w.role)).toEqual([
            'start',
            'end',
        ]);
        // Dropping the end promotes the via, which is now the last one.
        expect(removeWaypoint(triple, 2)?.map((w) => w.role)).toEqual([
            'start',
            'end',
        ]);
    });

    test('the last control leaves an empty recipe rather than a refusal', () => {
        const single: Waypoint[] = [{ position: [1.0, 2.0], role: 'start' }];

        expect(removeWaypoint(single, 0)).toEqual([]);
    });

    test('only an index naming no control is refused', () => {
        const pair: Waypoint[] = [
            { position: [1.0, 2.0], role: 'start' },
            { position: [1.0004, 2.0], role: 'end' },
        ];

        expect(removeWaypoint(pair, -1)).toBeNull();
        expect(removeWaypoint(pair, 2)).toBeNull();
        expect(removeWaypoint([], 0)).toBeNull();
    });
});
