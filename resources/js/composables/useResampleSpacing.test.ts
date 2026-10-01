import { describe, expect, test } from 'vitest';
import { RESAMPLE_SPACING_METERS } from '@/lib/routeEditing';
import type { ResampleSpacing } from '@/lib/routeEditing';
import { parseResampleSpacing } from './useResampleSpacing';

describe('parseResampleSpacing', () => {
    test('accepts every interval the picker offers', () => {
        // The picker renders from this same list, so this is the assertion that
        // an interval cannot be offered without being storable.
        for (const spacing of RESAMPLE_SPACING_METERS) {
            expect(parseResampleSpacing(String(spacing))).toBe(spacing);
        }
    });

    test('returns the number, not the string it was handed', () => {
        // The whole reason this is a lookup instead of a type guard. The narrowed
        // type of a `value is ResampleSpacing` predicate would have to be
        // assignable to `string`, and it cannot be — so a guard here would force
        // a cast at every use. The parsed value goes straight into a distance
        // comparison instead.
        const stored: string | null = '300';

        expect(typeof parseResampleSpacing(stored)).toBe('number');
    });

    test('rejects an interval that was removed in a later build', () => {
        // The scenario the guard exists for. A key like this survives a deploy in
        // localStorage, and accepting it would hand an uncalibrated number
        // straight to the spacing rule — the reviewer would get a re-space they
        // never chose, with nothing on screen to explain the distance.
        expect(parseResampleSpacing('50')).toBeNull();
        expect(parseResampleSpacing('500')).toBeNull();
    });

    test('rejects nothing stored', () => {
        expect(parseResampleSpacing(null)).toBeNull();
    });

    test('rejects an empty string', () => {
        // Treated as "no preference" by the caller, so it must not pass as one.
        expect(parseResampleSpacing('')).toBeNull();
    });

    test('rejects a value that only looks like an interval', () => {
        for (const value of [' 100', '100 ', '100.0', '1e2', '+100', '100m']) {
            expect(parseResampleSpacing(value)).toBeNull();
        }
    });

    test('resolves to a value the type accepts without a cast', () => {
        const parsed = parseResampleSpacing('200');

        if (parsed === null) {
            throw new Error('expected the lookup to accept a real interval');
        }

        const spacing: ResampleSpacing = parsed;

        expect(spacing).toBe(200);
    });
});
