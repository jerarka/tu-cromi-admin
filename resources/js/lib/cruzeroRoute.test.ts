import { describe, expect, it } from 'vitest';
import {
    describeConversion,
    parseCruzeroRoute,
    senseFromTripId,
} from './cruzeroRoute';

const idaShape = [
    [-63.19626, -17.76301],
    [-63.19621, -17.76307],
    [-63.19438, -17.76194],
];

const vueltaShape = [
    [-63.19438, -17.76194],
    [-63.19621, -17.76307],
    [-63.19626, -17.76301],
];

/** One entry of `Lines[]`, shaped as the API sends it. */
function trip(tripId: string, coordinates: number[][]): unknown {
    return {
        id: tripId,
        trip_id: tripId,
        Shape: {
            id: `42-${tripId}`,
            shape_geom: {
                crs: { type: 'name', properties: { name: 'EPSG:4326' } },
                type: 'LineString',
                coordinates,
            },
        },
    };
}

function envelope(): unknown {
    return {
        status: 200,
        data: [
            {
                id: '42',
                transport_name: 'Linea 38',
                route_id: '38',
                Lines: [
                    trip('38 CLOCKWISE_i_T01', idaShape),
                    trip('38 COUNTERCLOCKWISE_v_T01', vueltaShape),
                ],
            },
        ],
    };
}

function expectOk(result: ReturnType<typeof parseCruzeroRoute>) {
    if (!result.ok) {
        throw new Error(`expected a conversion, got: ${result.reason}`);
    }

    return result;
}

function expectFail(result: ReturnType<typeof parseCruzeroRoute>): string {
    if (result.ok) {
        throw new Error('expected a refusal, got a conversion');
    }

    return result.reason;
}

describe('senseFromTripId', () => {
    it('reads the direction marker out of a trip id', () => {
        expect(senseFromTripId('38 CLOCKWISE_i_T01')).toBe('OUTBOUND');
        expect(senseFromTripId('38 COUNTERCLOCKWISE_v_T01')).toBe('RETURN');
    });

    it('reports nothing rather than guessing', () => {
        // A trip id with no marker is a different situation from one that says
        // the wrong thing, and the report has to keep them apart.
        expect(senseFromTripId('38 CLOCKWISE_T01')).toBeNull();
    });

    it('is not fooled by letters inside other tokens', () => {
        expect(senseFromTripId('38 route_via_T01')).toBeNull();
    });
});

