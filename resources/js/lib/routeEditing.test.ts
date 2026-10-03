import { describe, expect, test } from 'vitest';
import {
    applyDeltaToSelection,
    clampRange,
    decideSnap,
    describeRelayHint,
    describeModeHelp,
    describeRemoval,
    describePropagationTooltip,
    describeResample,
    describeResampleHint,
    describeRouteStats,
    describeSelectionState,
    describeSnapPreset,
    describeSnapTooltip,
    distanceMeters,
    findClosestSegment,
    formatDistance,
    insertVertexAt,
    longitudeScale,
    projectOnSegment,
    propagationLimitsFor,
    propagateAlongStreet,
    PROPAGATION_MAX_ARC_METERS,
    PROPAGATION_MAX_VERTICES,
    rangeBetween,
    RELAY_MIN_SPACING_METERS,
    relayLimitsFor,
    relaySelectionOntoNetwork,
    removeVertexAt,
    removeVertices,
    resampleBlock,
    resampleSelection,
    routeStats,
    routeEndpoints,
    SNAP_PRESETS,
    SNAP_PRESET_LABELS,
    SNAP_PRESET_NAMES,
    SNAP_SAMPLE_LIMIT,
    snapSample,
    snapOptionsFor,
    snapSearchRadius,
    verticesWithinBounds,
} from './routeEditing';
import type {
    Coordinates,
    Position,
    PropagationDirection,
    PropagationLimits,
    RelayLimits,
    StreetLookup,
    VertexRef,
} from './routeEditing';

/** A deep copy, so a test asserting non-mutation cannot be fooled by the fixture itself. */
function snapshot(coordinates: Coordinates): Coordinates {
    return coordinates.map((segment) => segment.map((p) => [p[0], p[1]]));
}

const square: Coordinates = [
    [
        [0, 0],
        [10, 0],
        [10, 10],
    ],
];

describe('findClosestSegment', () => {
    test('picks the nearest span', () => {
        const route: Coordinates = [
            [
                [0, 0],
                [10, 0],
            ],
            [
                [100, 100],
                [110, 100],
            ],
        ];

        expect(findClosestSegment([5, 1], route)).toEqual({
            segIdx: 0,
            pointIdx: 0,
        });
    });

    test('resolves a tie to the earliest segment', () => {
        const route: Coordinates = [
            [
                [0, 0],
                [10, 0],
            ],
            [
                [0, 5],
                [10, 5],
            ],
        ];

        expect(findClosestSegment([5, 2.5], route)).toEqual({
            segIdx: 0,
            pointIdx: 0,
        });
    });

    test('returns null when there is no span to measure', () => {
        expect(findClosestSegment([0, 0], [[]])).toBeNull();
    });
});

describe('projectOnSegment', () => {
    test('reports the raw parameter for a click inside the span', () => {
        expect(projectOnSegment([5, 3], [0, 0], [10, 0]).t).toBe(0.5);
    });

    test('returns the perpendicular foot in the module coordinate order', () => {
        // Longitude first, like every position here. The point the editor moves
        // a vertex onto comes from this, so the two fields being the wrong way
        // round would mirror the whole route.
        expect(projectOnSegment([5, 3], [0, 0], [10, 0]).point).toEqual([5, 0]);
    });

    test('keeps the parameter below zero when the click overshoots the start', () => {
        const projection = projectOnSegment([-5, 0], [0, 0], [10, 0]);

        expect(projection.t).toBeLessThan(0);
        expect(projection.point).toEqual([0, 0]);
    });

    test('keeps the parameter above one when the click overshoots the end', () => {
        const projection = projectOnSegment([15, 0], [0, 0], [10, 0]);

        expect(projection.t).toBeGreaterThan(1);
        expect(projection.point).toEqual([10, 0]);
    });

    test('a zero-length segment projects onto its only position', () => {
        expect(projectOnSegment([3, 4], [1, 1], [1, 1])).toEqual({
            t: 0,
            point: [1, 1],
        });
    });
});

describe('insertVertexAt', () => {
    test('inserts inside the span for a click that projects within it', () => {
        expect(insertVertexAt(square, 0, 0, [5, 0], 0.5)[0][1]).toEqual([5, 0]);
    });

    test('inserts before the span start when the click overshoots it', () => {
        // t < 0 means the click landed short of the span's first vertex, so the
        // new vertex belongs on the other side of it. Inserting after would
        // silently reroute the span.
        const route: Coordinates = [
            [
                [-10, 0],
                [0, 0],
                [10, 0],
            ],
        ];

        const result = insertVertexAt(route, 0, 1, [-5, 0], -0.5);

        expect(result[0][1]).toEqual([-5, 0]);
        expect(result[0][2]).toEqual([0, 0]);
    });

    test('inserts after the span end when the click overshoots it', () => {
        const route: Coordinates = [
            [
                [0, 0],
                [10, 0],
                [20, 0],
            ],
        ];

        const result = insertVertexAt(route, 0, 0, [15, 0], 1.5);

        expect(result[0][2]).toEqual([15, 0]);
        expect(result[0][3]).toEqual([20, 0]);
    });

    test('does not mutate the input', () => {
        const before = snapshot(square);

        insertVertexAt(square, 0, 0, [5, 0], 0.5);

        expect(square).toEqual(before);
    });
});

describe('removeVertexAt', () => {
    test('drops a vertex from a long segment, leaving a drawable line', () => {
        expect(removeVertexAt(square, 0, 1)[0]).toEqual([
            [0, 0],
            [10, 10],
        ]);
    });

    test('drops the whole segment when it would be left with one vertex', () => {
        const pair: Coordinates = [
            [
                [0, 0],
                [10, 0],
            ],
            [
                [0, 0],
                [0, 10],
            ],
        ];

        expect(removeVertexAt(pair, 0, 0)).toEqual([
            [
                [0, 0],
                [0, 10],
            ],
        ]);
    });

    /**
     * The contract this used to break. Removing from a route's only segment used
     * to hand back `[]` and leave the caller to notice, which meant the primitive
     * returned something that cannot be drawn or reviewed and every call site had
     * to remember to check. It now declines and returns its input by identity,
     * which is the same signal the bulk deletion and the re-space already use.
     */
    test('declines rather than returning a route with nothing on it', () => {
        const stub: Coordinates = [
            [
                [0, 0],
                [10, 0],
            ],
        ];

        expect(removeVertexAt(stub, 0, 0)).toBe(stub);
    });

    test('does not mutate the input', () => {
        const before = snapshot(square);

        removeVertexAt(square, 0, 1);

        expect(square).toEqual(before);
    });
});

describe('removeVertices', () => {
    const selection = (...indices: number[]): VertexRef[] =>
        indices.map((index) => ({ segment: 0, index }));

    test('removes a whole set in one pass', () => {
        // The reason this exists. Removing four vertices one click at a time
        // renumbers the ones after each removal, so the fourth click is working
        // against indexes that have already moved.
        const line: Coordinates = [
            [
                [0, 0],
                [1, 0],
                [2, 0],
                [3, 0],
                [4, 0],
                [5, 0],
            ],
        ];

        const result = removeVertices(line, selection(1, 2, 3));

        expect(result.removed).toBe(3);
        expect(result.coordinates[0]).toEqual([
            [0, 0],
            [4, 0],
            [5, 0],
        ]);
    });

    test('drops a segment left with too few points, and says so', () => {
        const pair: Coordinates = [
            [
                [0, 0],
                [1, 0],
            ],
            [
                [0, 5],
                [1, 5],
                [2, 5],
            ],
        ];

        const result = removeVertices(pair, [
            { segment: 0, index: 0 },
            { segment: 1, index: 1 },
        ]);

        // The vertex is not in the vertex count, so the dropped segment is the
        // only way a reviewer learns a stretch of route went with it.
        expect(result.droppedSegments).toBe(1);
        expect(result.removed).toBe(2);
        expect(result.coordinates).toEqual([
            [
                [0, 5],
                [2, 5],
            ],
        ]);
    });

    test('keeps a segment that is left with exactly two points', () => {
        const line: Coordinates = [
            [
                [0, 0],
                [1, 0],
                [2, 0],
            ],
        ];

        const result = removeVertices(line, selection(1));

        expect(result.droppedSegments).toBe(0);
        expect(result.coordinates[0]).toEqual([
            [0, 0],
            [2, 0],
        ]);
    });

    test('declines a deletion that would empty the route', () => {
        const stub: Coordinates = [
            [
                [0, 0],
                [1, 0],
            ],
        ];

        // A reviewer sets this up with two clicks and gets nothing. Better than a
        // route that cannot be drawn, and there is no state to undo back onto.
        expect(removeVertices(stub, selection(0, 1)).coordinates).toBe(stub);
    });

    test('is a no-op for an empty selection', () => {
        expect(removeVertices(square, []).coordinates).toBe(square);
    });

    /**
     * A selection addresses vertices by index, so one picked against a previous
     * geometry is stale rather than wrong. Rebuilding the route around indexes
     * that no longer exist would be worse than doing nothing.
     */
    test('is a no-op for a selection the route no longer has', () => {
        const result = removeVertices(square, [
            { segment: 0, index: 99 },
            { segment: 7, index: 0 },
        ]);

        expect(result.coordinates).toBe(square);
        expect(result.removed).toBe(0);
    });

    test('removes from two segments in one selection', () => {
        const line: Coordinates = [
            [
                [0, 0],
                [1, 0],
                [2, 0],
                [3, 0],
            ],
            [
                [3, 0],
                [4, 0],
                [5, 0],
                [6, 0],
            ],
        ];

        const result = removeVertices(line, [
            { segment: 0, index: 1 },
            { segment: 1, index: 1 },
        ]);

        expect(result.removed).toBe(2);
        expect(result.coordinates[0]).toEqual([
            [0, 0],
            [2, 0],
            [3, 0],
        ]);
        expect(result.coordinates[1]).toEqual([
            [3, 0],
            [5, 0],
            [6, 0],
        ]);
    });

    test('leaves a segment that arrived too short exactly as it found it', () => {
        const mixed: Coordinates = [
            [
                [0, 0],
                [1, 0],
                [2, 0],
            ],
            [[0, 5]],
        ];

        const result = removeVertices(mixed, selection(1));

        // Nothing was selected from the second segment, so repairing it would be
        // changing geometry the reviewer never indicated.
        expect(result.coordinates[1]).toEqual([[0, 5]]);
        expect(result.droppedSegments).toBe(0);
    });

    test('counts a repeated vertex once', () => {
        const line: Coordinates = [
            [
                [0, 0],
                [1, 0],
                [2, 0],
                [3, 0],
            ],
        ];

        const result = removeVertices(line, selection(1, 1, 1));

        expect(result.removed).toBe(1);
        expect(result.coordinates[0].length).toBe(3);
    });

    test('does not mutate the input', () => {
        const line: Coordinates = [
            [
                [0, 0],
                [1, 0],
                [2, 0],
                [3, 0],
            ],
        ];
        const before = snapshot(line);

        removeVertices(line, selection(1, 2));

        expect(line).toEqual(before);
    });
});

