import { describe, expect, test } from 'vitest';
import type { EditorMode, Keystroke, ShortcutContext } from './shortcuts';
import { describeShortcuts, modeForAction, resolveShortcut } from './shortcuts';

/**
 * The editor in its plainest state, and a keystroke with nothing focused.
 *
 * Built by override rather than written out at each call site: a test that
 * spells the whole context is a test whose every case has to be re-read when a
 * field is added, and the fields are the thing being exercised here.
 */
function context(overrides: Partial<ShortcutContext> = {}): ShortcutContext {
    return {
        editing: true,
        hasGeometry: true,
        mode: 'move',
        hasSelection: false,
        hasGuidedOffer: false,
        ...overrides,
    };
}

function press(key: string, overrides: Partial<Keystroke> = {}): Keystroke {
    return { key, ...overrides };
}

const ALL_MODES: EditorMode[] = ['move', 'guide', 'add', 'delete'];

describe('resolveShortcut — the mode keys', () => {
    test("1 through 4 name the four modes, in the picker's order", () => {
        // The picker lists Move, Guide, Add vertex, Delete vertex in that order,
        // and the numbers are the only thing on screen that says so. Pinned as a
        // map rather than four separate assertions because the failure this
        // guards against is a key that still works and has been reassigned.
        expect(resolveShortcut(press('1'), context())).toBe('set-mode:move');
        expect(resolveShortcut(press('2'), context())).toBe('set-mode:guide');
        expect(resolveShortcut(press('3'), context())).toBe('set-mode:add');
        expect(resolveShortcut(press('4'), context())).toBe('set-mode:delete');
    });

    test('they do nothing with the editor closed', () => {
        // The mode picker is not rendered when the editor is closed, so a key
        // that changed the mode anyway would be changing something the reviewer
        // cannot see — and it would fire the moment this page loads.
        for (const key of ['1', '2', '3', '4']) {
            expect(
                resolveShortcut(press(key), context({ editing: false })),
            ).toBeNull();
        }
    });

    test('they stay bound in every mode, which is what makes them worth learning', () => {
        // A shortcut that only worked in one mode would be a second thing to
        // remember per mode. These are the same four keys in all four.
        for (const mode of ALL_MODES) {
            expect(resolveShortcut(press('4'), context({ mode }))).toBe(
                'set-mode:delete',
            );
        }
    });

    test('no digit outside 1-4 is a mode key', () => {
        for (const key of ['0', '5', '9']) {
            expect(resolveShortcut(press(key), context())).toBeNull();
        }
    });
});

describe('resolveShortcut — opening the editor', () => {
    test('e toggles it when there is a route', () => {
        expect(resolveShortcut(press('e'), context())).toBe('toggle-edit');
    });

    test('e does nothing with no route', () => {
        // The toggle button is `v-if="parsedGeoJson"` — with an empty or
        // unparseable field it is not on screen, so the key must not be either.
        // This is the binding most likely to look harmless and quietly break:
        // it is the one that fires before the reviewer has looked at the page.
        expect(
            resolveShortcut(press('e'), context({ hasGeometry: false })),
        ).toBeNull();
    });

    test('e works with the editor closed AND open', () => {
        // Otherwise it would only ever be an "open" key, and the way back out
        // of the editor would still be a trip to the button.
        for (const editing of [true, false]) {
            expect(resolveShortcut(press('e'), context({ editing }))).toBe(
                'toggle-edit',
            );
        }
    });

    test('a shifted E does nothing', () => {
        // `e.key` is 'E' with shift held, which matches nothing. The reviewer
        // pressing Shift+E for something else gets nothing rather than the
        // editor opening under a chord aimed elsewhere.
        expect(resolveShortcut(press('E'), context())).toBeNull();
    });
});

