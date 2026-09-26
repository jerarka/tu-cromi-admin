import { onMounted, ref } from 'vue';
import { SNAP_PRESET_NAMES } from '@/lib/routeEditing';
import type { SnapPreset } from '@/lib/routeEditing';

/**
 * The editor preset, kept per browser rather than per user.
 *
 * Reading it from the server would be the wrong weight for this: it is a
 * preference about how a drag behaves while reviewing a couple of hundred
 * routes, it changes nothing anyone else can see, and it has no business in a
 * database column. localStorage is where the project's other client-side
 * preference already lives.
 */
const STORAGE_KEY = 'snap-preset';

const DEFAULT_PRESET: SnapPreset = 'normal';

const snapPreset = ref<SnapPreset>(DEFAULT_PRESET);

/**
 * Whether a stored value is still a preset this build knows about.
 *
 * Worth the check rather than a cast: localStorage survives deploys, so a key
 * written by an older build — or edited by hand — comes back as a string that
 * is not in the table. snapOptionsFor would then return undefined, which reads
 * as "off" and silently disables snapping with nothing on screen to explain
 * it. Dropping an unrecognised value leaves the reviewer on the default,
 * which is a visible, recoverable state.
 *
 * Exported for its test rather than exercised through the composable: the
 * composable needs a mounted component to run, and what matters here is that
 * the guard accepts exactly the strings the table defines.
 */
export function isSnapPreset(value: string | null): value is SnapPreset {
    return (
        value !== null &&
        (SNAP_PRESET_NAMES as readonly string[]).includes(value)
    );
}

export function useSnapPreset() {
    // Read after mount rather than during setup: this renders on the server
    // too, where localStorage does not exist.
    onMounted(() => {
        const stored = localStorage.getItem(STORAGE_KEY);

        if (isSnapPreset(stored)) {
            snapPreset.value = stored;
        }
    });

    function updateSnapPreset(value: SnapPreset): void {
        snapPreset.value = value;
        localStorage.setItem(STORAGE_KEY, value);
    }

    return {
        snapPreset,
        updateSnapPreset,
    };
}