describe('describeRemoval', () => {
    test('says so when nothing was selected', () => {
        expect(
            describeRemoval({
                coordinates: [],
                removed: 0,
                droppedSegments: 0,
            }),
        ).toContain('Nothing was selected');
    });

    test('leads with the dropped segments, which the count hides', () => {
        const message = describeRemoval({
            coordinates: [],
            removed: 1,
            droppedSegments: 1,
        });

        expect(message).toContain('Deleted 1 vertex.');
        expect(message).toContain('1 segment');
    });

    test('uses the singular for one of each', () => {
        const message = describeRemoval({
            coordinates: [],
            removed: 1,
            droppedSegments: 1,
        });

        expect(message).not.toContain('vertices');
    });
});

describe('routeStats', () => {
    const LAT = -17.78;

    const DEG = distanceMeters([-63.18, LAT], [-63.18 + 1, LAT]);

    /** Degrees of longitude covering `metres` here. */
    const deg = (metres: number): number => metres / DEG;

    /**
     * Degrees of *latitude* covering `metres`.
     *
     * Separate from `deg` because a longitude degree in Santa Cruz is about 5%
     * shorter than a latitude degree, and a fixture that reuses the longitude
     * figure to build a north-south leg asks for 600 m and gets 630. That reads
     * as a rounding artefact in the code under test and is really a fixture
     * measuring the wrong axis.
     */
    const degLat = (metres: number): number =>
        metres / distanceMeters([0, 0], [0, 1]);

    test('counts every position the route holds', () => {
        const line: Coordinates = [
            [
                [0, 0],
                [1, 0],
                [2, 0],
            ],
            [
                [3, 0],
                [4, 0],
            ],
        ];

        expect(routeStats(line).vertices).toBe(5);
    });

    /**
     * A one-position segment is not drawable and does not look like a vertex on
     * the map, but it still occupies a slot in the coordinates array — the array
     * `line_transfers` addresses by index. Counting only what looks like a vertex
     * would make this number disagree with the thing it exists to inform.
     */
    test('counts a one-position segment', () => {
        const line: Coordinates = [
            [
                [0, 0],
                [1, 0],
            ],
            [[9, 9]],
        ];

        expect(routeStats(line).vertices).toBe(3);
    });

    test('reports nothing measurable for a route with no legs', () => {
        const single: Coordinates = [[[0, 0]]];

        const stats = routeStats(single);

        expect(stats.vertices).toBe(1);
        expect(stats.spacingMeters).toBeNull();
        expect(stats.lengthMeters).toBe(0);
    });

    test('is zero for no geometry at all', () => {
        const stats = routeStats([]);

        expect(stats.vertices).toBe(0);
        expect(stats.spacingMeters).toBeNull();
        expect(stats.lengthMeters).toBe(0);
    });

    test('measures a uniform route at its own interval', () => {
        const line: Coordinates = [
            Array.from({ length: 5 }, (_, i) => [-63.18 + i * deg(100), LAT]),
        ];

        const stats = routeStats(line);

        expect(stats.vertices).toBe(5);
        expect(stats.lengthMeters).toBeCloseTo(400, 6);
        expect(stats.spacingMeters).toBeCloseTo(100, 6);
    });

    test('measures a corner as the length walked, not the line across it', () => {
        const corner: Coordinates = [
            [
                [-63.18, LAT],
                [-63.18 + deg(600), LAT],
                [-63.18 + deg(600), LAT + degLat(600)],
            ],
        ];

        // Two 600 m legs, not the single 848 m chord between the ends.
        expect(routeStats(corner).lengthMeters).toBeCloseTo(1200, 3);
    });

    /**
     * The test this whole function exists to be honest about.
     *
     * A route's MultiLineString parts are not a continuation of each other, so
     * accumulating across the gap would report distance and spacing over ground
     * the route never runs. Deriving the spacing as `length / (vertices - 1)`
     * instead would agree exactly here and on any single-segment route, and
     * quietly disagree on this one — which is the worst kind of wrong, because it
     * passes every case that looks like the common case.
     */
    test('does not measure across the gap between two segments', () => {
        // The second segment is a different city entirely, so any measurement
        // that bridges the two would be off by thousands of kilometres.
        const line: Coordinates = [
            [
                [-63.18, LAT],
                [-63.18 + deg(100), LAT],
            ],
            [
                [0, 40],
                [0, 40 + degLat(100)],
            ],
        ];

        const stats = routeStats(line);

        expect(stats.vertices).toBe(4);
        expect(stats.lengthMeters).toBeCloseTo(200, 3);
        expect(stats.spacingMeters).toBeCloseTo(100, 3);
    });

    test('averages legs, not the span from the first vertex to the last', () => {
        const line: Coordinates = [
            [
                [-63.18, LAT],
                [-63.18 + deg(100), LAT],
            ],
            [
                [-63.18 + deg(100), LAT],
                [-63.18 + deg(300), LAT],
            ],
        ];

        // One 100 m leg and one 200 m leg: the mean is 150, where dividing the
        // total by the vertex count would have said 100.
        expect(routeStats(line).spacingMeters).toBeCloseTo(150, 3);
    });
});

describe('formatDistance', () => {
    test('reads metres below a kilometre', () => {
        // "0.6 km" is harder to picture and to check against the map.
        expect(formatDistance(640)).toBe('640 m');
    });

    test('switches to kilometres at exactly a kilometre', () => {
        expect(formatDistance(999)).toBe('999 m');
        expect(formatDistance(1000)).toBe('1.0 km');
    });

    test('keeps one decimal up to a hundred kilometres', () => {
        expect(formatDistance(99900)).toBe('99.9 km');
    });

    test('drops the decimal past a hundred kilometres', () => {
        // The decimal is noise on a number nobody is going to measure.
        expect(formatDistance(100000)).toBe('100 km');
        expect(formatDistance(412300)).toBe('412 km');
    });

    test('rounds to whole metres rather than claiming decimals', () => {
        expect(formatDistance(640.6)).toBe('641 m');
    });
});

describe('describeRouteStats', () => {
    test('says nothing about a route with no vertices', () => {
        expect(
            describeRouteStats({
                vertices: 0,
                spacingMeters: null,
                lengthMeters: 0,
            }),
        ).toBe('');
    });

    test('leads with the count and carries all three readings', () => {
        const line: Coordinates = [
            Array.from({ length: 5 }, (_, i) => [-63.18 + i * 0.001, -17.78]),
        ];

        const message = describeRouteStats(routeStats(line));

        expect(message).toBe('5 vertices · 106 m apart · 424 m');
    });

    test('uses the singular for one vertex', () => {
        const line: Coordinates = [[[0, 0]]];

        expect(describeRouteStats(routeStats(line))).toBe('1 vertex');
    });

    test('carries all three readings for a route of two vertices', () => {
        const line: Coordinates = [
            [
                [-63.18, -17.78],
                [-63.18 + 0.001, -17.78],
            ],
        ];

        // One leg, so the length and the spacing are the same number, and the
        // point of asserting the whole string is that the clause order and the
        // units are decided in one place rather than per page.
        expect(describeRouteStats(routeStats(line))).toBe(
            '2 vertices · 106 m apart · 106 m',
        );
    });
});

describe('rangeBetween', () => {
    test('orders a forward selection', () => {
        expect(
            rangeBetween({ segment: 0, index: 1 }, { segment: 0, index: 3 }),
        ).toEqual([
            { segment: 0, index: 1 },
            { segment: 0, index: 2 },
            { segment: 0, index: 3 },
        ]);
    });

    test('refuses a range whose ends are on different segments', () => {
        // The regression. b.segment was never read, so an anchor on segment 0
        // and a click on segment 1 produced a range inside segment 0 — vertices
        // the reviewer never indicated, which then move together on a drag and
        // get saved that way. Every route in the database is currently a single
        // segment, so this could not happen yet, which is exactly why it needs
        // a test written here rather than a report from the field.
        expect(
            rangeBetween({ segment: 0, index: 8 }, { segment: 1, index: 0 }),
        ).toEqual([]);
    });

    test('refuses the range whichever end is on the other segment', () => {
        expect(
            rangeBetween({ segment: 1, index: 0 }, { segment: 0, index: 8 }),
        ).toEqual([]);
    });

    test('an empty range clamps to an empty selection, not a wrong one', () => {
        // What the caller does with a refusal: the selection ends up empty
        // rather than holding a range nobody asked for.
        const twoSegments: Coordinates = [
            [
                [0, 0],
                [1, 0],
                [2, 0],
            ],
            [
                [3, 0],
                [4, 0],
            ],
        ];

        expect(
            clampRange(
                twoSegments,
                rangeBetween(
                    { segment: 0, index: 2 },
                    { segment: 1, index: 0 },
                ),
            ),
        ).toEqual([]);
    });

    test('still spans a whole segment when both ends are on it', () => {
        expect(
            rangeBetween({ segment: 1, index: 1 }, { segment: 1, index: 3 }),
        ).toEqual([
            { segment: 1, index: 1 },
            { segment: 1, index: 2 },
            { segment: 1, index: 3 },
        ]);
    });

    test('a backward selection yields the same range', () => {
        expect(
            rangeBetween({ segment: 0, index: 3 }, { segment: 0, index: 1 }),
        ).toEqual(
            rangeBetween({ segment: 0, index: 1 }, { segment: 0, index: 3 }),
        );
    });

    test('a single vertex is a range of one', () => {
        expect(
            rangeBetween({ segment: 0, index: 2 }, { segment: 0, index: 2 }),
        ).toEqual([{ segment: 0, index: 2 }]);
    });
});

describe('clampRange', () => {
    test('keeps only vertices the route actually has', () => {
        const range = rangeBetween(
            { segment: 0, index: 1 },
            { segment: 0, index: 9 },
        );

        expect(clampRange(square, range)).toEqual([
            { segment: 0, index: 1 },
            { segment: 0, index: 2 },
        ]);
    });

    test('drops a segment that no longer exists', () => {
        const range = rangeBetween(
            { segment: 5, index: 0 },
            { segment: 5, index: 1 },
        );

        expect(clampRange(square, range)).toEqual([]);
    });
});

