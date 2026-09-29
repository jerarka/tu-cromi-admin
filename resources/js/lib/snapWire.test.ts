import { describe, expect, test } from 'vitest';
import {
    relayLookupsFromResponse,
    snapLineFromGeometry,
    snapLookupFromResponse,
    toWirePoints,
} from './snapWire';

describe('toWirePoints', () => {
    test('sends lng and lat in the order the endpoint expects', () => {
        // Internally a position is [lng, lat]; the wire is { lat, lng }. A swap
        // here mirrors every sampled point about the antimeridian, and because
        // the sampled points only vote on which street to choose, the visible
        // result is a snap onto the wrong street rather than an error.
        expect(toWirePoints([[-63.18, -17.78]])).toEqual([
            { lat: -17.78, lng: -63.18 },
        ]);
    });

    test('keeps the order of the sample, which is the reference contract', () => {
        // The server treats the first point as the one the reviewer dropped and
        // holds it to the threshold, so a reordering here is not cosmetic.
        expect(
            toWirePoints([
                [-63.1, -17.8],
                [-63.2, -17.9],
            ]),
        ).toEqual([
            { lat: -17.8, lng: -63.1 },
            { lat: -17.9, lng: -63.2 },
        ]);
    });

    test('handles a sample of one', () => {
        expect(toWirePoints([[0, 0]])).toEqual([{ lat: 0, lng: 0 }]);
    });

    test('handles no points at all', () => {
        expect(toWirePoints([])).toEqual([]);
    });
});

describe('snapLookupFromResponse', () => {
    const response = {
        lat: -17.78,
        lng: -63.18,
        name: 'Avenida Siempre Viva',
        highway: 'residential',
        oneway: 'no',
        distance_m: 3.5,
        votes: 4,
        samples: 7,
    };

    test('reads the position back in the module order', () => {
        const lookup = snapLookupFromResponse(response);

        // The mirror of toWirePoints, and the one that actually moves vertices:
        // a transpose here would place every snapped vertex on the far side of
        // the world and Save would write it down.
        expect(lookup?.candidate.position).toEqual([-63.18, -17.78]);
        expect(lookup?.candidate.distance).toBe(3.5);
    });

    test('carries the name and the vote counts through', () => {
        expect(snapLookupFromResponse(response)).toEqual({
            candidate: { position: [-63.18, -17.78], distance: 3.5 },
            name: 'Avenida Siempre Viva',
            votes: 4,
            samples: 7,
            line: null,
        });
    });

    test('carries the street geometry through, in the module order', () => {
        // The order is the whole risk on this field. GeoJSON and this module
        // happen to agree on [lng, lat], and the snapped position beside it is
        // already in module order — so a transposed street would be a correct
        // snap sitting next to a mirrored continuation of the route, with
        // nothing anywhere disagreeing with it.
        const lookup = snapLookupFromResponse({
            ...response,
            geometry: {
                type: 'MultiLineString',
                coordinates: [
                    [
                        [-63.18, -17.78],
                        [-63.19, -17.79],
                    ],
                ],
            },
        });

        expect(lookup?.line).toEqual([
            [
                [-63.18, -17.78],
                [-63.19, -17.79],
            ],
        ]);
    });

    test('a response with no geometry is still a usable snap', () => {
        // The decision to snap has already been made by the time the geometry
        // would be read, so losing it costs a refinement and not an edit.
        const lookup = snapLookupFromResponse(response);

        expect(lookup?.candidate.position).toEqual([-63.18, -17.78]);
        expect(lookup?.line).toBeNull();
    });

    test('a malformed geometry costs the propagation and not the snap', () => {
        const lookup = snapLookupFromResponse({
            ...response,
            geometry: { type: 'Polygon', coordinates: [] },
        });

        expect(lookup?.candidate.position).toEqual([-63.18, -17.78]);
        expect(lookup?.line).toBeNull();
    });

    test('an unnamed street comes back as null rather than undefined', () => {
        const lookup = snapLookupFromResponse({ ...response, name: null });

        expect(lookup?.name).toBeNull();
    });

    test('rejects a response with no latitude', () => {
        // Returning null is the point: a candidate with a hole in it would reach
        // the offset arithmetic and produce NaN coordinates in the saved route.
        expect(
            snapLookupFromResponse({
                lng: -63.18,
                name: 'Avenida Siempre Viva',
                distance_m: 3.5,
            }),
        ).toBeNull();
    });

    test('rejects a response with no longitude', () => {
        expect(
            snapLookupFromResponse({ lat: -17.78, distance_m: 3.5 }),
        ).toBeNull();
    });

    test('rejects a response with no distance', () => {
        expect(snapLookupFromResponse({ lat: -17.78, lng: -63.18 })).toBeNull();
    });

    test('rejects a coordinate that is a string', () => {
        // The wire types are not enforced at runtime, so a server-side change
        // that quotes its numbers would otherwise pass silently into arithmetic.
        expect(
            snapLookupFromResponse({ ...response, lat: '-17.78' }),
        ).toBeNull();
    });

    test('rejects a coordinate that is NaN', () => {
        // A number, so a type check alone would wave it through, and NaN
        // propagates through every addition to the coordinates around it.
        expect(
            snapLookupFromResponse({ ...response, lng: Number.NaN }),
        ).toBeNull();
    });

    test('rejects a coordinate that is not finite', () => {
        expect(
            snapLookupFromResponse({
                ...response,
                lat: Number.POSITIVE_INFINITY,
            }),
        ).toBeNull();
    });

    test('rejects things that are not responses at all', () => {
        for (const junk of [null, undefined, 'a street', 42, [], true]) {
            expect(snapLookupFromResponse(junk)).toBeNull();
        }
    });

    test('a missing vote count is a missing confirmation, not a broken answer', () => {
        // The counts only feed the message, so a response without them is still
        // a usable snap; refusing it would drop a street the reviewer can see.
        const lookup = snapLookupFromResponse({
            lat: -17.78,
            lng: -63.18,
            name: 'Avenida Siempre Viva',
            distance_m: 3.5,
        });

        expect(lookup?.candidate.position).toEqual([-63.18, -17.78]);
        expect(lookup?.votes).toBe(0);
        expect(lookup?.samples).toBe(0);
    });
});

