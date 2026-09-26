import { router } from '@inertiajs/vue3';
import { computed, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import lines from '@/routes/lines';
import type { Line } from '@/types/line';

/** What the map editor is doing with a click. */
export type EditMode = 'move' | 'add' | 'delete';

export type RouteGeometry = NonNullable<Line['geo_json']>;

export interface UseRouteGeometryReturn {
    geoJsonText: Ref<string>;
    parsedGeoJson: ComputedRef<RouteGeometry | null>;
    geoJsonError: Ref<string | null>;
    isDirty: Ref<boolean>;
    isEditingMap: Ref<boolean>;
    mode: Ref<EditMode>;
    editToggleLabel: ComputedRef<string>;
    markDirty: () => void;
    markClean: () => void;
    validateGeoJson: () => void;
    setGeometry: (geoJson: RouteGeometry) => void;
    replaceGeometry: (geoJson: RouteGeometry | null) => void;
    toggleEditing: () => void;
    confirmDiscard: (href?: string) => void;
}

/**
 * The editing state of a route, shared by the create and edit pages.
 *
 * Both pages need the same thing and were each holding a copy: a textarea
 * bound to GeoJSON text, the parse of that text, its validation error, a dirty
 * flag, and the map editor's on/off switch and mode. The copies had already
 * drifted — the create page's toggle seeded a different mode, and the edit page
 * was the only one with a way to clear the dirty flag at all.
 *
 * The rule that a drag or a click follows is a judgement about the route, and
 * having it in one place is the point. Adding a fourth mode, or changing what
 * "open the editor" means, is now one edit rather than two templates and a pair
 * of computed properties that were free to disagree.
 *
 * Not in lib/, because it holds reactive state rather than being a pure
 * function. It is still testable without a DOM: refs and computeds are all it
 * touches, and the one browser call it makes is behind confirmDiscard.
 */
export function useRouteGeometry(): UseRouteGeometryReturn {
    const geoJsonText = ref('');
    const geoJsonError = ref<string | null>(null);
    const isDirty = ref(false);
    const isEditingMap = ref(false);
    const mode = ref<EditMode>('move');

    /**
     * The parsed route, or null when the text is empty or unparseable.
     *
     * Null rather than a throw, because this drives a map and a preview: a
     * half-finished edit is a normal state while the reviewer is typing, and the
     * page has to stay usable while it lasts.
     */
    const parsedGeoJson = computed<RouteGeometry | null>(() => {
        if (!geoJsonText.value) {
            return null;
        }

        try {
            return JSON.parse(geoJsonText.value) as RouteGeometry;
        } catch {
            return null;
        }
    });

    const markDirty = (): void => {
        isDirty.value = true;
    };

    /**
     * The counterpart to markDirty, and the reason it exists as a pair.
     *
     * The edit page resets the flag when the server hands it a different line.
     * It used to assign the ref directly, which is the kind of asymmetry that
     * grows: a second way to go clean, with no name to find it by.
     */
    const markClean = (): void => {
        isDirty.value = false;
    };

    const validateGeoJson = (): void => {
        if (!geoJsonText.value) {
            geoJsonError.value = null;

            return;
        }

        try {
            JSON.parse(geoJsonText.value);
            geoJsonError.value = null;
        } catch {
            geoJsonError.value = 'Invalid JSON format.';
        }
    };

    /**
     * Take geometry from the map. Always from a map, so always valid, which is
     * why the error is cleared rather than re-checked.
     */
    const setGeometry = (geoJson: RouteGeometry): void => {
        geoJsonText.value = JSON.stringify(geoJson, null, 2);
        geoJsonError.value = null;
        markDirty();
    };

    /**
     * Load geometry from the server, which may legitimately be nothing.
     *
     * Separate from setGeometry because it does not mark the page dirty: the
     * route was saved when the reviewer had not changed it, and an unsaved
     * changes prompt about a line nobody touched is a false alarm.
     */
    const replaceGeometry = (geoJson: RouteGeometry | null): void => {
        geoJsonText.value = geoJson ? JSON.stringify(geoJson, null, 2) : '';
        geoJsonError.value = null;
        markClean();
    };

    /**
     * Open or close the map editor, choosing the mode that matches the route.
     *
     * Closing always returns to move, so the next session starts on the mode
     * that adjusts rather than the one that was left. Opening on an empty route
     * starts on add instead, because there is nothing there to move.
     */
    const toggleEditing = (): void => {
        if (isEditingMap.value) {
            mode.value = 'move';
        } else if (!geoJsonText.value) {
            mode.value = 'add';
        }

        isEditingMap.value = !isEditingMap.value;
    };

    /**
     * What the button that opens the editor should say right now.
     *
     * Three states, because the two routes through this screen are different
     * tasks: an empty route is drawn and an existing one is adjusted, and
     * offering "Edit route on map" over nothing is a lie about what will happen.
     */
    const editToggleLabel = computed<string>(() => {
        if (isEditingMap.value) {
            return 'Finish editing';
        }

        return parsedGeoJson.value ? 'Edit route on map' : 'Draw route on map';
    });

    /**
     * Leave the page, asking first if there is anything unsaved.
     *
     * The href is an argument rather than a fixed destination because the edit
     * page leaves for four different places — the list, the previous line, the
     * next line, and the line itself on a failed save — and a fixed one would
     * mean a second function for the same guard.
     */
    const confirmDiscard = (href: string = lines.index.url()): void => {
        if (
            isDirty.value &&
            !window.confirm('You have unsaved changes. Leave without saving?')
        ) {
            return;
        }

        router.get(href);
    };

    return {
        geoJsonText,
        parsedGeoJson,
        geoJsonError,
        isDirty,
        isEditingMap,
        mode,
        editToggleLabel,
        markDirty,
        markClean,
        validateGeoJson,
        setGeometry,
        replaceGeometry,
        toggleEditing,
        confirmDiscard,
    };
}