describe('applyDeltaToSelection', () => {
    test('moves every selected vertex by the same offset', () => {
        const range = clampRange(
            square,
            rangeBetween({ segment: 0, index: 0 }, { segment: 0, index: 1 }),
        );

        const result = applyDeltaToSelection(square, range, [1, 2]);

        expect(result[0][0]).toEqual([1, 2]);
        expect(result[0][1]).toEqual([11, 2]);
    });

    test('leaves unselected vertices exactly where they were', () => {
        const result = applyDeltaToSelection(
            square,
            [{ segment: 0, index: 0 }],
            [5, 5],
        );

        expect(result[0][1]).toEqual([10, 0]);
        expect(result[0][2]).toEqual([10, 10]);
    });

    test('preserves the relative shape of the selection', () => {
        const range = clampRange(
            square,
            rangeBetween({ segment: 0, index: 0 }, { segment: 0, index: 1 }),
        );

        const before = applyDeltaToSelection(square, range, [0, 0]);
        const after = applyDeltaToSelection(square, range, [7, -3]);

        const dx = after[0][1][0] - after[0][0][0];
        const dy = after[0][1][1] - after[0][0][1];

        expect([dx, dy]).toEqual([
            before[0][1][0] - before[0][0][0],
            before[0][1][1] - before[0][0][1],
        ]);
    });

    test('does not mutate the input', () => {
        const before = snapshot(square);

        applyDeltaToSelection(square, [{ segment: 0, index: 0 }], [100, 100]);

        expect(square).toEqual(before);
    });

    test('an empty selection is a no-op that still copies', () => {
        const result = applyDeltaToSelection(square, [], [100, 100]);

        expect(result).toEqual(square);
        expect(result[0]).not.toBe(square[0]);
    });
});

describe('applyDeltaToSelection with a clamped range', () => {
    const route: Coordinates = [
        [
            [0, 0],
            [1, 0],
            [2, 0],
            [3, 0],
        ],
    ];

    test('a range covers every vertex between its endpoints', () => {
        const range = clampRange(
            route,
            rangeBetween({ segment: 0, index: 1 }, { segment: 0, index: 2 }),
        );

        expect(applyDeltaToSelection(route, range, [0.5, 0])[0]).toEqual([
            [0, 0],
            [1.5, 0],
            [2.5, 0],
            [3, 0],
        ]);
    });

    test('the stretch keeps its length after moving', () => {
        const range = clampRange(
            route,
            rangeBetween({ segment: 0, index: 0 }, { segment: 0, index: 2 }),
        );

        const moved = applyDeltaToSelection(route, range, [10, -4]);

        const before = range.length - 1;
        const after = moved[0][range.length - 1][0] - moved[0][0][0];

        expect(after).toBeCloseTo(before, 10);
    });

    test('a collapsed selection still moves its single vertex', () => {
        const moved = applyDeltaToSelection(
            route,
            [{ segment: 0, index: 2 }],
            [1, 1],
        );

        expect(moved[0]).toEqual([
            [0, 0],
            [1, 0],
            [3, 1],
            [3, 0],
        ]);
    });

    test('a repeated drag does not accumulate drift on unselected vertices', () => {
        const range = [{ segment: 0, index: 0 }];
        let current = route;

        for (let i = 0; i < 3; i++) {
            current = applyDeltaToSelection(current, range, [0.25, 0]);
        }

        expect(current[0][1]).toEqual([1, 0]);
        expect(current[0][0]).toEqual([0.75, 0]);
    });
});

describe('verticesWithinBounds', () => {
    const route: Coordinates = [
        [
            [0, 0],
            [1, 5],
            [2, 0],
            [3, 50],
            [4, 0],
        ],
    ];

    /** A box around the low points, leaving the spike in the middle out. */
    const lowBox = ([, lat]: [number, number]): boolean => lat < 10;

    test('collects only the vertices inside', () => {
        expect(verticesWithinBounds(route, lowBox)).toEqual([
            { segment: 0, index: 0 },
            { segment: 0, index: 1 },
            { segment: 0, index: 2 },
            { segment: 0, index: 4 },
        ]);
    });

    test('returns them in route order regardless of the box', () => {
        const wide = verticesWithinBounds(route, () => true);

        expect(wide.map((ref) => ref.index)).toEqual([0, 1, 2, 3, 4]);
    });

    test('a box catching nothing yields an empty selection', () => {
        expect(verticesWithinBounds(route, () => false)).toEqual([]);
    });

    test('spans segments and indexes them separately', () => {
        const twoSegments: Coordinates = [
            [
                [0, 0],
                [1, 0],
            ],
            [
                [2, 0],
                [3, 0],
            ],
        ];

        expect(verticesWithinBounds(twoSegments, lowBox)).toEqual([
            { segment: 0, index: 0 },
            { segment: 0, index: 1 },
            { segment: 1, index: 0 },
            { segment: 1, index: 1 },
        ]);
    });

    test('a marquee selection is draggable as one rigid stretch', () => {
        const inside = verticesWithinBounds(route, lowBox);
        const moved = applyDeltaToSelection(route, inside, [1, 0]);

        // The excluded spike stayed put while the rest shifted.
        expect(moved[0][3]).toEqual([3, 50]);
        expect(moved[0][0]).toEqual([1, 0]);
        expect(moved[0][4]).toEqual([5, 0]);
    });
});

describe('routeEndpoints', () => {
    test('reads the first and last position across segments', () => {
        const route: Coordinates = [
            [
                [0, 0],
                [1, 1],
            ],
            [
                [2, 2],
                [3, 3],
            ],
        ];

        expect(routeEndpoints(route)).toEqual({
            start: [0, 0],
            end: [3, 3],
        });
    });

    test('returns null below two positions so pins do not stack', () => {
        expect(routeEndpoints([[[0, 0]]])).toBeNull();
    });

    test('counts positions across segments, not per segment', () => {
        // Neither segment is drawable alone, but the route still has two ends.
        const route: Coordinates = [[[0, 0]], [[5, 5]]];

        expect(routeEndpoints(route)).toEqual({
            start: [0, 0],
            end: [5, 5],
        });
    });

    test('returns null for an empty route', () => {
        expect(routeEndpoints([])).toBeNull();
    });
});

describe('decideSnap', () => {
    const normal = SNAP_PRESETS.normal;

    test('applies a candidate inside the threshold', () => {
        const decision = decideSnap(
            { position: [10, 10], distance: 4 },
            normal,
        );

        expect(decision.apply).toBe(true);
        expect(decision.position).toEqual([10, 10]);
    });

    test('declines rather than clamps a candidate beyond the threshold', () => {
        const decision = decideSnap(
            { position: [10, 10], distance: 200 },
            normal,
        );

        expect(decision.apply).toBe(false);
        expect(decision.position).toBeNull();
    });

    test('a modifier bypasses an otherwise valid candidate', () => {
        const decision = decideSnap(
            { position: [10, 10], distance: 1 },
            { ...normal, bypass: true },
        );

        expect(decision.apply).toBe(false);
    });

    test('handles having no candidate at all', () => {
        expect(decideSnap(null, normal).apply).toBe(false);
    });

    test('returns a copy of the position, not the candidate itself', () => {
        const candidate: { position: Position; distance: number } = {
            position: [10, 10],
            distance: 1,
        };

        const decision = decideSnap(candidate, normal);

        expect(decision.position).not.toBe(candidate.position);
        expect(decision.position).toEqual(candidate.position);
    });

    test('a street the moved vertices mostly voted against still snaps', () => {
        // The regression, written down so it cannot come back quietly. This
        // candidate used to carry `votes: 1, samples: 7` and be refused for
        // lack of agreement, which is what made dragging a selection of three
        // or more vertices do nothing at all — a route is many streets, so the
        // moved vertices almost never agree, and a rule that needed them to was
        // refusing the ordinary case. The candidate no longer has anywhere to
        // put support; the server uses it to pick the street, not to veto it.
        const decision = decideSnap(
            { position: [10, 10], distance: 3 },
            normal,
        );

        expect(decision.apply).toBe(true);
        expect(decision.position).toEqual([10, 10]);
    });

    test('a wide preset accepts a distance the normal one refuses', () => {
        // The presets only differ in this one number now, so this is the whole
        // of what choosing one over another buys.
        const decision = decideSnap(
            { position: [10, 10], distance: 40 },
            SNAP_PRESETS.normal,
        );

        expect(decision.apply).toBe(false);
        expect(
            decideSnap(
                { position: [10, 10], distance: 40 },
                SNAP_PRESETS.aggressive,
            ).apply,
        ).toBe(true);
    });

    test('a candidate exactly on the threshold is still accepted', () => {
        // The comparison is `>` and not `>=`, so a street exactly at the limit
        // snaps. Snapping right at the boundary is the point of a limit.
        const decision = decideSnap(
            { position: [10, 10], distance: normal.threshold },
            normal,
        );

        expect(decision.apply).toBe(true);
    });

    test('every preset that snaps gets stricter as it is dialled back', () => {
        // A control the user can move in a direction that does nothing is worse
        // than no control, so the ordering is asserted rather than assumed.
        expect(SNAP_PRESETS.subtle.threshold).toBeLessThan(
            SNAP_PRESETS.normal.threshold,
        );
        expect(SNAP_PRESETS.normal.threshold).toBeLessThan(
            SNAP_PRESETS.aggressive.threshold,
        );
    });
});

describe('snapOptionsFor', () => {
    test('off has no settings at all', () => {
        // Not a threshold of zero: that would still snap a vertex dropped at
        // exactly zero metres, which is what makes "off" a lie.
        expect(snapOptionsFor('off')).toBeNull();
    });

    test('every other preset resolves to its published numbers', () => {
        for (const preset of ['subtle', 'normal', 'aggressive'] as const) {
            expect(snapOptionsFor(preset)).toEqual(SNAP_PRESETS[preset]);
        }
    });
});

describe('snapSearchRadius', () => {
    test('is never narrower than the threshold it serves', () => {
        // A radius tighter than the threshold would make the threshold
        // unreachable for the presets that widen it.
        for (const preset of ['subtle', 'normal', 'aggressive'] as const) {
            const options = SNAP_PRESETS[preset];

            expect(snapSearchRadius(options)).toBeGreaterThanOrEqual(
                options.threshold,
            );
        }
    });

    test('widens with the threshold so aggressive looks further out', () => {
        expect(snapSearchRadius(SNAP_PRESETS.aggressive)).toBeGreaterThan(
            snapSearchRadius(SNAP_PRESETS.normal),
        );
    });
});