describe('parseCruzeroRoute', () => {
    it('picks the ida for an outbound row out of the whole envelope', () => {
        const { geoJson, report } = expectOk(
            parseCruzeroRoute(JSON.stringify(envelope()), 'OUTBOUND'),
        );

        expect(report.tripId).toBe('38 CLOCKWISE_i_T01');
        expect(report.shapeSense).toBe('OUTBOUND');
        expect(geoJson.coordinates[0][0]).toEqual(idaShape[0]);
        expect(geoJson.coordinates[0][2]).toEqual(idaShape[2]);
    });

    it('picks the vuelta for a return row', () => {
        // The same paste answers differently per row, which is the point: the
        // reviewer should never have to say which direction they want.
        const { report } = expectOk(
            parseCruzeroRoute(JSON.stringify(envelope()), 'RETURN'),
        );

        expect(report.tripId).toBe('38 COUNTERCLOCKWISE_v_T01');
    });

    it('wraps the line string as a one-part MultiLineString', () => {
        const { geoJson } = expectOk(
            parseCruzeroRoute(JSON.stringify(envelope()), 'OUTBOUND'),
        );

        // Never "LineString": that is the one shape a lines row may not hold.
        expect(geoJson.type).toBe('MultiLineString');
        expect(geoJson.coordinates).toHaveLength(1);
    });

    it('accepts a bare line string as the paste', () => {
        const { geoJson, report } = expectOk(
            parseCruzeroRoute(
                JSON.stringify({ type: 'LineString', coordinates: idaShape }),
                'OUTBOUND',
            ),
        );

        expect(report.tripId).toBeNull();
        expect(report.shapeSense).toBeNull();
        expect(geoJson.coordinates[0]).toHaveLength(3);
    });

    it('accepts a bare shape_geom as the paste', () => {
        const { geoJson } = expectOk(
            parseCruzeroRoute(
                JSON.stringify({
                    shape_geom: { type: 'LineString', coordinates: idaShape },
                }),
                'OUTBOUND',
            ),
        );

        expect(geoJson.coordinates[0]).toHaveLength(3);
    });

    it('accepts a bare coordinates array as the paste', () => {
        const { geoJson } = expectOk(
            parseCruzeroRoute(JSON.stringify(idaShape), 'OUTBOUND'),
        );

        expect(geoJson.coordinates[0]).toHaveLength(3);
    });

    it('takes a lone shape whatever direction it claims, and reports what it claimed', () => {
        // Refusing this would leave a reviewer holding a paste that visibly has a
        // route and a tool that will not read it. The report is where the
        // judgement becomes visible instead.
        const { report } = expectOk(
            parseCruzeroRoute(
                JSON.stringify({
                    data: [
                        {
                            Lines: [
                                trip('38 COUNTERCLOCKWISE_v_T01', vueltaShape),
                            ],
                        },
                    ],
                }),
                'OUTBOUND',
            ),
        );

        expect(report.tripId).toBe('38 COUNTERCLOCKWISE_v_T01');
        expect(report.shapeSense).toBe('RETURN');
    });

    it('drops consecutive duplicate points and says how many', () => {
        // The payload really does contain them: one in the ida, two in the vuelta.
        const withDuplicate = [
            idaShape[0],
            idaShape[0],
            idaShape[1],
            idaShape[2],
        ];

        const { geoJson, report } = expectOk(
            parseCruzeroRoute(
                JSON.stringify({
                    type: 'LineString',
                    coordinates: withDuplicate,
                }),
                'OUTBOUND',
            ),
        );

        expect(geoJson.coordinates[0]).toHaveLength(3);
        expect(report.vertices).toBe(3);
        expect(report.droppedDuplicates).toBe(1);
    });

    it('keeps two distinct points that sit at the same longitude', () => {
        // Only an exact repeat is a duplicate; a vertical step is geometry.
        const vertical = [
            [-63.19, -17.76],
            [-63.19, -17.77],
        ];

        const { report } = expectOk(
            parseCruzeroRoute(
                JSON.stringify({ type: 'LineString', coordinates: vertical }),
                'OUTBOUND',
            ),
        );

        expect(report.droppedDuplicates).toBe(0);
        expect(report.vertices).toBe(2);
    });

    it('reports the extent of what it read', () => {
        const { report } = expectOk(
            parseCruzeroRoute(JSON.stringify(envelope()), 'OUTBOUND'),
        );

        expect(report.bbox).toEqual({
            minLng: -63.19626,
            maxLng: -63.19438,
            minLat: -17.76307,
            maxLat: -17.76194,
        });
    });

    it('reports a length the map badge will agree with', () => {
        const { report } = expectOk(
            parseCruzeroRoute(JSON.stringify(envelope()), 'OUTBOUND'),
        );

        expect(report.lengthMeters).toBeGreaterThan(0);
        expect(report.vertices).toBe(3);
    });

    it('refuses several shapes of the requested direction, naming them', () => {
        const reason = expectFail(
            parseCruzeroRoute(
                JSON.stringify({
                    data: [
                        {
                            Lines: [
                                trip('38 CLOCKWISE_i_T01', idaShape),
                                trip('38 CLOCKWISE_i_T02', idaShape),
                            ],
                        },
                    ],
                }),
                'OUTBOUND',
            ),
        );

        expect(reason).toContain('2 ida shapes');
        expect(reason).toContain('38 CLOCKWISE_i_T01');
        expect(reason).toContain('38 CLOCKWISE_i_T02');
    });

    it('refuses when no shape claims the requested direction, naming what it found', () => {
        // The ambiguity has to be built explicitly: a whole envelope holds both
        // directions, so asking for the vuelta there succeeds rather than fails.
        const reason = expectFail(
            parseCruzeroRoute(
                JSON.stringify({
                    data: [
                        {
                            Lines: [
                                trip('38 CLOCKWISE_i_T01', idaShape),
                                trip('39 CLOCKWISE_i_T01', idaShape),
                            ],
                        },
                    ],
                }),
                'RETURN',
            ),
        );

        expect(reason).toContain('none of them is the vuelta');
        expect(reason).toContain('38 CLOCKWISE_i_T01');
        expect(reason).toContain('39 CLOCKWISE_i_T01');
    });

    it('refuses stop points by name rather than rejecting them generically', () => {
        // The stops ride in the same response with the same coordinates, written
        // as separate scalars in the opposite order. A generic rejection here
        // would be read as "bad JSON" and the reviewer would try again with the
        // same wrong slice.
        const reason = expectFail(
            parseCruzeroRoute(
                JSON.stringify([
                    { id: '2:STOP5938', lat: -17.763008, lon: -63.196255 },
                    { id: '2:STOP5939', lat: -17.763061, lon: -63.196203 },
                ]),
                'OUTBOUND',
            ),
        );

        expect(reason).toContain('stop points');
    });

    it('refuses a route with fewer than two positions', () => {
        expect(
            expectFail(
                parseCruzeroRoute(
                    JSON.stringify({
                        type: 'LineString',
                        coordinates: [[-63.19, -17.76]],
                    }),
                    'OUTBOUND',
                ),
            ),
        ).toContain('at least two points');

        expect(
            expectFail(
                parseCruzeroRoute(
                    JSON.stringify({ type: 'LineString', coordinates: [] }),
                    'OUTBOUND',
                ),
            ),
        ).toContain('none');
    });

    it('names the offending position when one is not a pair', () => {
        const reason = expectFail(
            parseCruzeroRoute(
                JSON.stringify({
                    type: 'LineString',
                    coordinates: [
                        [-63.19, -17.76],
                        ['-63.18', '-17.75'],
                    ],
                }),
                'OUTBOUND',
            ),
        );

        expect(reason).toContain('Point 2');
    });

    it('refuses text that is not JSON', () => {
        expect(expectFail(parseCruzeroRoute('not json', 'OUTBOUND'))).toContain(
            'not valid JSON',
        );
    });

    it('refuses an empty paste', () => {
        expect(expectFail(parseCruzeroRoute('   ', 'OUTBOUND'))).toContain(
            'Paste a response first',
        );
    });

    it('refuses JSON that holds no route', () => {
        expect(
            expectFail(
                parseCruzeroRoute(
                    JSON.stringify({ status: 200, data: [] }),
                    'OUTBOUND',
                ),
            ),
        ).toContain('No route found');
    });
});

