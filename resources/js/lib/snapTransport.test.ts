import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SNAP_PRESETS } from '@/lib/routeEditing';
import type { Position } from '@/lib/routeEditing';
import type { SnapLookup } from '@/lib/snapWire';
import {
    SNAP_LOOKUP_TIMEOUT_MS,
    csrfToken,
    describeSnap,
    lookupSnapStreets,
} from './snapTransport';

describe('csrfToken', () => {
    // A plain token, so this block is about finding the right cookie. The
    // decoding has its own case below.
    const cookie = 'appearance=light; XSRF-TOKEN=tok123; sidebar_state=open';

    test('reads the token out of a cookie header', () => {
        expect(csrfToken(cookie)).toBe('tok123');
    });

    test('decodes the value the way the server expects', () => {
        // Laravel stores the encrypted value, which arrives percent-encoded.
        // Handing back the raw slice produces a 419 that looks like "no street
        // nearby" from the outside.
        expect(csrfToken('XSRF-TOKEN=a%3Dbc%3D')).toBe('a=bc=');
    });

    test('returns empty rather than throwing when the cookie is absent', () => {
        // A missing cookie has to fail closed and quiet, or every drop would
        // start throwing instead of simply not snapping.
        expect(csrfToken('appearance=light; sidebar_state=open')).toBe('');
    });

    test('returns empty for an empty cookie header', () => {
        expect(csrfToken('')).toBe('');
    });

    test('does not match a cookie that merely ends with the prefix', () => {
        expect(csrfToken('NOT-XSRF-TOKEN=nope')).toBe('');
    });

    test('takes the first of two cookies with the same name', () => {
        expect(csrfToken('XSRF-TOKEN=first; XSRF-TOKEN=second')).toBe('first');
    });
});

describe('describeSnap', () => {
    const lookup = (
        votes: number,
        samples: number,
        name: string | null = 'Avenida Siempre Viva',
    ): SnapLookup => ({
        candidate: { position: [0, 0], distance: 1 },
        name,
        votes,
        samples,
    });

    test('names the street when the moved vertices are scattered', () => {
        // The common case along a route: one in seven, because each vertex is on
        // its own street. Printing that after a good snap makes a correct result
        // look doubtful.
        expect(describeSnap(lookup(1, 7))).toBe('Avenida Siempre Viva');
    });

    test('reports a clear majority, which is the crossing case', () => {
        expect(describeSnap(lookup(5, 7))).toBe(
            'Avenida Siempre Viva — 5 of 7 moved vertices are on it',
        );
    });

    test('reports a bare majority', () => {
        expect(describeSnap(lookup(2, 3))).toBe(
            'Avenida Siempre Viva — 2 of 3 moved vertices are on it',
        );
    });

    test('stays quiet on an exact tie', () => {
        expect(describeSnap(lookup(2, 4))).toBe('Avenida Siempre Viva');
    });

    test('stays quiet on a single sampled vertex', () => {
        expect(describeSnap(lookup(1, 1))).toBe('Avenida Siempre Viva');
    });

    test('stays quiet when nothing resolved at all', () => {
        expect(describeSnap(lookup(0, 0))).toBe('Avenida Siempre Viva');
    });

    test('falls back to a description when the street has no name', () => {
        expect(describeSnap(lookup(1, 7, null))).toBe('unnamed street');
    });
});