describe('snapSample', () => {
    /** A straight run of `count` vertices along the x axis. */
    function run(count: number): Coordinates {
        return [Array.from({ length: count }, (_, i) => [i, 0])];
    }

    function refs(count: number): VertexRef[] {
        return Array.from({ length: count }, (_, i) => ({
            segment: 0,
            index: i,
        }));
    }

    test('asks about only the grabbed vertex when it is the only one selected', () => {
        const grabbed = { segment: 0, index: 4 };

        expect(snapSample(run(10), [grabbed], grabbed)).toEqual([[4, 0]]);
    });

    test('puts the grabbed vertex first', () => {
        // The caller derives one rigid offset from this point, so a response
        // describing a different point would move the stretch somewhere nobody
        // dropped it.
        const sample = snapSample(
            run(20),
            refs(20),
            { segment: 0, index: 11 },
            4,
        );

        expect(sample[0]).toEqual([11, 0]);
    });

    test('never asks about more points than the limit allows', () => {
        const sample = snapSample(
            run(200),
            refs(200),
            { segment: 0, index: 0 },
            SNAP_SAMPLE_LIMIT,
        );

        expect(sample).toHaveLength(SNAP_SAMPLE_LIMIT);
    });

    test('samples the far end of a long stretch, not just its middle', () => {
        // A stretch that only agrees with itself near the grabbed vertex is
        // exactly the disagreement agreement exists to catch, so the samples
        // have to reach the end.
        const sample = snapSample(
            run(50),
            refs(50),
            { segment: 0, index: 0 },
            5,
        );

        expect(sample.at(-1)).toEqual([49, 0]);
    });

    test('takes the whole selection when it is smaller than the limit', () => {
        const sample = snapSample(
            run(10),
            refs(3),
            { segment: 0, index: 0 },
            SNAP_SAMPLE_LIMIT,
        );

        expect(sample).toEqual([
            [0, 0],
            [1, 0],
            [2, 0],
        ]);
    });

    test('samples a selection given out of order along the route', () => {
        const sample = snapSample(
            run(20),
            [
                { segment: 0, index: 5 },
                { segment: 0, index: 1 },
                { segment: 0, index: 3 },
            ],
            { segment: 0, index: 0 },
            4,
        );

        expect(sample).toEqual([
            [0, 0],
            [1, 0],
            [3, 0],
            [5, 0],
        ]);
    });

    test('does not spend two sample slots on one position', () => {
        // Two vertices sharing a corner would otherwise vote twice for the same
        // answer and inflate its agreement.
        const coordinates: Coordinates = [
            [
                [0, 0],
                [5, 0],
                [5, 0],
            ],
        ];

        const sample = snapSample(
            coordinates,
            refs(3),
            { segment: 0, index: 0 },
            SNAP_SAMPLE_LIMIT,
        );

        expect(sample).toEqual([
            [0, 0],
            [5, 0],
        ]);
    });

    test('spreads samples across every segment of a multi-part route', () => {
        const coordinates: Coordinates = [
            [
                [0, 0],
                [1, 0],
            ],
            [
                [2, 0],
                [3, 0],
            ],
        ];

        const sample = snapSample(
            coordinates,
            [
                { segment: 0, index: 1 },
                { segment: 1, index: 0 },
                { segment: 1, index: 1 },
            ],
            { segment: 0, index: 0 },
            SNAP_SAMPLE_LIMIT,
        );

        expect(sample).toEqual([
            [0, 0],
            [1, 0],
            [2, 0],
            [3, 0],
        ]);
    });

    test('returns nothing when the grabbed vertex does not exist', () => {
        // A stale ref should cost the snap, not send a point the user never
        // dropped.
        expect(snapSample(run(3), refs(3), { segment: 0, index: 99 })).toEqual(
            [],
        );
    });
});

describe('longitudeScale', () => {
    test('shrinks towards the poles, which is why degrees are not distances', () => {
        // The reason the whole feature measures in metres. One degree of
        // longitude is 5% shorter in Santa Cruz than at the equator and 43%
        // shorter at 60 north, so a limit left in degrees would be a different
        // limit on every route in the city.
        expect(longitudeScale(0)).toBeCloseTo(1, 6);
        expect(longitudeScale(-17.78)).toBeCloseTo(0.952, 3);
        expect(longitudeScale(60)).toBeCloseTo(0.5, 3);
    });

    test('treats the two hemispheres the same, since only the magnitude matters', () => {
        expect(longitudeScale(-17.78)).toBeCloseTo(longitudeScale(17.78), 10);
    });

    test('never returns zero, which would divide by zero on the way back', () => {
        // cos(90 deg) is 0, and the walk divides by this to turn a measured
        // position back into a real longitude.
        expect(longitudeScale(90)).toBeGreaterThan(0);
        expect(longitudeScale(-90)).toBeGreaterThan(0);
        expect(longitudeScale(1000)).toBeGreaterThan(0);
    });
});

describe('propagationLimitsFor', () => {
    test('takes the offset from the preset and nothing else', () => {
        // One number the reviewer calibrates, deliberately. A second setting
        // here would be a second thing to tune with no visible reason to
        // disagree with the threshold they just chose.
        expect(propagationLimitsFor(25)).toEqual({
            maxOffset: 25,
            maxArc: PROPAGATION_MAX_ARC_METERS,
            maxVertices: PROPAGATION_MAX_VERTICES,
        });
    });

    test('rides the threshold when the preset changes', () => {
        expect(
            propagationLimitsFor(SNAP_PRESETS.subtle.threshold).maxOffset,
        ).toBe(12);
        expect(
            propagationLimitsFor(SNAP_PRESETS.aggressive.threshold).maxOffset,
        ).toBe(50);
    });
});

/**
 * Fixtures for the walk, all in Santa Cruz at about -17.78.
 *
 * A degree of longitude there is ~106 000 m, so a thousandth of a degree is
 * about 106 m and a ten-thousandth about 10.6 m. The route sits 11 m south of
 * the centreline, which is a real offset on a real route · the imported data
 * averages 3.6 m from a centreline with a p90 of 8.2 m · and comfortably inside
 * the 25 m the normal preset allows.
 */
