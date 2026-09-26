import { router } from '@inertiajs/vue3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useRouteGeometry } from './useRouteGeometry';
import type { RouteGeometry } from './useRouteGeometry';

vi.mock('@inertiajs/vue3', () => ({
    router: { get: vi.fn() },
}));

const route: RouteGeometry = {
    type: 'MultiLineString',
    coordinates: [
        [
            [0, 0],
            [1, 1],
        ],
    ],
};

describe('useRouteGeometry', () => {
    let confirm: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        confirm = vi.fn().mockReturnValue(true);
        vi.stubGlobal('window', { confirm });
        vi.mocked(router.get).mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe('parsedGeoJson', () => {
        test('is null on an empty form', () => {
            const { parsedGeoJson } = useRouteGeometry();

            expect(parsedGeoJson.value).toBeNull();
        });

        test('is null on a half-finished edit rather than throwing', () => {
            // Typing into the textarea passes through every state between valid
            // and not, and the map and the preview have to survive all of them.
            const { geoJsonText, parsedGeoJson } = useRouteGeometry();

            geoJsonText.value = '{"type":"MultiLine';

            expect(parsedGeoJson.value).toBeNull();
        });

        test('parses once the text is whole', () => {
            const { geoJsonText, parsedGeoJson } = useRouteGeometry();

            geoJsonText.value = JSON.stringify(route);

            expect(parsedGeoJson.value).toEqual(route);
        });
    });

    describe('validateGeoJson', () => {
        test('says nothing about an empty form', () => {
            const { geoJsonError, validateGeoJson } = useRouteGeometry();

            validateGeoJson();

            expect(geoJsonError.value).toBeNull();
        });

        test('reports invalid JSON', () => {
            const { geoJsonText, geoJsonError, validateGeoJson } =
                useRouteGeometry();

            geoJsonText.value = 'not json';
            validateGeoJson();

            expect(geoJsonError.value).toBe('Invalid JSON format.');
        });

        test('clears the error once the text is fixed', () => {
            // The reviewer is mid-edit and the error has to stop being shouted
            // at them the moment they fix it, not on the next save.
            const { geoJsonText, geoJsonError, validateGeoJson } =
                useRouteGeometry();

            geoJsonText.value = 'not json';
            validateGeoJson();
            geoJsonText.value = JSON.stringify(route);
            validateGeoJson();

            expect(geoJsonError.value).toBeNull();
        });
    });

    describe('setGeometry', () => {
        test('writes the geometry back as formatted text', () => {
            const { geoJsonText, setGeometry } = useRouteGeometry();

            setGeometry(route);

            expect(geoJsonText.value).toBe(JSON.stringify(route, null, 2));
        });

        test('marks the page dirty', () => {
            const { isDirty, setGeometry } = useRouteGeometry();

            setGeometry(route);

            expect(isDirty.value).toBe(true);
        });

        test('clears a stale error without rechecking', () => {
            // Geometry from the map is always valid, so validating it would be
            // theatre.
            const { geoJsonText, geoJsonError, validateGeoJson, setGeometry } =
                useRouteGeometry();

            geoJsonText.value = 'not json';
            validateGeoJson();
            setGeometry(route);

            expect(geoJsonError.value).toBeNull();
        });
    });

    describe('replaceGeometry', () => {
        test('does not mark the page dirty', () => {
            // A line loaded from the server was saved when the reviewer had not
            // touched it. An unsaved-changes prompt about it is a false alarm,
            // and it is the one this pair of functions exists to prevent.
            const { isDirty, replaceGeometry } = useRouteGeometry();

            replaceGeometry(route);

            expect(isDirty.value).toBe(false);
        });

        test('takes null as a route with no geometry', () => {
            const { geoJsonText, parsedGeoJson, replaceGeometry } =
                useRouteGeometry();

            replaceGeometry(route);
            replaceGeometry(null);

            expect(geoJsonText.value).toBe('');
            expect(parsedGeoJson.value).toBeNull();
        });

        test('clears a stale error and the dirty flag together', () => {
            const {
                geoJsonText,
                geoJsonError,
                isDirty,
                validateGeoJson,
                replaceGeometry,
            } = useRouteGeometry();

            geoJsonText.value = 'not json';
            validateGeoJson();
            isDirty.value = true;
            replaceGeometry(route);

            expect(geoJsonError.value).toBeNull();
            expect(isDirty.value).toBe(false);
        });
    });

    describe('toggleEditing', () => {
        test('opens on add when there is no route to move', () => {
            const { isEditingMap, mode, toggleEditing } = useRouteGeometry();

            toggleEditing();

            expect(isEditingMap.value).toBe(true);
            expect(mode.value).toBe('add');
        });

        test('opens on move when there is a route', () => {
            const { isEditingMap, mode, replaceGeometry, toggleEditing } =
                useRouteGeometry();

            replaceGeometry(route);
            toggleEditing();

            expect(isEditingMap.value).toBe(true);
            expect(mode.value).toBe('move');
        });

        test('closing returns to move whatever mode was active', () => {
            // So the next session starts on the mode that adjusts rather than
            // the one that was left behind.
            const { mode, toggleEditing } = useRouteGeometry();

            toggleEditing();
            expect(mode.value).toBe('add');

            toggleEditing();

            expect(mode.value).toBe('move');
        });
    });

    describe('editToggleLabel', () => {
        test('offers to draw when there is nothing yet', () => {
            // "Edit route on map" over an empty form is a lie about what will
            // happen.
            expect(useRouteGeometry().editToggleLabel.value).toBe(
                'Draw route on map',
            );
        });

        test('offers to edit once there is a route', () => {
            const { editToggleLabel, replaceGeometry } = useRouteGeometry();

            replaceGeometry(route);

            expect(editToggleLabel.value).toBe('Edit route on map');
        });

        test('offers to finish while open', () => {
            const { editToggleLabel, replaceGeometry, toggleEditing } =
                useRouteGeometry();

            replaceGeometry(route);
            toggleEditing();

            expect(editToggleLabel.value).toBe('Finish editing');
        });
    });

    describe('confirmDiscard', () => {
        test('leaves without asking when nothing changed', () => {
            const { confirmDiscard } = useRouteGeometry();

            confirmDiscard('/lines');

            expect(confirm).not.toHaveBeenCalled();
            expect(router.get).toHaveBeenCalledWith('/lines');
        });

        test('asks before leaving a dirty page', () => {
            const { confirmDiscard, setGeometry } = useRouteGeometry();

            setGeometry(route);
            confirmDiscard('/lines');

            expect(confirm).toHaveBeenCalledWith(
                'You have unsaved changes. Leave without saving?',
            );
        });

        test('stays put when the reviewer says no', () => {
            confirm.mockReturnValue(false);

            const { confirmDiscard, setGeometry } = useRouteGeometry();

            setGeometry(route);
            confirmDiscard('/lines');

            expect(router.get).not.toHaveBeenCalled();
        });

        test('leaves when the reviewer says yes', () => {
            const { confirmDiscard, setGeometry } = useRouteGeometry();

            setGeometry(route);
            confirmDiscard('/lines');

            expect(router.get).toHaveBeenCalledWith('/lines');
        });

        test('defaults to the line list', () => {
            // The create page has nowhere else to go, and the edit page's other
            // three destinations pass their own.
            const { confirmDiscard } = useRouteGeometry();

            confirmDiscard();

            expect(vi.mocked(router.get)).toHaveBeenCalledWith('/lines');
        });
    });
});
