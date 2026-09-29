import { onMounted, ref } from 'vue';

/**
 * Whether a snap may pull the vertices around it onto the same street.
 *
 * Kept per browser and in localStorage for the same reasons as the snap preset
 * next to it: it is a preference about how an edit behaves while reviewing a
 * couple of hundred routes, it changes nothing anyone else can see, and it has
 * no business in a database column.
 *
 * A boolean rather than a third value on the snap preset, because the two
 * settings are about different things. The preset answers "how far off a street
 * may a drop be", which is a distance with a natural set of cuts. This answers
 * "may the tool move vertices the reviewer did not touch", which is a yes or no
 * about editing someone else's work — and folding it into the preset table would
 * mean every threshold quietly carried a second setting nobody can see, which is
 * exactly what the table was simplified to avoid.
 */
const STORAGE_KEY = 'snap-propagate';

/**
 * Off by default.
 *
 * Not a cautious default — a considered one. Every other snap decision is about
 * a vertex the reviewer put the cursor on. This one rewrites the ones they did
 * not, on a route that a scheduling app is going to read. A reviewer should have
 * to ask for that, and should be able to see it happen when they have.
 */
const DEFAULT_ENABLED = false;

const propagationEnabled = ref<boolean>(DEFAULT_ENABLED);

/**
 * Whether a stored value is a boolean this build can use.
 *
 * localStorage holds strings, and the failure this guards against is specific:
 * `'false'` is a non-empty string and therefore truthy, so a value written by
 * any code that did not stringify deliberately would come back as *on*. The
 * guard is exact rather than permissive for the same reason `isSnapPreset`
 * checks the table — an unrecognised value has to land on a known state, and the
 * known state here is off.
 */
export function isPropagationEnabled(value: string | null): boolean {
    return value === 'true';
}

export function usePropagation() {
    // Read after mount rather than during setup: this renders on the server
    // too, where localStorage does not exist.
    onMounted(() => {
        const stored = localStorage.getItem(STORAGE_KEY);

        if (stored !== null) {
            propagationEnabled.value = isPropagationEnabled(stored);
        }
    });

    function updatePropagation(enabled: boolean): void {
        propagationEnabled.value = enabled;
        localStorage.setItem(STORAGE_KEY, String(enabled));
    }

    return {
        propagationEnabled,
        updatePropagation,
    };
}
