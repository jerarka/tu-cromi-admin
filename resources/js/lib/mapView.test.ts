import { describe, expect, test } from 'vitest';
import { consumePreserveToken } from './mapView';

describe('consumePreserveToken', () => {
    test('the first render frames the route, because nothing to preserve yet', () => {
        // A fresh map has never looked at anything, so a token of 0 against a
        // seen 0 is "no request", not "a request that already happened".
        expect(consumePreserveToken(0, 0)).toEqual({
            seen: 0,
            preserve: false,
        });
    });

    test('a bumped token suppresses the render it arrives with', () => {
        expect(consumePreserveToken(0, 1)).toEqual({
            seen: 1,
            preserve: true,
        });
    });

    test('the same token does not suppress a second render', () => {
        // The one-shot property. A flag cannot express this, and getting it
        // wrong means the map never reframes again for the rest of the visit.
        const first = consumePreserveToken(0, 1);

        expect(consumePreserveToken(first.seen, 1)).toEqual({
            seen: 1,
            preserve: false,
        });
    });

    test('a later bump is honoured again after an intervening render', () => {
        let seen = consumePreserveToken(0, 1).seen;

        // Something else re-rendered, consuming nothing.
        seen = consumePreserveToken(seen, 1).seen;

        expect(consumePreserveToken(seen, 2)).toEqual({
            seen: 2,
            preserve: true,
        });
    });

    test('a token that goes backwards still counts as a change', () => {
        // Comparing for inequality rather than for "greater than": the parent
        // owns the counter and nothing here should assume it only advances.
        expect(consumePreserveToken(3, 1).preserve).toBe(true);
    });

    test('the seen value never changes when there is nothing to consume', () => {
        const result = consumePreserveToken(7, 7);

        expect(result.seen).toBe(7);
    });
});