describe('propagateAlongStreet', () => {
    const CENTRELINE_LAT = -17.78;

    /**
     * A straight street running east, `segments` segments of about 106 m.
     *
     * Latitude is a parameter rather than fixed because one of the cases below
     * is about what the same number of degrees means in different places, and
     * that is only a question if the street and the route are compared at the
     * same latitude.
     */
    const street = (
        segments: number,
        latitude = CENTRELINE_LAT,
    ): Coordinates => [
        Array.from({ length: segments + 1 }, (_, i) => [
            -63.18 + i * 0.001,
            latitude,
        ]),
    ];

    /** The default fixture: a 5-vertex route running east beside the street. */
    const route = (): Coordinates => [
        [
            [-63.181, CENTRELINE_LAT - 0.0001],
            [-63.18, CENTRELINE_LAT - 0.0001],
            // The dropped vertex, already snapped onto the centreline. The walk
            // starts from the geometry that carries the snap, so this is what it
            // always sees.
            [-63.179, CENTRELINE_LAT],
            [-63.178, CENTRELINE_LAT - 0.0001],
            [-63.177, CENTRELINE_LAT - 0.0001],
        ],
    ];

    const REFERENCE: VertexRef = { segment: 0, index: 2 };
    const limits = (
        over: Partial<PropagationLimits> = {},
    ): PropagationLimits => ({
        ...propagationLimitsFor(25),
        ...over,
    });

    // The centreline is required rather than defaulted, so that a case testing
    // what happens without one can actually pass "without one" instead of
    // quietly getting a street.
    const walk = (
        coordinates: Coordinates,
        centreline: Coordinates | null,
        direction: PropagationDirection = 1,
        over: Partial<PropagationLimits> = {},
        reference: VertexRef = REFERENCE,
    ) =>
        propagateAlongStreet(
            coordinates,
            reference,
            centreline,
            direction,
            limits(over),
        );

    test('pulls the following vertices onto the centreline', () => {
        const result = walk(route(), street(3));

        // Two ahead, both landing on the street rather than 11 m south of it.
        expect(result.moved).toEqual([
            { segment: 0, index: 3 },
            { segment: 0, index: 4 },
        ]);
        expect(result.coordinates[0][3][1]).toBeCloseTo(CENTRELINE_LAT, 9);
        expect(result.coordinates[0][4][1]).toBeCloseTo(CENTRELINE_LAT, 9);
    });

    test('leaves the dropped vertex and everything behind it alone', () => {
        const result = walk(route(), street(3));

        // Forward only. The walk is asked for one direction and takes one, which
        // is what lets the caller run both without them interfering.
        expect(result.coordinates[0][0]).toEqual([
            -63.181,
            CENTRELINE_LAT - 0.0001,
        ]);
        expect(result.coordinates[0][1]).toEqual([
            -63.18,
            CENTRELINE_LAT - 0.0001,
        ]);
        expect(result.coordinates[0][2]).toEqual([-63.179, CENTRELINE_LAT]);
    });

    test('walks backwards, for the kink behind the drop', () => {
        const result = walk(route(), street(3), -1);

        // One behind, and then the street runs out: the vertex at index 0 is
        // 106 m west of where the centreline begins.
        expect(result.moved).toEqual([{ segment: 0, index: 1 }]);
        expect(result.coordinates[0][1][1]).toBeCloseTo(CENTRELINE_LAT, 9);
    });

    test('never folds a vertex back to the near end of the street', () => {
        // The case the whole windowed search exists for. A plain "closest point
        // on the street" would answer chainage 0 for the vertex at index 4, and
        // every drop on a long route would scribble the geometry back over
        // itself. Here the reference is at the far end and the next vertex sits
        // beside the near end, so the only thing the walk may consider is the
        // single point where the street runs out · 318 m away, and refused.
        const folded: Coordinates = [
            [
                [-63.18, CENTRELINE_LAT],
                [-63.179, CENTRELINE_LAT],
                [-63.178, CENTRELINE_LAT],
                [-63.177, CENTRELINE_LAT],
                [-63.18, CENTRELINE_LAT - 0.0001],
            ],
        ];

        const result = walk(folded, street(3), 1, {}, { segment: 0, index: 3 });

        expect(result.moved).toEqual([]);
        expect(result.coordinates).toEqual(folded);
    });

    test('stops at the first vertex too far off the centreline', () => {
        // The route announcing it has left this street · a turn, or the end of
        // the block. Everything past it is a different street's business, so the
        // vertices after it are left alone even though they are perfectly placed.
        const turning: Coordinates = [
            [
                [-63.179, CENTRELINE_LAT],
                [-63.178, CENTRELINE_LAT - 0.01],
                [-63.177, CENTRELINE_LAT],
            ],
        ];

        const result = walk(
            turning,
            street(3),
            1,
            {},
            {
                segment: 0,
                index: 0,
            },
        );

        expect(result.moved).toEqual([]);
        expect(result.coordinates).toEqual(turning);
    });

    test('stops at the end of the way, which is the honest limit', () => {
        // Two segments end 212 m along. The route's fourth vertex sits exactly
        // there and is taken; the fifth is a further 106 m west, past the end of
        // the way, and is left alone. A named street made of 38 ways is corrected
        // one way at a time, and this is what that looks like from inside.
        const result = walk(route(), street(2));

        expect(result.moved).toEqual([{ segment: 0, index: 3 }]);
        expect(result.coordinates[0][4]).toEqual([
            -63.177,
            CENTRELINE_LAT - 0.0001,
        ]);
    });

    test('never crosses a segment boundary', () => {
        // A route's segments are not a continuation of each other. The second
        // vertex of segment 0 is beside the street and is taken, and then the
        // walk stops — even though segment 1's vertices are equally close to it
        // and would otherwise be next in line.
        const split: Coordinates = [
            [
                [-63.179, CENTRELINE_LAT],
                [-63.178, CENTRELINE_LAT - 0.0001],
            ],
            [
                [-63.177, CENTRELINE_LAT - 0.0001],
                [-63.176, CENTRELINE_LAT - 0.0001],
            ],
        ];

        const result = walk(split, street(3), 1, {}, { segment: 0, index: 0 });

        expect(result.moved).toEqual([{ segment: 0, index: 1 }]);
        expect(result.coordinates[1]).toEqual([
            [-63.177, CENTRELINE_LAT - 0.0001],
            [-63.176, CENTRELINE_LAT - 0.0001],
        ]);
    });

    test('stays inside the part of a split street it started in', () => {
        // A road can be stored as more than one part with a real gap. Stepping
        // over that gap would lay the route across whatever is in it.
        const twoParts: Coordinates = [
            [
                [-63.179, CENTRELINE_LAT],
                [-63.178, CENTRELINE_LAT],
            ],
            [
                [-63.17, CENTRELINE_LAT],
                [-63.169, CENTRELINE_LAT],
            ],
        ];

        const result = walk(route(), twoParts);

        expect(result.moved).toEqual([{ segment: 0, index: 3 }]);
        expect(result.coordinates[0][3][1]).toBeCloseTo(CENTRELINE_LAT, 9);
    });

    test('honours the vertex cap even when every vertex qualifies', () => {
        const result = walk(route(), street(3), 1, { maxVertices: 1 });

        expect(result.moved).toEqual([{ segment: 0, index: 3 }]);
    });

    test('honours the arc cap, which bounds a long straight', () => {
        // Ten segments is about a kilometre of street and the next vertex is only
        // 106 m along it, so 250 m of arc would take it. At 30 m the walk cannot
        // even reach it: the closest point inside the window is 76 m from the
        // vertex, which is further than the offset limit as well. A route running
        // exactly along a street is the case that would otherwise be pulled as
        // far as the reviewer cared to look.
        expect(walk(route(), street(10), 1, { maxArc: 250 }).moved).toEqual([
            { segment: 0, index: 3 },
            { segment: 0, index: 4 },
        ]);
        expect(walk(route(), street(10), 1, { maxArc: 30 }).moved).toEqual([]);
    });

    test('a limit of zero takes nothing, and a negative one is not a licence', () => {
        // The guard the 'off' preset gets for free by returning null: a zero
        // threshold would otherwise still take a vertex dropped at exactly zero.
        expect(walk(route(), street(3), 1, { maxOffset: 0 }).moved).toEqual([]);
        expect(walk(route(), street(3), 1, { maxOffset: -5 }).moved).toEqual(
            [],
        );
        expect(walk(route(), street(3), 1, { maxVertices: 0 }).moved).toEqual(
            [],
        );
    });

    test('does not mutate the route it was given', () => {
        // A walk that took two vertices is the case worth asserting: the one that
        // takes none returns the input by identity and cannot mutate it.
        const before = route();
        const copy = snapshot(before);

        walk(before, street(3));

        expect(before).toEqual(copy);
    });

    test('returns the input untouched when nothing is taken', () => {
        // Most drops propagate nothing, and a route of five hundred vertices
        // should not be deep-copied to say so. Identity is asserted rather than
        // equality because it is the cheaper contract callers rely on.
        const untouched = route();

        // One segment of street puts the reference at its far end, so the very
        // next vertex is out of reach.
        expect(walk(untouched, street(1), 1).coordinates).toBe(untouched);
        expect(walk(untouched, null).coordinates).toBe(untouched);
    });

    test('gives up rather than guess when there is no street to walk', () => {
        const before = route();

        // A response with no usable centreline is a normal outcome, not an
        // error: the drop still snapped, and the street it snapped to is on
        // screen either way.
        expect(walk(before, null).moved).toEqual([]);
        expect(walk(before, []).moved).toEqual([]);
        expect(walk(before, [[[0, 0]]]).moved).toEqual([]);
    });

    test('gives up when the reference does not exist', () => {
        // A stale ref costs the propagation, not a walk from the wrong place.
        expect(
            walk(
                route(),
                street(3),
                1,
                {},
                {
                    segment: 0,
                    index: 99,
                },
            ).moved,
        ).toEqual([]);
        expect(
            walk(
                route(),
                street(3),
                1,
                {},
                {
                    segment: 7,
                    index: 0,
                },
            ).moved,
        ).toEqual([]);
    });

    test('walks from the vertex it was pointed at, not a fixed index', () => {
        // Same route, different drop. Starting from index 1 walks two vertices
        // forward; the ones behind are another walk's business.
        const result = walk(
            route(),
            street(3),
            1,
            {},
            {
                segment: 0,
                index: 1,
            },
        );

        expect(result.moved).toEqual([
            { segment: 0, index: 2 },
            { segment: 0, index: 3 },
            { segment: 0, index: 4 },
        ]);
    });

    test('measures the offset in metres, not in degrees', () => {
        // A north-south street, so the vertex's offset from it is a *longitude*
        // difference — which is the one that shrinks with latitude. The same
        // 0.0005 deg is 53 m in Santa Cruz and 32 m at 55 north, so a 40 m limit
        // takes the vertex at one latitude and refuses it at the other. Read in
        // degrees the walk would behave differently on every route in the city
        // for no reason a reviewer could see, which is what the metric frame is
        // for.
        const northSouth = (latitude: number): Coordinates => [
            Array.from({ length: 4 }, (_, i) => [-63.18, latitude + i * 0.001]),
        ];
        const offsetEast = (latitude: number): Coordinates => [
            [
                [-63.18, latitude],
                [-63.1795, latitude + 0.001],
            ],
        ];

        const start: VertexRef = { segment: 0, index: 0 };
        const limit = { maxOffset: 40 };

        expect(
            walk(
                offsetEast(CENTRELINE_LAT),
                northSouth(CENTRELINE_LAT),
                1,
                limit,
                start,
            ).moved,
        ).toEqual([]);
        expect(
            walk(offsetEast(55), northSouth(55), 1, limit, start).moved,
        ).toEqual([{ segment: 0, index: 1 }]);
    });
});

describe('relayLimitsFor', () => {
    test('takes the offset from the preset and the spacing from the project', () => {
        // The offset is the reviewer's own calibration; the spacing is the ten
        // metres the editor already refuses to add a vertex within, so neither is
        // a second number to tune.
        expect(relayLimitsFor(25)).toEqual({
            maxOffset: 25,
            minSpacing: RELAY_MIN_SPACING_METERS,
        });
    });

    test('rides the threshold when the preset changes', () => {
        expect(relayLimitsFor(SNAP_PRESETS.subtle.threshold).maxOffset).toBe(
            12,
        );
        expect(
            relayLimitsFor(SNAP_PRESETS.aggressive.threshold).maxOffset,
        ).toBe(50);
    });
});

/**
 * Fixtures for the re-lay, all in Santa Cruz at about -17.78.
 *
 * A degree of longitude is ~106 000 m there, so a thousandth of a degree is
 * about 106 m. Streets run east-west unless stated otherwise.
 */
