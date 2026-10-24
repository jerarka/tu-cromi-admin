/**
 * The editor's keyboard shortcuts, as a table and a pure resolver.
 *
 * In `lib/` rather than in either listener because there are two of them and
 * they must agree. The page answers for the history of a line and the map for
 * the history of a pending batch, they share the `defaultPrevented` protocol to
 * decide who speaks first, and a third rule living in a third place is a third
 * thing that can drift from the other two. Every binding here is a row, so
 * "what keys does this editor answer to" has exactly one answer.
 *
 * Pure in the sense that matters for testing: `resolveShortcut` takes a plain
 * object describing the keystroke and another describing the editor, and returns
 * an action name or null. No DOM, no Vue, no timers — which is the only reason
 * it can be asserted at all under a `node` test environment.
 *
 * Four bindings, and the number is the design. A shortcut nobody remembers is
 * worse than no shortcut, because it fires on the keystroke meant for something
 * else; every one added here has to be worth a slot in a memory that is already
 * holding Ctrl+Z.
 */

/**
 * What the map editor is doing with a click.
 *
 * Declared here rather than imported from the composable that owns it, because
 * this module is pure and the composable is not — and for the same reason
 * `describeModeHelp` spells its union out instead of importing it. The three
 * copies are structural rather than nominal: a fourth mode fails to compile at
 * the call sites below rather than quietly falling through to a default.
 */
export type EditorMode = 'move' | 'add' | 'delete' | 'guide';

/** A shortcut's answer: what the caller should now do, if anything. */
export type ShortcutAction =
    | 'toggle-edit'
    | 'set-mode:move'
    | 'set-mode:guide'
    | 'set-mode:add'
    | 'set-mode:delete'
    | 'accept-guided-offer'
    | 'delete-selection';

/**
 * The state that decides whether a binding is live.
 *
 * A binding exists only where the control it stands for is rendered, and obeys
 * that control's own guard — so every field here answers "is the button on
 * screen and enabled right now" for one button. There is no shortcut to an
 * action the reviewer cannot see, which is the "never hide an action" rule
 * pointed the other way: the button is the reason the shortcut may exist.
 */
export interface ShortcutContext {
    /** The map editor is open. The mode picker is not rendered otherwise. */
    editing: boolean;
    /** There is a route to edit. The editor's toggle is hidden otherwise. */
    hasGeometry: boolean;
    mode: EditorMode;
    /** The delete button is enabled: delete mode, with at least one vertex. */
    hasSelection: boolean;
    /** An Accept button is on screen, awaiting the judgement it exists for. */
    hasGuidedOffer: boolean;
}

/**
 * The keystroke, flattened.
 *
 * A shape rather than a `KeyboardEvent` so the resolver can be asserted without
 * constructing a DOM event — and so that the one field this most needs, "what
 * had focus", is something the caller has to think about explicitly instead of
 * something the resolver quietly reads off an object.
 */
export interface Keystroke {
    key: string;
    ctrl?: boolean;
    meta?: boolean;
    alt?: boolean;
    shift?: boolean;
    /** Uppercase tag name of the focused element, or null for the body. */
    targetTag?: string | null;
    /** ARIA role of the focused element, for the parts with no tag to read. */
    targetRole?: string | null;
}

/**
 * Elements that own the keyboard while they have it.
 *
 * `INPUT` and `TEXTAREA` are the obvious two, and the reason this module does
 * not reuse `isTextEntryTarget` from undoStack: that one answers "is this a
 * text field" for a Ctrl+Z, and this question is wider.
 *
 * `BUTTON` matters because shadcn's Select renders its trigger as one, and its
 * listbox is driven from the keyboard — arrows, Enter, typeahead. A `2` pressed
 * while the snap picker had focus would otherwise change the editing mode
 * *behind* an open dropdown, and an `Enter` would accept a guided tramo while
 * the reviewer was choosing an option from a list. `A` and `SELECT` are here
 * for the same reason they would be in any focus guard, and the roles catch the
 * reka-ui listbox, which is a DIV and has no tag to read.
 */
const FOCUS_OWNS_THE_KEY = new Set([
    'INPUT',
    'TEXTAREA',
    'SELECT',
    'BUTTON',
    'A',
]);

const FOCUS_ROLES_OWN_THE_KEY = new Set([
    'listbox',
    'option',
    'menu',
    'menuitem',
    'menuitemradio',
    'menuitemcheckbox',
    'combobox',
    'dialog',
]);

function focusOwnsTheKey(stroke: Keystroke): boolean {
    if (stroke.targetTag && FOCUS_OWNS_THE_KEY.has(stroke.targetTag)) {
        return true;
    }

    return Boolean(
        stroke.targetRole && FOCUS_ROLES_OWN_THE_KEY.has(stroke.targetRole),
    );
}

