import { onMounted, ref } from 'vue';
import { RESAMPLE_SPACING_METERS } from '@/lib/routeEditing';
import type { ResampleSpacing } from '@/lib/routeEditing';

/**
 * The interval a re-spacing is asked for, kept per browser.
 *
 * Same reasoning as the snap preset and the propagation flag beside it: this is
 * a preference about how an edit behaves while a reviewer works through a
 * couple of hundred routes, it changes nothing anyone else can see, and it has
 * no business in a database column.
 */
const STORAGE_KEY = 'resample-spacing';

/**
 * The middle of the table.
 *
 * Neither the loosest nor the tightest: this rewrites the vertex list of a whole
 * stretch, and a reviewer meeting it for the first time is better served by the
 * interval that changes the shape of the result least while still visibly
 * evening the spacing out.
 */
const DEFAULT_SPACING: ResampleSpacing = 200;

const resampleSpacing = ref<ResampleSpacing>(DEFAULT_SPACING);

/**
 * The interval a stored key names, or null when it names none this build has.
 *
 * A lookup rather than the boolean guard its two siblings use, and the reason is
 * the storage medium: localStorage holds strings while the intervals are
 * numbers, so a `value is ResampleSpacing` predicate cannot narrow anything — its
 * narrowed type would have to be assignable to `string`. Parsing to the real
 * value and returning null for anything unrecognised says the same thing without
 * the cast, and lands the reviewer on a known interval either way.
 *
 * Worth having at all for the reason `isSnapPreset` is worth having: a key
 * written by an older build, or edited by hand, comes back as a string outside
 * the table, and handing that straight to a distance comparison is a limit
 * nobody chose.
 *
 * Exported for its test rather than exercised through the composable, which
 * needs a mounted component to run.
 */
export function parseResampleSpacing(
    value: string | null,
): ResampleSpacing | null {
    const found = RESAMPLE_SPACING_METERS.find(
        (spacing) => String(spacing) === value,
    );

    return found ?? null;
}

export function useResampleSpacing() {
    // Read after mount rather than during setup: this renders on the server
    // too, where localStorage does not exist.
    onMounted(() => {
        const stored = parseResampleSpacing(localStorage.getItem(STORAGE_KEY));

        if (stored !== null) {
            resampleSpacing.value = stored;
        }
    });

    function updateResampleSpacing(value: ResampleSpacing): void {
        resampleSpacing.value = value;
        localStorage.setItem(STORAGE_KEY, String(value));
    }

    return {
        resampleSpacing,
        updateResampleSpacing,
    };
}