describe('describeConversion', () => {
    it('names the trip it read, so the direction is visible', () => {
        const { report } = expectOk(
            parseCruzeroRoute(JSON.stringify(envelope()), 'OUTBOUND'),
        );

        const sentence = describeConversion(report);

        expect(sentence).toContain('38 CLOCKWISE_i_T01');
        expect(sentence).toContain('3 vertices');
    });

    it('says when the shape carried no direction marker', () => {
        const { report } = expectOk(
            parseCruzeroRoute(
                JSON.stringify({ type: 'LineString', coordinates: idaShape }),
                'OUTBOUND',
            ),
        );

        expect(describeConversion(report)).toContain('taken on faith');
    });

    it('mentions dropped duplicates only when there were some', () => {
        const clean = expectOk(
            parseCruzeroRoute(
                JSON.stringify({ type: 'LineString', coordinates: idaShape }),
                'OUTBOUND',
            ),
        );
        const duplicated = expectOk(
            parseCruzeroRoute(
                JSON.stringify({
                    type: 'LineString',
                    coordinates: [
                        idaShape[0],
                        idaShape[0],
                        idaShape[1],
                        idaShape[2],
                    ],
                }),
                'OUTBOUND',
            ),
        );

        expect(describeConversion(clean.report)).not.toContain('dropped');
        expect(describeConversion(duplicated.report)).toContain(
            '1 duplicate point dropped',
        );
    });
});