describe('relaySelectionOntoNetwork', () => {
    const LAT = -17.78;

    /**
     * A straight street running east, `segments` of about 106 m each, from
     * `fromLng`.
     *
     * The start is a parameter because a route that runs past the end of its
     * street is a different case from one that does not, and mixing them up
     * makes a test assert the clamping behaviour while claiming to assert
     * something else.
     */
    const street = (segments: number, fromLng = -63.18): Coordinates => [
        Array.from({ length: segments + 1 }, (_, i) => [
            fromLng + i * 0.001,
            LAT,
        ]),
    ];

    /** A north-south street crossing the first at the anchor. */
    const crossStreet: Coordinates = [
        Array.from({ length: 11 }, (_, i) => [-63.18, LAT - 0.005 + i * 0.001]),
    ];

    const lookup = (
        line: Coordinates | null,
        over: Partial<StreetLookup> = {},
    ): StreetLookup => ({
        roadId: 1,
        name: 'Calle Mercado',
        votes: 3,
        distance: 4,
        line,
        ...over,
    });

    const limits = (over: Partial<RelayLimits> = {}): RelayLimits => ({
        ...relayLimitsFor(25),
        ...over,
    });

    const selection = (...indices: number[]): VertexRef[] =>
        indices.map((index) => ({ segment: 0, index }));

    const run = (
        coordinates: Coordinates,
        refs: VertexRef[],
        lookups: StreetLookup[],
        over: Partial<RelayLimits> = {},
    ) => relaySelectionOntoNetwork(coordinates, refs, lookups, limits(over));

    test('moves a straight run onto the street it runs along', () => {
        // The case the whole feature exists for: points 11 m south of a road,
        // dragged into a line, and the network says what the shape should be.
        const line: Coordinates = [
            [
                [-63.181, LAT - 0.0001],
                [-63.18, LAT - 0.0001],
                [-63.179, LAT - 0.0001],
                [-63.178, LAT - 0.0001],
            ],
        ];

        const result = run(
            line,
            selection(0, 1, 2, 3),
            [0, 1, 2, 3].map(() => lookup(street(6, -63.182))),
        );

        expect(result.moved).toHaveLength(4);

        // Compared with a tolerance rather than for equality, because every
        // position makes a round trip through the metric frame — scaled by the
        // cosine of the latitude and back — and that leaves the last few bits
        // different. It is worth stating here so a future reader does not take
        // the noise for drift: it is a few times 1e-15 of a degree, which is a
        // ten-thousandth of a millimetre.
        for (const position of result.coordinates[0]) {
            expect(position[1]).toBeCloseTo(LAT, 9);
        }

        // The lngs are untouched, because the route was only ever displaced
        // sideways — the street runs east and so does the route. That is the
        // difference between a re-lay and a drag: nothing slides along the road.
        for (const [i, expected] of [
            -63.181, -63.18, -63.179, -63.178,
        ].entries()) {
            expect(result.coordinates[0][i][0]).toBeCloseTo(expected, 9);
        }
    });

    test('re-lays in route order however the selection arrived', () => {
        // A box gesture has no order of its own, and both invariants are
        // statements about order, so an unsorted selection would be meaningless.
        const line: Coordinates = [
            [
                [-63.181, LAT - 0.0001],
                [-63.18, LAT - 0.0001],
                [-63.179, LAT - 0.0001],
            ],
        ];

        const result = run(
            line,
            selection(2, 0, 1),
            [0, 1, 2].map(() => lookup(street(4))),
        );

        expect(result.moved.map((ref) => ref.index)).toEqual([0, 1, 2]);
        expect(result.coordinates[0].map((p) => p[1])).toEqual([LAT, LAT, LAT]);
    });

    test('lets a corner be two streets', () => {
        // The reason this is per vertex rather than per selection. The point
        // before the corner belongs to the street the route came along, the point
        // after belongs to the one it turned onto, and neither is wrong · so a
        // rule that demanded one street for the whole selection would have to be
        // wrong about one of them.
        const line: Coordinates = [
            [
                [-63.181, LAT],
                [-63.18, LAT],
                [-63.18, LAT + 0.0001],
                [-63.18, LAT + 0.001],
            ],
        ];

        const result = run(line, selection(0, 1, 2, 3), [
            lookup(street(4), { roadId: 1, name: 'Calle Mercado' }),
            lookup(street(4), { roadId: 1, name: 'Calle Mercado' }),
            lookup(crossStreet, { roadId: 2, name: 'Av. Ca·oto' }),
            lookup(crossStreet, { roadId: 2, name: 'Av. Ca·oto' }),
        ]);

        expect(result.moved).toHaveLength(4);
        expect(result.streets.map((s) => s.name)).toEqual([
            'Calle Mercado',
            'Av. Ca·oto',
        ]);
        expect(result.streets.map((s) => s.placed)).toEqual([2, 2]);
    });

    test('exempts a corner from the minimum spacing', () => {
        // The rule is per street precisely so this is not a violation. Where a
        // route turns, the street it came along ends and the next one begins a
        // metre or two away, and enforcing ten metres across that would shove
        // both vertices down their own streets and flatten every turn in the
        // selection into a rounded corner that is not on the map.
        //
        // The east street starts west of the corner so the vertex before the turn
        // is not already sitting on its west end, which would make this assert
        // clamping rather than the exemption.
        const line: Coordinates = [
            [
                [-63.181, LAT],
                [-63.18, LAT],
                [-63.18, LAT + 0.00001],
            ],
        ];

        const result = run(line, selection(0, 1, 2), [
            lookup(street(4, -63.182), { roadId: 1 }),
            lookup(street(4, -63.182), { roadId: 1 }),
            lookup(crossStreet, { roadId: 2 }),
        ]);

        // Vertex 0 is 106 m along its street and vertex 1 is at the corner, so
        // they are 106 m apart and the ten-metre rule had nothing to do. Vertex 2
        // is one metre north of vertex 1 on a different street, and stayed there.
        expect(result.coordinates[0][0][0]).toBeCloseTo(-63.181, 6);
        expect(result.coordinates[0][1][0]).toBeCloseTo(-63.18, 6);
        expect(result.coordinates[0][2][0]).toBeCloseTo(-63.18, 9);
        expect(result.coordinates[0][2][1]).toBeCloseTo(LAT + 0.00001, 9);
        // The two streets are reported separately, which is what makes the corner
        // legible afterwards: one street did not swallow the turn.
        expect(result.streets.map((s) => s.placed)).toEqual([2, 1]);
    });

    test('keeps two vertices on one street from landing on the same spot', () => {
        // A reviewer selecting two vertices that sit on top of each other, or a
        // street that doubles back near itself, both produce this. Coincident
        // points are the failure the minimum exists to prevent: they draw as one
        // and ST_DumpPoints reports a position for a stop that is not there.
        const line: Coordinates = [
            [
                [-63.18, LAT - 0.0001],
                [-63.18, LAT - 0.0001],
            ],
        ];

        const result = run(line, selection(0, 1), [
            lookup(street(4)),
            lookup(street(4)),
        ]);

        const a = result.coordinates[0][0];
        const b = result.coordinates[0][1];
        const apart =
            Math.hypot(a[0] - b[0], a[1] - b[1]) *
            111320 *
            Math.cos((LAT * Math.PI) / 180);

        expect(apart).toBeGreaterThan(RELAY_MIN_SPACING_METERS - 1);
    });

    test('never places a vertex behind one already on the same street', () => {
        // The cursor, and why it is per street rather than global: a route that
        // leaves a street and rejoins it further along must not be able to send
        // its second visit backwards down the road it is already on.
        //
        // Three vertices on a five-segment street: two travelling east, the third
        // back west past the start. The third has nowhere to go that is not behind
        // the first, so it is refused to move backwards and clamped to the west
        // end instead — which is a coincidence with vertex 1's start, not a
        // reversal.
        const line: Coordinates = [
            [
                [-63.182, LAT - 0.0001],
                [-63.181, LAT - 0.0001],
                [-63.183, LAT - 0.0001],
            ],
        ];

        const result = run(line, selection(0, 1, 2), [
            lookup(street(5, -63.182)),
            lookup(street(5, -63.182)),
            lookup(street(5, -63.182)),
        ]);

        expect(result.moved).toHaveLength(3);
        // Monotone: no vertex is west of the one before it on the same street.
        expect(result.coordinates[0][1][0]).toBeGreaterThanOrEqual(
            result.coordinates[0][0][0],
        );
        expect(result.coordinates[0][2][0]).toBeGreaterThanOrEqual(
            result.coordinates[0][1][0],
        );
        // And it did not slide back down the road to reach the west end it asked
        // for. It went *forward* to the nearest position the cursor allows, which
        // is the spacing rule doing its job rather than the clamping: putting it
        // at the west end would have been behind vertex 1, and behind is the one
        // thing a cursor exists to prevent.
        const gap =
            (result.coordinates[0][2][0] - result.coordinates[0][1][0]) *
            111320 *
            Math.cos((LAT * Math.PI) / 180);

        expect(gap).toBeGreaterThan(RELAY_MIN_SPACING_METERS - 1);
        expect(gap).toBeLessThan(RELAY_MIN_SPACING_METERS + 15);
    });

    test('leaves a vertex alone when no street is within range', () => {
        // Thirty-six vertices across nine codes are in exactly this position: the
        // imported network does not reach them. Nothing is invented for one, and
        // it does not move any street's cursor either.
        const line: Coordinates = [
            [
                [-63.181, LAT - 0.0001],
                [-63.18, LAT - 0.0001],
                [-63.179, LAT - 0.0001],
            ],
        ];

        const result = run(line, selection(0, 1, 2), [
            lookup(street(4)),
            lookup(street(4), { distance: 400 }),
            lookup(street(4)),
        ]);

        expect(result.moved.map((ref) => ref.index)).toEqual([0, 2]);
        expect(result.unmatched).toBe(1);
        expect(result.coordinates[0][1]).toEqual([-63.18, LAT - 0.0001]);
    });

    test('leaves a vertex alone when the response carried no geometry', () => {
        const line: Coordinates = [
            [
                [-63.18, LAT - 0.0001],
                [-63.179, LAT - 0.0001],
            ],
        ];

        const result = run(line, selection(0, 1), [
            lookup(street(4)),
            lookup(null),
        ]);

        expect(result.moved.map((ref) => ref.index)).toEqual([0]);
        expect(result.unmatched).toBe(1);
    });

    test('reports the separation it actually achieved, not the one it asked for', () => {
        // A street too short for the vertices put on it cannot give them ten
        // metres each. Printing the target when the result was four metres would
        // be a claim about the geometry the reviewer has no way to check.
        const line: Coordinates = [
            [
                [-63.181, LAT - 0.0001],
                [-63.18, LAT - 0.0001],
                [-63.179, LAT - 0.0001],
                [-63.178, LAT - 0.0001],
                [-63.177, LAT - 0.0001],
            ],
        ];

        // A single 106 m segment for five vertices: 10 m each fits exactly, and a
        // shorter one does not.
        const tight: Coordinates = [
            [
                [-63.18, LAT],
                [-63.179, LAT],
            ],
        ];

        const roomy = run(
            line,
            selection(0, 1, 2, 3, 4),
            [0, 1, 2, 3, 4].map(() => lookup(tight)),
        );

        expect(roomy.streets).toHaveLength(1);
        expect(roomy.streets[0].placed).toBe(5);
        // Every vertex lands on the 106 m way, so the tightest pair is at its
        // ends and the number is reported rather than assumed.
        expect(roomy.streets[0].closestSpacing).not.toBeNull();
        expect(roomy.streets[0].closestSpacing).toBeLessThanOrEqual(
            RELAY_MIN_SPACING_METERS,
        );
    });

    test('has no separation to report while only one vertex is on a street', () => {
        const line: Coordinates = [[[-63.18, LAT - 0.0001]]];

        const result = run(line, selection(0), [lookup(street(4))]);

        expect(result.moved).toHaveLength(1);
        expect(result.streets[0].closestSpacing).toBeNull();
    });

    test('does not mutate the route it was given', () => {
        const line: Coordinates = [
            [
                [-63.181, LAT - 0.0001],
                [-63.18, LAT - 0.0001],
            ],
        ];
        const copy = snapshot(line);

        run(line, selection(0, 1), [lookup(street(4)), lookup(street(4))]);

        expect(line).toEqual(copy);
    });

    test('returns the input untouched when nothing is moved', () => {
        // Most selections are not fully on-network, and a route of five hundred
        // vertices should not be deep-copied to say so.
        const line: Coordinates = [[[-63.18, LAT - 0.0001]]];

        expect(run(line, selection(0), []).coordinates).toBe(line);
        expect(run(line, selection(), [lookup(street(4))]).coordinates).toBe(
            line,
        );
        expect(
            run(line, selection(0), [lookup(street(4), { distance: 900 })])
                .coordinates,
        ).toBe(line);
    });

    test('gives up rather than guess when a reference does not exist', () => {
        // A stale ref costs the re-lay, not a walk from the wrong place.
        const line: Coordinates = [[[-63.18, LAT - 0.0001]]];

        expect(run(line, selection(9), [lookup(street(4))]).moved).toEqual([]);
        expect(
            run(line, [{ segment: 4, index: 0 }], [lookup(street(4))]).moved,
        ).toEqual([]);
    });

    test('never crosses a segment boundary while re-laying', () => {
        // A route's segments are not a continuation of each other, and the
        // vertices in the next one are somebody else's route.
        const split: Coordinates = [
            [
                [-63.181, LAT - 0.0001],
                [-63.18, LAT - 0.0001],
            ],
            [
                [-63.179, LAT - 0.0001],
                [-63.178, LAT - 0.0001],
            ],
        ];

        const result = run(
            split,
            [
                { segment: 0, index: 0 },
                { segment: 0, index: 1 },
                { segment: 1, index: 0 },
                { segment: 1, index: 1 },
            ],
            [0, 1, 2, 3].map(() => lookup(street(4))),
        );

        // The two parts are still two parts, and each one's own vertices moved
        // within it. The reply was matched by position in the sorted selection,
        // which is what keeps a street from being applied across the boundary.
        expect(split.length).toBe(2);
        expect(result.coordinates.length).toBe(2);
        expect(result.moved).toHaveLength(4);
    });
});