describe('resolveShortcut — accepting a guided tramo', () => {
    test('Enter accepts while an offer is on screen', () => {
        expect(
            resolveShortcut(
                press('Enter'),
                context({ mode: 'guide', hasGuidedOffer: true }),
            ),
        ).toBe('accept-guided-offer');
    });

    test('Enter does nothing with no offer to accept', () => {
        // This is the guard that matters most. Accept rewrites geometry and
        // emits a whole new recipe; firing it on a stray Enter in guide mode
        // would be a change nobody asked for, on a page where Enter is also
        // what the form's Save and every button take.
        expect(
            resolveShortcut(
                press('Enter'),
                context({ mode: 'guide', hasGuidedOffer: false }),
            ),
        ).toBeNull();
    });

    test('Enter does not accept in any other mode', () => {
        for (const mode of ALL_MODES.filter((m) => m !== 'guide')) {
            expect(
                resolveShortcut(
                    press('Enter'),
                    context({ mode, hasGuidedOffer: true }),
                ),
            ).toBeNull();
        }
    });

    test('accepting is not bound to Shift+Enter or Ctrl+Enter either', () => {
        // The bare key is the only one, because a modified key is left to the
        // undo arbitration that two listeners already share.
        for (const modifiers of [{ shift: true }, { ctrl: true }]) {
            expect(
                resolveShortcut(
                    press('Enter', modifiers),
                    context({ mode: 'guide', hasGuidedOffer: true }),
                ),
            ).toBeNull();
        }
    });
});

describe('resolveShortcut — deleting the selection', () => {
    test('Delete and Backspace remove the selection in delete mode', () => {
        // Both, because the key this editor's own help told the reviewer to
        // press is 'press Delete', and laptops without one are the norm.
        for (const key of ['Delete', 'Backspace']) {
            expect(
                resolveShortcut(
                    press(key),
                    context({ mode: 'delete', hasSelection: true }),
                ),
            ).toBe('delete-selection');
        }
    });

    test('neither does anything with nothing selected', () => {
        // The button is disabled on an empty selection, and a disabled control
        // with a live keyboard equivalent is the one thing that must not exist:
        // the reviewer would learn that the key "does nothing" here and stop
        // believing what the button says about why.
        for (const key of ['Delete', 'Backspace']) {
            expect(
                resolveShortcut(press(key), context({ mode: 'delete' })),
            ).toBeNull();
        }
    });

    test('neither deletes outside delete mode', () => {
        // The button is rendered inside the delete-mode toolbar and nowhere
        // else. Deleting a selection while dragging vertices around would be a
        // destructive action with no button on screen to explain it.
        for (const mode of ALL_MODES.filter((m) => m !== 'delete')) {
            expect(
                resolveShortcut(
                    press('Delete'),
                    context({ mode, hasSelection: true }),
                ),
            ).toBeNull();
        }
    });

    test('a single selected vertex is enough', () => {
        // The button allows it, and the help promises it for a boxed set of
        // any size including one. A guard stricter than the button's would make
        // the shortcut and the control disagree about the same selection.
        expect(
            resolveShortcut(
                press('Delete'),
                context({ mode: 'delete', hasSelection: true }),
            ),
        ).toBe('delete-selection');
    });
});

describe('resolveShortcut — what it refuses', () => {
    test('no modified key is ever ours', () => {
        // Ctrl+Z belongs to an arbitration between two listeners that share
        // the defaultPrevented protocol. A third participant reading the same
        // key is a third way for one of them to lose the claim, so the whole
        // modified space is refused before anything else is considered.
        const contextWithEverythingLive = context({
            mode: 'delete',
            hasSelection: true,
            hasGuidedOffer: true,
        });

        for (const key of ['1', 'e', 'Enter', 'Delete', 'Backspace']) {
            for (const modifiers of [
                { ctrl: true },
                { meta: true },
                { alt: true },
                { shift: true },
            ]) {
                expect(
                    resolveShortcut(
                        press(key, modifiers),
                        contextWithEverythingLive,
                    ),
                ).toBeNull();
            }
        }
    });

    test('a focused text field keeps its keys', () => {
        // The caret is in the GeoJSON textarea and the reviewer presses Delete
        // to remove a character. Every binding here would destroy something.
        for (const targetTag of ['INPUT', 'TEXTAREA']) {
            expect(
                resolveShortcut(
                    press('Delete', { targetTag }),
                    context({ mode: 'delete', hasSelection: true }),
                ),
            ).toBeNull();
        }
    });

    test('a focused button keeps its keys', () => {
        // shadcn's Select renders its trigger as a <button> and drives its
        // listbox from the keyboard. Without this, pressing 2 with the snap
        // picker focused would change the editing mode behind an open
        // dropdown, and Enter would accept a guided tramo while the reviewer
        // was choosing an option off a list.
        for (const key of ['1', '2', 'e', 'Enter', 'Delete']) {
            expect(
                resolveShortcut(
                    press(key, { targetTag: 'BUTTON' }),
                    context({
                        mode: 'guide',
                        hasSelection: true,
                        hasGuidedOffer: true,
                    }),
                ),
            ).toBeNull();
        }
    });

    test('an open listbox keeps its keys', () => {
        // The reka-ui listbox is a DIV, so there is no tag to read and the role
        // is the only thing left to go on. Removing this would reintroduce the
        // button case above through the one element that has no button in it.
        for (const targetRole of ['listbox', 'option', 'combobox', 'dialog']) {
            expect(
                resolveShortcut(
                    press('Enter', { targetRole }),
                    context({ mode: 'guide', hasGuidedOffer: true }),
                ),
            ).toBeNull();
        }
    });

    test('an unbound key is nothing', () => {
        for (const key of ['q', 'z', ' ', 'F5', 'ArrowUp', 'Tab']) {
            expect(resolveShortcut(press(key), context())).toBeNull();
        }
    });

    test('the keys undo and escape already own are left alone', () => {
        // Both have handlers, both are deliberate, and neither is a candidate
        // for this table. Asserting they resolve to null documents that the
        // omission is a decision rather than an oversight.
        expect(
            resolveShortcut(press('z', { ctrl: true }), context()),
        ).toBeNull();
        expect(
            resolveShortcut(press('z', { ctrl: true, shift: true }), context()),
        ).toBeNull();
        expect(resolveShortcut(press('Escape'), context())).toBeNull();
    });
});