describe('snapLineFromGeometry', () => {
    const multi = (
        coordinates: unknown,
    ): { type: string; coordinates: unknown } => ({
        type: 'MultiLineString',
        coordinates,
    });

    test('reads a street as [lng, lat], which is what the module speaks', () => {
        // Stated as its own test rather than left implicit, because the two
        // orders meeting here is the one place a transposition would be silent.
        // Nothing downstream would notice: the snapped vertex is separately
        // correct, and a walk on a mirrored street produces plausible numbers.
        expect(
            snapLineFromGeometry(
                multi([
                    [
                        [-63.18, -17.78],
                        [-63.19, -17.79],
                    ],
                ]),
            ),
        ).toEqual([
            [
                [-63.18, -17.78],
                [-63.19, -17.79],
            ],
        ]);
    });

    test('keeps every part, so a split street is not silently joined', () => {
        // The walk stops at the end of a part rather than stepping over the gap.
        // If the parts were stitched together here, that gap would become a
        // straight line across whatever is in it.
        expect(
            snapLineFromGeometry(
                multi([
                    [
                        [0, 0],
                        [1, 0],
                    ],
                    [
                        [5, 5],
                        [6, 5],
                    ],
                ]),
            ),
        ).toEqual([
            [
                [0, 0],
                [1, 0],
            ],
            [
                [5, 5],
                [6, 5],
            ],
        ]);
    });

    test('drops a position that is not a finite number', () => {
        // NaN is a number, so a type check would wave it through, and it
        // propagates through every addition to the coordinates around it and
        // into the saved route without a word.
        expect(
            snapLineFromGeometry(
                multi([
                    [
                        [0, 0],
                        [Number.NaN, 1],
                        [2, 2],
                    ],
                ]),
            ),
        ).toEqual([
            [
                [0, 0],
                [2, 2],
            ],
        ]);
    });

    test('drops a position that is not a number at all', () => {
        expect(
            snapLineFromGeometry(
                multi([
                    [
                        [0, 0],
                        ['1', 1],
                        [2, 2],
                    ],
                ]),
            ),
        ).toEqual([
            [
                [0, 0],
                [2, 2],
            ],
        ]);
    });

    test('drops a part too short to have any length', () => {
        // One point is not a stretch of road. Keeping it would hand the walk a
        // zero-length segment to guard against rather than removing the case.
        expect(
            snapLineFromGeometry(
                multi([
                    [[0, 0]],
                    [
                        [1, 1],
                        [2, 2],
                    ],
                ]),
            ),
        ).toEqual([
            [
                [1, 1],
                [2, 2],
            ],
        ]);
    });

    test('returns null when nothing usable survives', () => {
        for (const value of [
            multi([[[0, 0]]]),
            multi([]),
            multi('nope'),
            {
                type: 'LineString',
                coordinates: [
                    [
                        [0, 0],
                        [1, 1],
                    ],
                ],
            },
            { type: 'MultiLineString' },
            {
                coordinates: [
                    [
                        [0, 0],
                        [1, 1],
                    ],
                ],
            },
            null,
            undefined,
            'a street',
            42,
            [],
        ]) {
            expect(snapLineFromGeometry(value)).toBeNull();
        }
    });
});