describe('the walk stays inside the street it is given', () => {
    const LAT = -17.78;
    const street: Coordinates = [
        Array.from({ length: 6 }, (_, i) => [-63.18 + i * 0.001, LAT]),
    ];

    test('clamps a vertex that sits before the start of the way to the start', () => {
        // A regression, and one worth naming: the projection helper reports its
        // parameter unclamped on purpose, because an overshoot is how a click is
        // placed on the right side of a vertex. Used inside a window that
        // unclamped answer put the vertex 106 m *before* the beginning of the
        // street, which put the cursor behind the way and made the spacing rule
        // measure the wrong distance. The distance was never wrong, so every test
        // that only checked a refusal passed while this was broken.
        const line: Coordinates = [
            [
                [-63.182, LAT - 0.0001],
                [-63.181, LAT - 0.0001],
            ],
        ];

        const result = relaySelectionOntoNetwork(
            line,
            [
                { segment: 0, index: 0 },
                { segment: 0, index: 1 },
            ],
            [
                {
                    roadId: 1,
                    name: 'Calle Mercado',
                    votes: 2,
                    distance: 11,
                    line: street,
                },
                {
                    roadId: 1,
                    name: 'Calle Mercado',
                    votes: 2,
                    distance: 11,
                    line: street,
                },
            ],
            relayLimitsFor(25),
        );

        // Both are on the street, and the one that was west of its start is at
        // the start rather than past it.
        for (const position of result.coordinates[0]) {
            expect(position[1]).toBeCloseTo(LAT, 9);
        }

        expect(result.coordinates[0][0][0]).toBeCloseTo(-63.18, 9);
        // The second vertex is not at the start either: the spacing rule pushes it
        // ten metres along. What matters is the gap, which is the observable
        // symptom of the bug — ten metres because the rule worked, not a hundred
        // and six because the cursor had been left at a negative chainage.
        const gap =
            (result.coordinates[0][1][0] - result.coordinates[0][0][0]) *
            111320 *
            Math.cos((LAT * Math.PI) / 180);

        expect(gap).toBeGreaterThan(9);
        expect(gap).toBeLessThan(12);
    });

    test('never returns a position off the end of the way', () => {
        // The same clamp at the other end, and the case the arc cap depends on.
        const long: Coordinates = [
            Array.from({ length: 6 }, (_, i) => [-63.18 + i * 0.001, LAT]),
        ];
        const line: Coordinates = [
            [
                [-63.18, LAT - 0.0001],
                [-63.175, LAT - 0.0001],
            ],
        ];

        const result = relaySelectionOntoNetwork(
            line,
            [
                { segment: 0, index: 0 },
                { segment: 0, index: 1 },
            ],
            [
                {
                    roadId: 1,
                    name: 'Calle Mercado',
                    votes: 2,
                    distance: 11,
                    line: long,
                },
                {
                    roadId: 1,
                    name: 'Calle Mercado',
                    votes: 2,
                    distance: 11,
                    line: long,
                },
            ],
            relayLimitsFor(25),
        );

        // The street ends at -63.175, so nothing can be placed beyond it.
        for (const position of result.coordinates[0]) {
            expect(position[0]).toBeLessThanOrEqual(-63.175 + 1e-9);
        }
    });
});

describe('distanceMeters', () => {
    const LAT = -17.78;

    test('measures a degree of latitude as about 111 km', () => {
        expect(distanceMeters([0, LAT], [0, LAT + 0.01])).toBeCloseTo(1113, 0);
    });

    /**
     * The reason this helper exists at all. A degree of longitude in Santa Cruz
     * is about 5% shorter than a degree of latitude, and reading a raw `[lng,
     * lat]` pair as if it were already scaled overstates the distance by exactly
     * that much — a resample then places the wrong number of points.
     */
    test('a degree of longitude is shorter than a degree of latitude', () => {
        const alongLatitude = distanceMeters([0, LAT], [0, LAT + 0.01]);
        const alongLongitude = distanceMeters([-63.18, LAT], [-63.17, LAT]);

        expect(alongLongitude).toBeLessThan(alongLatitude);

        // Against the cosine itself rather than a rounded figure, so the test
        // states the actual contract and does not go stale when a rounding in
        // the fixture drifts.
        expect(alongLongitude).toBeCloseTo(
            alongLatitude * longitudeScale(LAT),
            6,
        );
    });

    test('is zero for the same point and symmetric otherwise', () => {
        expect(distanceMeters([1, 2], [1, 2])).toBe(0);
        expect(distanceMeters([1, 2], [4, 6])).toBeCloseTo(
            distanceMeters([4, 6], [1, 2]),
            9,
        );
    });

    test('scales by the latitude of the pair rather than of the equator', () => {
        const nearEquator = distanceMeters([0, 0], [0, 0.01]);
        const nearPole = distanceMeters([0, 60], [0, 60.01]);

        // Latitude degrees do not shrink, so these agree. It is the longitude
        // comparison that has to move with the cosine.
        expect(nearEquator).toBeCloseTo(nearPole, 0);
    });
});

describe('resampleSelection', () => {
    const LAT = -17.78;

    /**
     * Metres in one degree of longitude at this latitude, measured rather than
     * hard-coded so the fixtures below cannot drift out of agreement with
     * `distanceMeters`.
     */
    const DEG_LNG = distanceMeters([-63.18, LAT], [-63.18 + 1, LAT]);

    /** Degrees of longitude covering `metres` here. */
    const deg = (metres: number): number => metres / DEG_LNG;

    /**
     * Degrees of *latitude* covering `metres`.
     *
     * Separate from `deg` on purpose. Latitude degrees do not shrink with the
     * cosine of the latitude, so a fixture that reused the longitude figure to
     * build a north-south leg would be asking for 600 m and getting 630 — which
     * reads as a rounding artefact in the code under test and is really a
     * fixture measuring the wrong axis.
     */
    const degLat = (metres: number): number =>
        metres / distanceMeters([0, 0], [0, 1]);

    /** A straight east-bound route with `legs` legs of `step` metres. */
    const straight = (step: number, legs: number): Coordinates => [
        Array.from({ length: legs + 1 }, (_, i) => [
            -63.18 + i * deg(step),
            LAT,
        ]),
    ];

    const selection = (...indices: number[]): VertexRef[] =>
        indices.map((index) => ({ segment: 0, index }));

    /**
     * Every vertex of a route built with `legs` legs.
     *
     * Derived from the leg count rather than spelled out, because the two
     * off-by-one that invites — a vertex list of `legs` for a route of `legs + 1`
     * vertices, and an `Array(n)` that spreads to `undefined` rather than to
     * indices — both produce a selection that quietly selects nothing.
     */
    const every = (legs: number): VertexRef[] =>
        selection(...Array.from({ length: legs + 1 }, (_, i) => i));

    test('drops a vertex sitting inside the interval', () => {
        // Four 150 m legs: 600 m of route, so at a 200 m interval the three
        // interior vertices cannot all survive.
        const line = straight(150, 4);

        const result = resampleSelection(line, every(4), 200);

        expect(result.removed).toBe(3);
        expect(result.added).toBe(2);
        expect(result.coordinates[0].length).toBe(4);
    });

    test('adds the points a wide gap is missing', () => {
        // Two vertices 900 m apart: a 300 m interval needs two between them.
        const line: Coordinates = [
            [
                [-63.18, LAT],
                [-63.18 + deg(900), LAT],
            ],
        ];

        const result = resampleSelection(line, selection(0, 1), 300);

        expect(result.added).toBe(2);
        expect(result.coordinates[0].length).toBe(4);
    });

    test('holds both endpoints exactly where the reviewer put them', () => {
        const line: Coordinates = [
            [
                [-63.18, LAT],
                [-63.18 + deg(900), LAT],
            ],
        ];

        const result = resampleSelection(line, selection(0, 1), 200);

        expect(result.coordinates[0][0]).toEqual([-63.18, LAT]);
        expect(result.coordinates[0][result.coordinates[0].length - 1]).toEqual(
            [-63.18 + deg(900), LAT],
        );
    });

    /**
     * The whole reason the walk follows the route instead of joining the
     * endpoints. A chord across this selection would place the new points above
     * the corner, on ground the route never touches.
     */
    test('places new points on the route rather than across a corner', () => {
        const corner: Coordinates = [
            [
                [-63.18, LAT],
                [-63.18 + deg(600), LAT],
                [-63.18 + deg(600), LAT + degLat(600)],
            ],
        ];

        const result = resampleSelection(corner, selection(0, 2), 200);
        const placed = result.coordinates[0];

        for (const point of placed) {
            const onTheFirstLeg = Math.abs(point[1] - LAT) < 1e-9;
            const onTheSecondLeg =
                Math.abs(point[0] - (-63.18 + deg(600))) < 1e-9;

            expect(onTheFirstLeg || onTheSecondLeg).toBe(true);
        }

        // Two 600 m legs at a 200 m interval: six intervals, so seven points.
        expect(placed.length).toBe(7);
    });

    test('reports a tail too short to be a whole interval', () => {
        // 250 m into a 200 m interval: one interior point and a 50 m leg.
        const line: Coordinates = [
            [
                [-63.18, LAT],
                [-63.18 + deg(250), LAT],
            ],
        ];

        const result = resampleSelection(line, selection(0, 1), 200);

        expect(result.added).toBe(1);
        expect(result.raggedTail).toBe(true);
    });

    test('does not report a tail when the stretch divides exactly', () => {
        const line: Coordinates = [
            [
                [-63.18, LAT],
                [-63.18 + deg(400), LAT],
            ],
        ];

        const result = resampleSelection(line, selection(0, 1), 200);

        expect(result.added).toBe(1);
        expect(result.raggedTail).toBe(false);
    });

    /**
     * A stretch already at the interval is a state a reviewer reaches by
     * pressing the button twice, and the second press must not dirty the page
     * with a rewrite of coordinates that differ in the ninth decimal.
     */
    test('is a no-op by identity when the stretch already complies', () => {
        const line = straight(100, 6);
        const result = resampleSelection(line, every(6), 100);

        expect(result.coordinates).toBe(line);
        expect(result.added).toBe(0);
        expect(result.removed).toBe(0);
    });

    test('refuses a single vertex', () => {
        const line = straight(100, 4);
        const result = resampleSelection(line, selection(2), 200);

        expect(result.coordinates).toBe(line);
    });

    /**
     * A route's MultiLineString parts are not a continuation of each other, so
     * there is no leg to interpolate across the gap between them.
     */
    test('refuses a selection that straddles two segments', () => {
        const line: Coordinates = [
            [
                [-63.18, LAT],
                [-63.18 + deg(400), LAT],
            ],
            [
                [-63.18 + deg(400), LAT + 0.001],
                [-63.18 + deg(800), LAT + 0.001],
            ],
        ];

        const result = resampleSelection(
            line,
            [
                { segment: 0, index: 1 },
                { segment: 1, index: 0 },
            ],
            200,
        );

        expect(result.coordinates).toBe(line);
    });

    test('leaves the rest of the route alone', () => {
        // 50 m legs, so a 100 m stretch cannot hold a 200 m interval: the one
        // interior vertex goes and both endpoints stay.
        const line = straight(50, 10);
        const result = resampleSelection(line, selection(2, 3, 4), 200);

        expect(result.coordinates[0].length).toBe(10);
        expect(result.coordinates[0][0]).toEqual(line[0][0]);
        expect(result.coordinates[0][1]).toEqual(line[0][1]);
        expect(result.coordinates[0][2]).toEqual(line[0][2]);
        expect(result.coordinates[0][3]).toEqual(line[0][4]);
        expect(result.coordinates[0].slice(4)).toEqual(line[0].slice(5));
    });

    test('does not mutate the route it was given', () => {
        const line = straight(50, 8);
        const before = snapshot(line);

        resampleSelection(line, every(8), 200);

        expect(line).toEqual(before);
    });

    test('walks a selection given out of order', () => {
        const line = straight(50, 8);

        const ordered = resampleSelection(line, every(8), 200);
        const shuffled = resampleSelection(line, [...every(8)].reverse(), 200);

        expect(shuffled.coordinates).toEqual(ordered.coordinates);
    });

    test('ignores a repeated vertex rather than duplicating the endpoint', () => {
        const line: Coordinates = [
            [
                [-63.18, LAT],
                [-63.18 + deg(900), LAT],
            ],
        ];

        const result = resampleSelection(line, selection(0, 0, 1), 200);

        // 900 m at 200 m: four interior points plus the two endpoints.
        expect(result.coordinates[0].length).toBe(6);
        expect(result.coordinates[0][0]).toEqual([-63.18, LAT]);
    });

    test('keeps every fillable interval at the requested distance', () => {
        const line = straight(37, 12);
        const result = resampleSelection(line, every(12), 100);
        const placed = result.coordinates[0];

        // 444 m of route, so the tail after the last whole interval is short by
        // construction. Only the legs the walk could fill are held to the
        // interval; the tail is what `raggedTail` exists to report.
        for (let i = 1; i < placed.length - 1; i += 1) {
            const step = distanceMeters(
                [placed[i - 1][0], placed[i - 1][1]],
                [placed[i][0], placed[i][1]],
            );

            expect(step).toBeGreaterThanOrEqual(100 - 1e-6);
        }

        expect(result.raggedTail).toBe(true);
    });
});

