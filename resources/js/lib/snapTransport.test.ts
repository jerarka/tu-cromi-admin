import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SNAP_PRESETS } from '@/lib/routeEditing';
import type { LayStreet, Position } from '@/lib/routeEditing';
import type { SnapLookup } from '@/lib/snapWire';
import {
    SNAP_LOOKUP_TIMEOUT_MS,
    continueRoad,
    csrfToken,
    describeRelay,
    describeSnap,
    lookupRelayStreets,
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
        roadId: 1,
        name,
        votes,
        samples,
        line: null,
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

    test('counts the vertices it pulled along, which the reviewer cannot see', () => {
        // The whole point of saying it: nobody watched those vertices move, so a
        // silent count is a count nobody is told.
        expect(describeSnap(lookup(1, 7), 2)).toBe(
            'Avenida Siempre Viva — 2 following vertices pulled along',
        );
    });

    test('uses the singular for a single pulled vertex', () => {
        expect(describeSnap(lookup(1, 7), 1)).toBe(
            'Avenida Siempre Viva — 1 following vertex pulled along',
        );
    });

    test('says nothing about propagation when none happened', () => {
        // The default, and the case a snap with the feature off always takes. A
        // "0 vertices pulled along" here would be noise on most drops.
        expect(describeSnap(lookup(1, 7), 0)).toBe('Avenida Siempre Viva');
        expect(describeSnap(lookup(1, 7))).toBe('Avenida Siempre Viva');
    });

    test('reports the votes and the pull together', () => {
        // Both are true at once on a crossing with propagation on, and dropping
        // either would hide a decision the reviewer made.
        expect(describeSnap(lookup(5, 7), 3)).toBe(
            'Avenida Siempre Viva — 5 of 7 moved vertices are on it; 3 following vertices pulled along',
        );
    });

    test('reports the pull on an unnamed street too', () => {
        expect(describeSnap(lookup(1, 7, null), 2)).toBe(
            'unnamed street — 2 following vertices pulled along',
        );
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

    test('carries the deadline it is given, so a chain shares one budget', async () => {
        // A group move can look up the street and then ask what continues at the
        // corner. Two chained fetches with per-request timeouts leave the reviewer
        // watching a committed drop for twice the budget, and the second fetch has
        // not started when the first has used it up.
        const deadline = new AbortController().signal;

        await lookupSnapStreets(points, options, 'XSRF-TOKEN=t', deadline);

        expect(fetchMock.mock.calls[0][1].signal).toBe(deadline);
    });
});

describe('describeRelay', () => {
    const street = (
        name: string | null,
        placed: number,
        closestSpacing: number | null = null,
    ) => ({ roadId: 1, name, placed, closestSpacing });

    test('names every street and how many points went onto it', () => {
        // The only claim the tool actually makes, and the only one a reviewer can
        // check against the map: "18 points re-laid" says something happened,
        // "Calle Mercado x6, Av. Ca�oto x5" can be held against what they see.
        expect(
            describeRelay(
                [street('Calle Mercado', 6), street('Avenida Ca�oto', 5)],
                0,
            ),
        ).toBe(
            'Re-laid 11 points onto 2 streets: Calle Mercado x6, Avenida Ca�oto x5.',
        );
    });

    test('uses the singular for one street', () => {
        expect(describeRelay([street('Calle Mercado', 4)], 0)).toBe(
            'Re-laid 4 points onto 1 street: Calle Mercado x4.',
        );
    });

    test('counts a point per street, not per selection', () => {
        // A re-lay is the one action that can use several streets, so the total
        // has to be their sum. Reading it as the selection size would be a
        // number the reviewer could not reconcile with anything on screen.
        expect(
            describeRelay(
                [
                    street('Calle Mercado', 3),
                    street('Av. Ca�oto', 3),
                    street('Calle M. Montero', 2),
                ],
                0,
            ),
        ).toContain('Re-laid 8 points onto 3 streets');
    });

    test('says an unnamed street is unnamed rather than skipping it', () => {
        // Two thirds of the network has no name, and "unnamed street x3" is still
        // information about where three vertices went.
        expect(describeRelay([street(null, 3)], 0)).toBe(
            'Re-laid 3 points onto 1 street: unnamed street x3.',
        );
    });

    test('reports the points it could not place, and why', () => {
        // Silence here would read as "all of them moved", which is the one thing
        // a reviewer must not be left guessing about a change they did not drag.
        expect(describeRelay([street('Calle Mercado', 3)], 2)).toBe(
            'Re-laid 3 points onto 1 street: Calle Mercado x3, ' +
                '2 left where they are: no street within range.',
        );
    });

    test('uses the singular for a single unplaced point', () => {
        expect(describeRelay([street('Calle Mercado', 3)], 1)).toContain(
            '1 left where it is',
        );
    });

    test('mentions the spacing only when it had to be reduced', () => {
        // The target is ten metres. Saying so when it was achieved is noise, and
        // saying nothing when it was not would leave a claim about the geometry
        // the reviewer cannot check.
        expect(describeRelay([street('Calle Mercado', 4, 40)], 0)).toBe(
            'Re-laid 4 points onto 1 street: Calle Mercado x4.',
        );

        expect(describeRelay([street('Calle Mercado', 4, 10)], 0)).toBe(
            'Re-laid 4 points onto 1 street: Calle Mercado x4.',
        );

        expect(describeRelay([street('Calle Mercado', 4, 4)], 0)).toBe(
            'Re-laid 4 points onto 1 street: Calle Mercado x4 (closest 4 m apart).',
        );
    });

    test('says so when nothing at all could be placed', () => {
        // The outcome a reviewer most needs stated plainly, and the one a naive
        // composition gets wrong: it reads "Re-laid 0 points onto 0 streets",
        // which is both clumsy and a claim that work happened.
        expect(describeRelay([], 3)).toBe(
            'No selected point had a street within range. 3 left where they are.',
        );
        expect(describeRelay([], 1)).toBe(
            'No selected point had a street within range. 1 left where it is.',
        );
        expect(describeRelay([], 0)).toBe('Nothing was selected.');
    });
});

describe('lookupRelayStreets', () => {
    const options = { threshold: 25 };
    const points: Position[] = [
        [-63.18, -17.78],
        [-63.179, -17.78],
    ];

    const body = [
        {
            index: 0,
            road_id: 501,
            name: 'Calle Mercado',
            highway: 'residential',
            oneway: 'no',
            votes: 2,
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
        },
    ];

    const response = (status: number, payload: unknown = body): Response =>
        ({
            status,
            ok: status >= 200 && status < 300,
            json: async () => payload,
        }) as Response;

    let fetchMock: ReturnType<typeof vi.fn>;
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue(response(200));
        vi.stubGlobal('fetch', fetchMock);
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('sends the points as lat and lng objects, in order', () => {
        // The order is the contract on the way out as well as in: the reply is
        // matched back by position, so a shuffled request would have every street
        // applied to somebody else's vertex.
        return lookupRelayStreets(points, options, 'XSRF-TOKEN=tok').then(
            () => {
                const init = fetchMock.mock.calls[0][1] as RequestInit;
                const sent = JSON.parse(String(init.body));

                expect(sent.points).toEqual([
                    { lat: -17.78, lng: -63.18 },
                    { lat: -17.78, lng: -63.179 },
                ]);
                expect(sent.threshold).toBe(25);
            },
        );
    });

    test('attaches the CSRF token, without which the lookup is a silent 419', () => {
        return lookupRelayStreets(points, options, 'XSRF-TOKEN=tok123').then(
            () => {
                const init = fetchMock.mock.calls[0][1] as RequestInit;
                const headers = init.headers as Record<string, string>;

                expect(headers['X-XSRF-TOKEN']).toBe('tok123');
            },
        );
    });

    test('reads a list of streets back', () => {
        return lookupRelayStreets(points, options, '').then((found) => {
            expect(found).toHaveLength(1);
            expect(found[0].name).toBe('Calle Mercado');
            expect(found[0].line).not.toBeNull();
        });
    });

    test('returns nothing when the server reports no PostGIS', async () => {
        fetchMock.mockResolvedValue(response(404, null));

        // The client has to leave the selection alone here rather than treat it as
        // an answer, which is the whole contract of an empty result.
        expect(await lookupRelayStreets(points, options, '')).toEqual([]);
    });

    test('warns about a broken lookup, which looks like a gap in the map', () => {
        fetchMock.mockResolvedValue(response(419));

        return lookupRelayStreets(points, options, '').then((found) => {
            expect(found).toEqual([]);
            expect(warn).toHaveBeenCalledWith('Road lookup failed', 419);
        });
    });

    test('returns nothing when the request throws', async () => {
        fetchMock.mockRejectedValue(new Error('offline'));

        expect(await lookupRelayStreets(points, options, '')).toEqual([]);
    });

    test('asks about nothing without spending a request', async () => {
        expect(await lookupRelayStreets([], options, '')).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('continueRoad', () => {
    const street: LayStreet = {
        roadId: 42,
        name: 'Avenida Siempre Viva',
        line: [
            [
                [-63.18, -17.78],
                [-63.179, -17.78],
            ],
        ],
    };

    const from: Position = [-63.179, -17.78];

    const body = {
        road_id: 77,
        name: 'Calle Sin Nombre',
        highway: 'residential',
        oneway: 'no',
        distance_m: 0.8,
        lat: -17.78,
        lng: -63.179,
        geometry: {
            type: 'MultiLineString',
            coordinates: [
                [
                    [-63.179, -17.78],
                    [-63.178, -17.78],
                ],
            ],
        },
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
        over: Partial<{
            street: LayStreet;
            from: Position;
            bearing: number;
            cookie: string;
            signal: AbortSignal;
        }> = {},
    ) =>
        continueRoad(
            over.street ?? street,
            over.from ?? from,
            over.bearing ?? 90,
            over.cookie ?? 'XSRF-TOKEN=t',
            over.signal,
        );

    test('returns the street that continues, with its entry point', async () => {
        const found = await call();

        expect(found?.roadId).toBe(77);
        expect(found?.entry).toEqual([-63.179, -17.78]);
        expect(found?.line).toHaveLength(1);
    });

    test('sends the road it is leaving, the junction and the bearing', async () => {
        // The bearing is the whole question, and it is the client's to answer: the
        // server holds one row per way with no record of which way a route runs
        // along it, and the two senses of a line are separate rows.
        await call({ from: [-63.179, -17.78], bearing: 275 });

        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            road_id: 42,
            lat: -17.78,
            lng: -63.179,
            bearing: 275,
        });
    });

    test('sends the junction as lat and lng, not as an array', async () => {
        // The wire convention is the one the other two lookups use, and the
        // endpoint reads named fields — an array here validates as nothing and the
        // junction arrives as zero.
        await call();

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);

        expect(body.lat).toBeCloseTo(-17.78, 9);
        expect(body.lng).toBeCloseTo(-63.179, 9);
    });

    test('refuses to ask about a street with no identity', () => {
        // Without an id to exclude, the server answers with the street the walk is
        // already on and the walk goes in a circle — a correct-looking answer and a
        // crossing that never leaves the block. Cheaper to not ask.
        return call({ street: { ...street, roadId: null } }).then((found) => {
            expect(found).toBeNull();
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });

    test('treats 204 as nothing continuing, which is a normal answer', async () => {
        fetchMock.mockResolvedValue(response(204));

        expect(await call()).toBeNull();
    });

    test('warns about a broken lookup rather than swallowing it', async () => {
        // A 419 here means continuations are not working at all, and it would
        // otherwise be indistinguishable from a route that never turns a corner.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        fetchMock.mockResolvedValue(response(419));

        expect(await call()).toBeNull();
        expect(warn).toHaveBeenCalledWith(
            'Road continuation lookup failed',
            419,
        );
    });

    test('survives a body that is not a continuation', async () => {
        fetchMock.mockResolvedValue(response(200, { road_id: 77 }));

        expect(await call()).toBeNull();
    });

    test('survives the request failing outright', async () => {
        fetchMock.mockRejectedValue(new Error('offline'));

        expect(await call()).toBeNull();
    });

    test('carries the deadline it is given, so the chain shares one budget', async () => {
        const deadline = new AbortController().signal;

        await call({ signal: deadline });

        expect(fetchMock.mock.calls[0][1].signal).toBe(deadline);
    });

    test('carries a deadline of its own when it is given none', async () => {
        await call({ signal: undefined });

        expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    test('attaches the CSRF token, without which the lookup is a silent 419', async () => {
        await call({ cookie: 'XSRF-TOKEN=tok123' });

        expect(fetchMock.mock.calls[0][1].headers['X-XSRF-TOKEN']).toBe(
            'tok123',
        );
    });
});
