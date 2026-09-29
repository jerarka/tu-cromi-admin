import { describe, expect, test } from 'vitest';
import { isPropagationEnabled } from './usePropagation';

describe('isPropagationEnabled', () => {
    test('accepts only the exact string the toggle writes', () => {
        // updatePropagation stores String(enabled), so this is the whole
        // round trip: what goes in has to be what comes back.
        expect(isPropagationEnabled(String(true))).toBe(true);
        expect(isPropagationEnabled(String(false))).toBe(false);
    });

    test('does not treat the string "false" as true', () => {
        // The bug this guard exists to prevent. 'false' is a non-empty string and
        // therefore truthy, so a boolean cast anywhere near localStorage turns a
        // reviewer's deliberate "off" into a feature that rewrites vertices they
        // did not drag.
        expect(isPropagationEnabled('false')).toBe(false);
        expect(isPropagationEnabled('0')).toBe(false);
        expect(isPropagationEnabled('no')).toBe(false);
    });

    test('does not accept a real boolean, which is what a cast would hand it', () => {
        // The value arrives from localStorage and is always a string, so these
        // cannot occur — but accepting them would mean the guard was written
        // against the wrong type and would stop protecting anything the moment
        // the caller changed.
        expect(isPropagationEnabled(true as unknown as string)).toBe(false);
        expect(isPropagationEnabled(false as unknown as string)).toBe(false);
    });

    test('rejects nothing stored', () => {
        // The default. Being unable to distinguish "never set" from "set to
        // false" is deliberate: they are the same state, and it is the state
        // that does not edit anything.
        expect(isPropagationEnabled(null)).toBe(false);
    });

    test('rejects an empty string rather than reading it as a preference', () => {
        expect(isPropagationEnabled('')).toBe(false);
    });

    test('rejects a value that only looks right', () => {
        for (const value of [
            ' true',
            'true ',
            'True',
            'TRUE',
            'yes',
            'on',
            '1',
            'enabled',
        ]) {
            expect(isPropagationEnabled(value)).toBe(false);
        }
    });
});