describe('relayLookupsFromResponse', () => {
    const row = (
        over: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
        index: 0,
        road_id: 501,
        name: 'Calle Mercado',
        highway: 'residential',
        oneway: 'no',
        votes: 4,
        distance_m: 3.5,
        geometry: {
            type: 'MultiLineString',
            coordinates: [
                [
                    [-63.18, -17.78],
                    [-63.179, -17.78],
                ],
            ],
        },
        ...over,
    });

    test('reads the geometry in the module order, as a drop does', () => {
        // The same silent-corruption risk as the drop's street, and worse here:
        // unlike a snap there is no correct position sitting beside it to notice
        // a mirrored one, so the order is the only thing standing between the
        // response and a route drawn on the far side of the world.
        const found = relayLookupsFromResponse([row()]);

        expect(found[0].line).toEqual([
            [
                [-63.18, -17.78],
                [-63.179, -17.78],
            ],
        ]);
    });

    test('keeps the order the points were sent in, and does not renumber them', () => {
        const found = relayLookupsFromResponse([
            row({ index: 0, name: 'Calle Mercado' }),
            row({ index: 1, name: 'Avenida Ca�oto' }),
        ]);

        expect(found.map((entry) => entry.name)).toEqual([
            'Calle Mercado',
            'Avenida Ca�oto',
        ]);
        // The reply is matched to the selection by position, so reordering it
        // would apply each street to somebody else's vertex.
        expect(found.map((entry) => entry.roadId)).toEqual([501, 501]);
    });

    test('carries the name, the votes and the distance through', () => {
        const found = relayLookupsFromResponse([
            row({ name: 'Av. Siempre Viva', votes: 6, distance_m: 12.25 }),
        ]);

        expect(found[0]).toMatchObject({
            roadId: 501,
            name: 'Av. Siempre Viva',
            votes: 6,
            distance: 12.25,
        });
    });

    test('accepts an unnamed street, because most of the network is unnamed', () => {
        // Nineteen thousand of the roads here have no name. Refusing to move a
        // route onto one would leave most of the city unusable, and the name is
        // only ever reported back � never used to decide anything.
        const found = relayLookupsFromResponse([row({ name: null })]);

        expect(found[0].name).toBeNull();
        expect(found[0].line).not.toBeNull();
    });

    test('drops a row with no index, since that is the only link to a vertex', () => {
        // Guessing would mean applying one street to a vertex nobody asked about,
        // which is the one mistake this lookup cannot make: it decides where a
        // stretch of route physically is.
        for (const missing of [undefined, null, 'zero', Number.NaN]) {
            const found = relayLookupsFromResponse([row({ index: missing })]);

            expect(found).toEqual([]);
        }
    });

    test('drops a row with no road or no distance', () => {
        // Without a road there is nothing to keep one cursor per, and without a
        // distance there is nothing to measure the move against.
        expect(relayLookupsFromResponse([row({ road_id: undefined })])).toEqual(
            [],
        );
        expect(relayLookupsFromResponse([row({ road_id: '501' })])).toEqual([]);
        expect(
            relayLookupsFromResponse([row({ distance_m: undefined })]),
        ).toEqual([]);
        expect(
            relayLookupsFromResponse([row({ distance_m: Number.NaN })]),
        ).toEqual([]);
    });

    test('keeps a row whose geometry is unusable, as a drop does', () => {
        // The distance has already been decided, so the street is still a street
        // and the caller can report it. What it cannot do with it is move a
        // vertex, which is why line is null rather than the row being refused.
        const found = relayLookupsFromResponse([
            row({ geometry: { type: 'Polygon', coordinates: [] } }),
        ]);

        expect(found).toHaveLength(1);
        expect(found[0].line).toBeNull();
    });

    test('skips the rows it cannot read and keeps the ones it can', () => {
        const found = relayLookupsFromResponse([
            null,
            'a street',
            row({ index: 0 }),
            row({ index: undefined }),
            row({ index: 1 }),
        ]);

        expect(found).toHaveLength(2);
    });

    test('returns nothing for a reply that is not a list', () => {
        for (const junk of [null, undefined, {}, 'streets', 42]) {
            expect(relayLookupsFromResponse(junk)).toEqual([]);
        }
    });

    test('returns nothing for the 404 a non-PostGIS database answers', () => {
        // What the client actually sees when the roads table does not exist, and
        // why an empty list rather than a null: it leaves the selection alone,
        // which is the right outcome for a lookup that cannot run.
        expect(relayLookupsFromResponse(null)).toEqual([]);
    });
});