describe('describeResample', () => {
    test('says so when nothing changed', () => {
        const line: Coordinates = [
            [
                [0, 0],
                [1, 0],
            ],
        ];
        const result = resampleSelection(line, [{ segment: 0, index: 0 }], 100);

        expect(describeResample(result, 100)).toContain('already spaced');
    });

    test('leads with the counts, which are what can be checked on the map', () => {
        const line: Coordinates = [
            [
                [-63.18, -17.78],
                [-63.17, -17.78],
            ],
        ];
        const result = resampleSelection(
            line,
            [
                { segment: 0, index: 0 },
                { segment: 0, index: 1 },
            ],
            100,
        );

        const message = describeResample(result, 100);

        expect(message).toContain('Re-spaced to 100 m');
        expect(message).toContain('added');
    });
});

describe('resampleBlock', () => {
    const selection = (...indices: number[]): VertexRef[] =>
        indices.map((index) => ({ segment: 0, index }));

    test('lets a single-segment selection through', () => {
        expect(resampleBlock(selection(0, 1))).toBeNull();
        expect(resampleBlock(selection(0, 1, 2, 3))).toBeNull();
    });

    test('blocks a selection too short to have a stretch', () => {
        expect(resampleBlock([])).toBe('too-few');
        expect(resampleBlock(selection(2))).toBe('too-few');
    });

    /**
     * A route's MultiLineString parts are not a continuation of each other, so
     * there is no leg to interpolate between them. And the reason it has to be
     * named separately is that it cannot be fixed by selecting more · which is
     * what a "select at least two vertices" message tells the reviewer to do.
     */
    test('blocks a selection crossing a segment boundary', () => {
        const across: VertexRef[] = [
            { segment: 0, index: 1 },
            { segment: 1, index: 0 },
        ];

        expect(resampleBlock(across)).toBe('spans-segments');
    });

    test('does not treat a sparse selection as a boundary crossing', () => {
        // Skipping vertices is not the same as crossing segments.
        expect(resampleBlock(selection(0, 9))).toBeNull();
    });
});

describe('describeResampleHint', () => {
    test('names the missing selection', () => {
        expect(describeResampleHint('too-few')).toContain('at least two');
    });

    test('names the boundary, and not the count to select more of', () => {
        const hint = describeResampleHint('spans-segments');

        expect(hint).toContain('segment boundary');
        expect(hint).not.toContain('at least two');
    });

    test('says what the action does when nothing blocks it', () => {
        const hint = describeResampleHint(null);

        expect(hint).toContain('even intervals');
        expect(hint).toContain('line itself does not move');
    });
});

describe('describeRelayHint', () => {
    test('names the missing selection', () => {
        expect(describeRelayHint('too-few')).toContain('at least two');
    });

    /**
     * The blocked case has to lead. A tooltip the reviewer only opens because the
     * button is greyed out has already failed if it opens by explaining what the
     * button would have done.
     */
    test('leads with the refusal rather than the action', () => {
        const blocked = describeRelayHint('too-few');
        const open = describeRelayHint(null);

        expect(blocked.length).toBeLessThan(open.length);
        expect(blocked).not.toContain('straight run');
    });

    test('explains the case the re-lay exists for', () => {
        expect(describeRelayHint(null)).toContain('straight run');
    });
});

describe('describeSnapPreset', () => {
    test('carries the distance the preset actually enforces', () => {
        // The whole reason it exists. "Normal" on its own does not say whether a
        // drop will snap, which is why fifty-eight words used to sit under this
        // control explaining it.
        expect(describeSnapPreset('normal')).toBe('Normal · 25 m');
        expect(describeSnapPreset('subtle')).toBe('Subtle · 12 m');
        expect(describeSnapPreset('aggressive')).toBe('Aggressive · 50 m');
    });

    test('keeps the vocabulary beside the number', () => {
        // Both, not one or the other: the names are what a reviewer learns once,
        // the distance is what they calibrate against.
        for (const preset of SNAP_PRESET_NAMES) {
            expect(describeSnapPreset(preset)).toContain(
                SNAP_PRESET_LABELS[preset],
            );
        }
    });

    test('prints no distance for off, because there is none', () => {
        // "Off" is deliberately not a row in the preset table, so there is no
        // threshold behind it. A label reading "Off · 0 m" would be a claim the
        // snap does not honour · it declines the lookup entirely.
        expect(describeSnapPreset('off')).toBe('Off');
        expect(describeSnapPreset('off')).not.toContain('m');
    });

    test('agrees with the table it is derived from', () => {
        for (const preset of ['subtle', 'normal', 'aggressive'] as const) {
            expect(describeSnapPreset(preset)).toContain(
                `${snapOptionsFor(preset)?.threshold} m`,
            );
        }
    });
});

describe('describeSnapTooltip', () => {
    test('says snapping is off rather than describing a threshold of zero', () => {
        expect(describeSnapTooltip('off')).toBe(
            'Drops land exactly where you release them, with no street lookup.',
        );
    });

    test('restates the threshold for reference', () => {
        expect(describeSnapTooltip('aggressive')).toContain('50 m');
    });

    /**
     * The crossing rule is the part that earns the tooltip. It is unobservable
     * everywhere except an intersection where two streets overlap, so printing
     * it under the control was occupying the screen to explain a case a reviewer
     * cannot act on until it happens to them.
     */
    test('carries the crossing rule', () => {
        expect(describeSnapTooltip('normal')).toContain('crossing');
    });

    test('does not repeat what the control already shows', () => {
        // The distance is on the label now. Repeating it here is the kind of
        // duplication that survives three rounds of tidying.
        expect(describeSnapTooltip('normal')).not.toContain('Normal');
    });
});

describe('describePropagationTooltip', () => {
    test('carries both of its limits', () => {
        const hint = describePropagationTooltip(25);

        expect(hint).toContain('4 vertices');
        expect(hint).toContain('250 m');
    });

    test('uses the threshold it is given, so it cannot disagree with the select', () => {
        // Both numbers come from one place on purpose: the checkbox and the
        // preset describe the same street with the same distance.
        expect(describePropagationTooltip(12)).toContain('12 m');
        expect(describePropagationTooltip(50)).toContain('50 m');
    });

    test('points at Alt, the way out of both behaviours at once', () => {
        expect(describePropagationTooltip(25)).toContain('Alt');
    });
});

describe('describeModeHelp', () => {
    test('covers every mode, none of them empty', () => {
        for (const mode of ['move', 'add', 'delete'] as const) {
            expect(describeModeHelp(mode).length).toBeGreaterThan(40);
        }
    });

    test('names the selection gesture that is shared by two modes', () => {
        expect(describeModeHelp('move')).toContain('Shift-click');
        expect(describeModeHelp('delete')).toContain('Shift-click');
    });

    test('tells a single add click what it will refuse', () => {
        // The add mode has no button and no tooltip, so this sentence is the only
        // place the ten-metre rule is written down.
        expect(describeModeHelp('add')).toContain('10 m');
    });

    test('points delete at the button rather than at a position', () => {
        expect(describeModeHelp('delete')).toContain('press Delete');
    });

    test('keeps Alt in move, where a drop is what skips the snap', () => {
        expect(describeModeHelp('move')).toContain('Alt');
    });
});

describe('describeSelectionState', () => {
    test('says nothing for an empty selection', () => {
        // The common case. Printing "0 vertices selected" under a map is noise,
        // and the help toggle is one click away.
        expect(describeSelectionState('move', 0)).toBe('');
        expect(describeSelectionState('delete', 0)).toBe('');
    });

    test('says nothing in add mode, which has nothing to select', () => {
        expect(describeSelectionState('add', 3)).toBe('');
    });

    test('reports a move selection as a count', () => {
        expect(describeSelectionState('move', 5)).toContain(
            '5 vertices selected',
        );
    });

    test('reports a delete selection with the same wording', () => {
        // The two modes used to disagree about what to append, which was the
        // tell that the appended text belonged to the mode help rather than to
        // the count. Nothing mode-specific is left to disagree about.
        expect(describeSelectionState('delete', 5)).toBe(
            describeSelectionState('move', 5),
        );
    });

    test('uses the singular for one vertex', () => {
        const state = describeSelectionState('delete', 1);

        expect(state).toContain('1 vertex selected');
        expect(state).not.toContain('vertices');
    });

    test('carries no instruction, because the mode help already does', () => {
        // This is the assertion that keeps the badge from wrapping. It is not
        // about wording: any clause long enough to need a sentence is a clause
        // that has to live in describeModeHelp instead.
        for (const state of [
            describeSelectionState('move', 2),
            describeSelectionState('move', 17),
            describeSelectionState('delete', 2),
            describeSelectionState('delete', 17),
        ]) {
            expect(state).not.toContain('—');
            expect(state.split(' ').length).toBeLessThanOrEqual(3);
        }
    });
});