/**
 * What a keystroke means in this editor, or null when it means nothing here.
 *
 * The guard order is the design, and it is the order that keeps a shortcut from
 * stealing a keystroke that belonged to something else:
 *
 *  1. Modified keys are not ours. Every binding here is a BARE key, all four
 *     modifiers included, so Ctrl+Z and the map's own undo arbitration never
 *     reach this far — which matters because that arbitration is a
 *     `stopImmediatePropagation` between two listeners, and a third participant
 *     would be a third way to lose it. Shift is in this guard rather than
 *     left to `e.key` for a reason worth stating: `Shift+Enter` reports the key
 *     `Enter`, so without it here the shortcut would answer to a chord nobody
 *     was told about and the table could not describe what it accepts.
 *  2. Then focus, because a focused control's keys are its own regardless of
 *     what we would have done with them.
 *  3. Only then the binding table.
 *
 * Letters match in lower case and digits exactly, which means a shifted `E` is
 * `E` and matches nothing: the reviewer pressing Shift+E gets nothing rather
 * than the editor toggling under a chord aimed at something else.
 */
export function resolveShortcut(
    stroke: Keystroke,
    context: ShortcutContext,
): ShortcutAction | null {
    if (stroke.ctrl || stroke.meta || stroke.alt || stroke.shift) {
        return null;
    }

    if (focusOwnsTheKey(stroke)) {
        return null;
    }

    if (context.editing) {
        switch (stroke.key) {
            case '1':
                return 'set-mode:move';
            case '2':
                return 'set-mode:guide';
            case '3':
                return 'set-mode:add';
            case '4':
                return 'set-mode:delete';
        }
    }

    if (stroke.key === 'e' && context.hasGeometry) {
        return 'toggle-edit';
    }

    // Accept is the judgement the guided mode exists to ask for, and the button
    // is the only way to answer it — so this is the same button, reached by
    // keyboard, with the same condition: an offer is on screen.
    if (
        stroke.key === 'Enter' &&
        context.editing &&
        context.mode === 'guide' &&
        context.hasGuidedOffer
    ) {
        return 'accept-guided-offer';
    }

    // Delete mode only, matching the button, which is not rendered in any other
    // mode. A selection of one is enough because the button allows it.
    if (
        (stroke.key === 'Delete' || stroke.key === 'Backspace') &&
        context.editing &&
        context.mode === 'delete' &&
        context.hasSelection
    ) {
        return 'delete-selection';
    }

    return null;
}

/**
 * The four mode keys, and their labels.
 *
 * Data rather than a switch inside the resolver because the help text needs the
 * same four facts, and a list the help walks is a list the resolver cannot
 * disagree with. The labels are the mode picker's own wording, shortened —
 * "Guide along streets" is a button, and a help line is not the place to
 * re-explain it.
 */
const MODE_KEYS: ReadonlyArray<{ key: string; mode: EditorMode }> = [
    { key: '1', mode: 'move' },
    { key: '2', mode: 'guide' },
    { key: '3', mode: 'add' },
    { key: '4', mode: 'delete' },
];

/**
 * The shortcuts that are not the mode keys, and which modes each answers in.
 *
 * `scope` is a mode list rather than a predicate because the help renders these
 * and the test asserts against them, and a predicate would make both re-derive
 * the same condition in two more places.
 */
const OTHER_SHORTCUTS: ReadonlyArray<{
    keys: string;
    label: string;
    scope: 'always' | EditorMode[];
}> = [
    { keys: 'E', label: 'open or close the editor', scope: 'always' },
    { keys: 'Enter', label: 'accept the offered tramo', scope: ['guide'] },
    {
        keys: 'Delete',
        label: 'delete the selected vertices',
        scope: ['delete'],
    },
];

/**
 * The shortcuts live in a mode, in the words the reviewer needs while in it.
 *
 * Built from the tables above rather than written out per mode, for the reason
 * the resolver is one function: a binding added to `OTHER_SHORTCUTS` is
 * documented by construction, and the test that asserts every binding is
 * documented fails the day one is not.
 *
 * The mode keys read as a range because they are one gesture — four presses of
 * the same idea — and spelling out "1 Move, 2 Guide along streets, 3 Add vertex,
 * 4 Delete vertex" in the middle of a paragraph about dragging vertices makes
 * the paragraph unreadable. The per-mode meaning is on the buttons.
 */
export function describeShortcuts(mode: EditorMode): string {
    const parts: string[] = ['1-4 switch mode'];

    for (const shortcut of OTHER_SHORTCUTS) {
        if (shortcut.scope === 'always' || shortcut.scope.includes(mode)) {
            parts.push(`${shortcut.keys} ${shortcut.label}`);
        }
    }

    return `Keys: ${parts.join(' · ')}.`;
}

/**
 * The mode a mode key names, or null when the key names no mode.
 *
 * Exported so the page's dispatch is a lookup rather than a second switch: the
 * resolver says `set-mode:guide` and this says which value that is, and there
 * is no way for the two to disagree about it.
 */
export function modeForAction(action: ShortcutAction): EditorMode | null {
    const match = MODE_KEYS.find(
        (entry) => `set-mode:${entry.mode}` === action,
    );

    return match?.mode ?? null;
}
