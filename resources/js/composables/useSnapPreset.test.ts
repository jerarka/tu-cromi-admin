import { describe, expect, test } from 'vitest';
import { SNAP_PRESET_NAMES, snapOptionsFor } from '@/lib/routeEditing';
import type { SnapPreset } from '@/lib/routeEditing';
import { isSnapPreset } from './useSnapPreset';

describe('isSnapPreset', () => {
    test('accepts every preset the picker offers', () => {
        // The picker and the picker are rendered from the same list, so this is
        // the assertion that a preset cannot be offered without being stored.
        for (const name of SNAP_PRESET_NAMES) {
            expect(isSnapPreset(name)).toBe(true);
        }
    });

    test('accepts every preset that resolves to settings', () => {
        for (const name of SNAP_PRESET_NAMES) {
            if (snapOptionsFor(name) !== null) {
                expect(isSnapPreset(name)).toBe(true);
            }
        }
    });

    test('rejects a preset that was removed in a later build', () => {
        // The scenario the guard exists for. A value like this sat in
        // localStorage from an older deploy, and accepting it would resolve to
        // no settings at all — which reads as "off" and silently stops
        // snapping with nothing on screen to say why.
        expect(isSnapPreset('reckless')).toBe(false);
    });

    test('rejects a value from a preset name that was merely renamed', () => {
        expect(isSnapPreset('Normal')).toBe(false);
        expect(isSnapPreset('NORMAL')).toBe(false);
    });

    test('rejects nothing stored', () => {
        expect(isSnapPreset(null)).toBe(false);
    });

    test('rejects an empty string', () => {
        // Treated as "no preference" by the caller, so it must not pass as one.
        expect(isSnapPreset('')).toBe(false);
    });

    test('rejects a value that only looks like a preset', () => {
        for (const value of [
            ' normal',
            'normal ',
            'off ',
            'Off',
            '0',
            'true',
        ]) {
            expect(isSnapPreset(value)).toBe(false);
        }
    });

    test('narrows the type, so a stored value can be used without a cast', () => {
        const stored: string | null = 'aggressive';

        if (isSnapPreset(stored)) {
            const preset: SnapPreset = stored;

            expect(preset).toBe('aggressive');
        } else {
            throw new Error('expected the guard to accept a real preset');
        }
    });
});
