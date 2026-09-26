import { describe, expect, test } from 'vitest';
import { snapLookupFromResponse, toWirePoints } from './snapWire';

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
        });
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
