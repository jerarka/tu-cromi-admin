import { describe, expect, test } from 'vitest';
import {
    applyDeltaToSelection,
    clampRange,
    decideSnap,
    findClosestSegment,
    insertVertexAt,
    projectOnSegment,
    rangeBetween,
    removeVertexAt,
    routeEndpoints,
    SNAP_PRESETS,
    SNAP_SAMPLE_LIMIT,
    snapSample,
    snapOptionsFor,
    snapSearchRadius,
    verticesWithinBounds,
} from './routeEditing';
import type { Coordinates, Position, VertexRef } from './routeEditing';

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

    test('removes the whole segment when it holds only two vertices', () => {
        const stub: Coordinates = [
            [
                [0, 0],
                [10, 0],
            ],
        ];

        expect(removeVertexAt(stub, 0, 0)).toEqual([]);
    });

    test('does not mutate the input', () => {
        const before = snapshot(square);

        removeVertexAt(square, 0, 1);

        expect(square).toEqual(before);
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
