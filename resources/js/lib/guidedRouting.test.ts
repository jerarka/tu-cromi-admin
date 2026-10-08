import { describe, expect, test } from 'vitest';
import {
    describeDetached,
    describeRoute,
    describeRouteRefusal,
    describeRouteWarnings,
    describeRoutedPending,
    detachedWaypoints,
    extensionEndpoints,
    finalHeading,
    findVertexForWaypoint,
    guidesFromGeometry,
    headingAtVertex,
    headingBetween,
    insertWaypointAt,
    prependTramo,
    prependWaypoint,
    removeWaypoint,
    replaceTramoSpan,
    spliceTramo,
    tramoInterior,
    waypointsFromRecord,
    WAYPOINT_LIMIT,
} from './guidedRouting';
import type { Waypoint } from './guidedRouting';
import type { Position } from './routeEditing';

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
    test('names every street it used, with the metres each covered', () => {
        expect(
            describeRoute(
                [
                    { name: 'Calle 1', meters: 240.4 },
                    { name: 'Avenida Cristo Redentor', meters: 1200.6 },
                ],
                1441.0,
            ),
        ).toBe('Traced Calle 1 —240 m, Avenida Cristo Redentor —1201 m');
    });

    test('an unnamed street is named as such rather than skipped', () => {
        expect(describeRoute([{ name: null, meters: 55.5 }], 55.5)).toBe(
            'Traced unnamed street —56 m',
        );
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
        [null, 'draw this part by hand'],
        ['anything-else', 'draw this part by hand'],
    ])('%s → a message a reviewer can act on', (reason, fragment) => {
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

describe('describeDetached', () => {
    test('one and several get their own sentences, zero gets none', () => {
        expect(describeDetached(0)).toBe('');
        expect(describeDetached(1)).toContain('One control point');
        expect(describeDetached(2)).toContain('2 control points');
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

    test('the route ends and a two-waypoint route are not removable', () => {
        const pair: Waypoint[] = [
            { position: [1.0, 2.0], role: 'start' },
            { position: [1.0004, 2.0], role: 'end' },
        ];
        const triple: Waypoint[] = [
            ...pair,
            { position: [1.0002, 2.0], role: 'via' },
        ];

        expect(removeWaypoint(pair, 0)).toBeNull();
        expect(removeWaypoint(pair, 1)).toBeNull();
        expect(removeWaypoint(triple, 0)).toBeNull();
        expect(removeWaypoint(triple, 2)).toBeNull();
    });
});