describe('lookupSnapStreets', () => {
    const options = SNAP_PRESETS.normal;
    const points: Position[] = [
        [-63.18, -17.78],
        [-63.19, -17.79],
    ];

    const body = {
        lat: -17.78,
        lng: -63.18,
        name: 'Avenida Siempre Viva',
        highway: 'residential',
        oneway: 'no',
        distance_m: 2.5,
        votes: 1,
        samples: 2,
    };

    const response = (status: number, payload: unknown = body): Response =>
        ({
            status,
            ok: status >= 200 && status < 300,
            json: async () => payload,
        }) as Response;

    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue(response(200));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const call = (
        over: Parameters<typeof lookupSnapStreets> = [
            points,
            options,
            'XSRF-TOKEN=t',
        ],
    ) => lookupSnapStreets(over[0], over[1], over[2]);

    test('returns the street the lookup chose', async () => {
        const found = await call();

        expect(found?.name).toBe('Avenida Siempre Viva');
        expect(found?.candidate.distance).toBe(2.5);
    });

    test('asks about nothing when there is nothing to ask about', async () => {
        // A stale vertex reference must not cost a round trip on every drop.
        const found = await call([[], options, 'XSRF-TOKEN=t']);

        expect(found).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('treats 204 as nothing close enough, not a failure', async () => {
        fetchMock.mockResolvedValue(response(204, null));

        expect(await call()).toBeNull();
    });

    test('warns when the lookup is broken rather than swallowing it', async () => {
        // A 419 is a dead lookup. Reported as "no street nearby" it is
        // indistinguishable from a genuine gap in the map, which is exactly how
        // a broken snap looks like a working one.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        fetchMock.mockResolvedValue(response(419));

        expect(await call()).toBeNull();
        expect(warn).toHaveBeenCalledWith('Road lookup failed', 419);
    });

    test('warns on a server error too', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        fetchMock.mockResolvedValue(response(500));

        expect(await call()).toBeNull();
        expect(warn).toHaveBeenCalledWith('Road lookup failed', 500);
    });

    test('refuses a body that is not a street', async () => {
        // The drop is already committed, so the only safe answer to a malformed
        // response is to leave the route where the reviewer put it.
        fetchMock.mockResolvedValue(response(200, { name: 'nowhere' }));

        expect(await call()).toBeNull();
    });

    test('survives the request failing outright', async () => {
        fetchMock.mockRejectedValue(new Error('network down'));

        expect(await call()).toBeNull();
    });

    test('survives a lookup that times out', async () => {
        // The deadline exists so a request that never settles cannot leave the
        // editor unusable; the abort arrives here as a rejected fetch.
        fetchMock.mockRejectedValue(
            new DOMException('The operation was aborted', 'TimeoutError'),
        );

        expect(await call()).toBeNull();
    });

    test('sends the sample in wire order, reference first', async () => {
        await call();

        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);

        expect(sent.points).toEqual([
            { lat: -17.78, lng: -63.18 },
            { lat: -17.79, lng: -63.19 },
        ]);
    });

    test('sends the threshold it will apply to the answer', async () => {
        // The same number, so the server never proposes a street this component
        // would then refuse.
        await call();

        expect(JSON.parse(fetchMock.mock.calls[0][1].body).threshold).toBe(
            options.threshold,
        );
    });

    test('widens the search radius with the threshold', async () => {
        await call([
            [[-63.18, -17.78]],
            SNAP_PRESETS.aggressive,
            'XSRF-TOKEN=t',
        ]);

        expect(
            JSON.parse(fetchMock.mock.calls[0][1].body).radius,
        ).toBeGreaterThan(options.threshold);
    });

    test('sends the CSRF token from the cookie it was given', async () => {
        // The one place in the app that bypasses Inertia, and therefore the one
        // place that has to carry the token itself.
        await call([points, options, 'appearance=light; XSRF-TOKEN=tok%3D']);

        expect(fetchMock.mock.calls[0][1].headers['X-XSRF-TOKEN']).toBe('tok=');
    });

    test('posts same-origin so the session cookie travels', async () => {
        await call();

        expect(fetchMock.mock.calls[0][1].credentials).toBe('same-origin');
    });

    test('carries a deadline', async () => {
        await call();

        const signal = fetchMock.mock.calls[0][1].signal;

        expect(signal).toBeInstanceOf(AbortSignal);
        expect(SNAP_LOOKUP_TIMEOUT_MS).toBeGreaterThan(0);
    });
});