describe('modeForAction', () => {
    test('round-trips every mode key the resolver can produce', () => {
        for (const key of ['1', '2', '3', '4']) {
            const action = resolveShortcut(press(key), context());

            expect(action).not.toBeNull();
            expect(
                ALL_MODES.includes(
                    modeForAction(action as never) as EditorMode,
                ),
            ).toBe(true);
        }
    });

    test('the action names a real mode, not a guess', () => {
        expect(modeForAction('set-mode:move')).toBe('move');
        expect(modeForAction('set-mode:guide')).toBe('guide');
        expect(modeForAction('set-mode:add')).toBe('add');
        expect(modeForAction('set-mode:delete')).toBe('delete');
    });

    test('an action that is not a mode has no mode', () => {
        // `as never` rather than a widened union: the point is that this
        // function answers null for the actions the resolver can also return
        // which are not modes, and the call site is the one that decides.
        for (const action of [
            'toggle-edit',
            'accept-guided-offer',
            'delete-selection',
        ] as const) {
            expect(modeForAction(action as never)).toBeNull();
        }
    });
});

describe('describeShortcuts', () => {
    test('offers the mode keys in every mode', () => {
        for (const mode of ALL_MODES) {
            expect(describeShortcuts(mode)).toContain('1-4 switch mode');
        }
    });

    test('offers Accept only in the mode that has an Accept button', () => {
        expect(describeShortcuts('guide')).toContain('Enter');

        for (const mode of ALL_MODES.filter((m) => m !== 'guide')) {
            expect(describeShortcuts(mode)).not.toContain('Enter');
        }
    });

    test('offers Delete only in the mode that has a Delete button', () => {
        expect(describeShortcuts('delete')).toContain('Delete');

        for (const mode of ALL_MODES.filter((m) => m !== 'delete')) {
            expect(describeShortcuts(mode)).not.toContain('Delete');
        }
    });

    test('offers the editor toggle everywhere', () => {
        for (const mode of ALL_MODES) {
            expect(describeShortcuts(mode)).toContain(
                'open or close the editor',
            );
        }
    });

    /**
     * The guard that makes the help more than a list someone kept in step by
     * hand: every binding in the table must be findable from the help of a mode
     * it answers in, and findable by a key that actually resolves to it.
     *
     * A shortcut added to the resolver without a line in the help is the exact
     * failure this codebase calls a promise the editor does not keep — which is
     * how `describeModeHelp` came to promise a Delete key that did not exist.
     */
    test('every binding is documented, in a mode where it is live', () => {
        const documented = new Map<EditorMode, string>(
            ALL_MODES.map((mode) => [mode, describeShortcuts(mode)]),
        );

        const bindings: Array<{
            key: string;
            context: ShortcutContext;
        }> = [
            {
                key: 'e',
                context: context({ editing: false, hasGeometry: true }),
            },
            {
                key: 'Enter',
                context: context({ mode: 'guide', hasGuidedOffer: true }),
            },
            {
                key: 'Delete',
                context: context({ mode: 'delete', hasSelection: true }),
            },
        ];

        for (const binding of bindings) {
            const action = resolveShortcut(press(binding.key), binding.context);

            expect(action).not.toBeNull();

            const line = documented.get(binding.context.mode) ?? '';

            expect(line).toContain(binding.key);
        }
    });
});
