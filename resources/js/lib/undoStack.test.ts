import { describe, expect, test } from 'vitest';
import {
    canRedo,
    canUndo,
    emptyHistory,
    record,
    redoStep,
    undoStep,
} from './undoStack';
import type { History } from './undoStack';

/**
 * Two edits made: "a" was left behind, then "b" was left behind, and the
 * screen now shows "c".
 *
 * record() pushes the state being left behind, so the undo stack holds the
 * states a step would return to — never the one on screen.
 */
function built(limit = 10): History<string> {
    return record(record(emptyHistory<string>(), 'a', limit), 'b', limit);
}

describe('record', () => {
    test('pushes the state being left behind', () => {
        expect(record(emptyHistory(), 'a', 10).undo).toEqual(['a']);
    });

    test('keeps states oldest first', () => {
        expect(built().undo).toEqual(['a', 'b']);
    });

    test('a new edit discards the branch that was undone', () => {
        // Undo back to "b", then edit from there: the state that was undone
        // ("c") is no longer reachable.
        const undone = undoStep(built(), 'c');
        const after = record(undone.history, undone.value!, 10);

        expect(after.undo).toEqual(['a', 'b']);
        expect(after.redo).toEqual([]);
        expect(canRedo(after)).toBe(false);
    });

    test('drops the oldest entry once the limit is reached', () => {
        let history = emptyHistory();

        for (const state of ['a', 'b', 'c', 'd']) {
            history = record(history, state, 3);
        }

        expect(history.undo).toEqual(['b', 'c', 'd']);
    });

    test('a limit of zero keeps nothing', () => {
        expect(record(emptyHistory(), 'a', 0).undo).toEqual([]);
    });

    test('does not mutate the history it was given', () => {
        const before = built();

        record(before, 'z', 10);

        expect(before.undo).toEqual(['a', 'b']);
        expect(before.redo).toEqual([]);
    });
});

describe('undoStep', () => {
    test('returns the most recent past state', () => {
        expect(undoStep(built(), 'current').value).toBe('b');
    });

    test('moves what was on screen onto the redo stack', () => {
        expect(undoStep(built(), 'current').history.redo).toEqual(['current']);
    });

    test('pops the undo stack', () => {
        expect(undoStep(built(), 'current').history.undo).toEqual(['a']);
    });

    test('an empty undo stack is a no-op', () => {
        const step = undoStep(emptyHistory(), 'current');

        expect(step.value).toBeNull();
        expect(step.history).toEqual(emptyHistory());
    });

    test('preserves formatting that parsing and re-stringifying would destroy', () => {
        // The textarea holds whatever the reviewer typed or the map emitted.
        // A history that parsed on the way in would silently reflow it, and
        // the next save would then post a reformat of their work.
        const messy =
            '{\n    "type": "MultiLineString",\n    "coordinates": [[[1,2]]]\n}';

        const history = record(emptyHistory(), messy, 10);

        expect(undoStep(history, 'next').value).toBe(messy);
    });

    test('handles a line that had no geometry at all', () => {
        const history = record(emptyHistory(), '', 10);

        expect(undoStep(history, 'new').value).toBe('');
    });

    test('does not mutate the history it was given', () => {
        const before = built();

        undoStep(before, 'current');

        expect(before.undo).toEqual(['a', 'b']);
        expect(before.redo).toEqual([]);
    });
});

describe('redoStep', () => {
    test('returns the state that was undone', () => {
        const undone = undoStep(built(), 'c');

        expect(redoStep(undone.history, undone.value!).value).toBe('c');
    });

    test('moves what was on screen back onto the undo stack', () => {
        const undone = undoStep(built(), 'c');
        const redone = redoStep(undone.history, 'b');

        expect(redone.history.undo).toEqual(['a', 'b']);
        expect(redone.history.redo).toEqual([]);
    });

    test('an empty redo stack is a no-op, not an undo', () => {
        const step = redoStep(built(), 'current');

        expect(step.value).toBeNull();
        expect(step.history.undo).toEqual(['a', 'b']);
    });

    test('does not mutate the history it was given', () => {
        const undone = undoStep(built(), 'c');

        redoStep(undone.history, 'b');

        expect(undone.history.undo).toEqual(['a']);
        expect(undone.history.redo).toEqual(['c']);
    });
});

describe('round trips', () => {
    test('undoing and redoing returns to where it started', () => {
        const start = built();
        const undone = undoStep(start, 'current');
        const redone = redoStep(undone.history, undone.value!);

        expect(redone.history).toEqual(start);
        expect(redone.value).toBe('current');
    });

    test('stepping all the way back and forward preserves the order', () => {
        const start = built();
        let history = start.undo;
        let value = 'current';

        for (let i = 0; i < start.undo.length; i++) {
            const step = undoStep({ undo: history, redo: [] }, value);
            value = step.value!;
            history = step.history.undo;
        }

        expect(value).toBe('a');
        expect(canUndo({ undo: history, redo: [] })).toBe(false);
    });

    test('the undo and redo stacks never share an entry', () => {
        const undone = undoStep(built(), 'current');

        // A shared reference would let one step move the same string twice.
        expect(undone.history.undo[undone.history.undo.length - 1]).not.toBe(
            undone.history.redo[0],
        );
    });
});

describe('canUndo and canRedo', () => {
    test('report what a step would actually do', () => {
        const start = built();

        expect(canUndo(start)).toBe(true);
        expect(canRedo(start)).toBe(false);

        const undone = undoStep(start, 'current');

        expect(canUndo(undone.history)).toBe(true);
        expect(canRedo(undone.history)).toBe(true);
    });

    test('a fresh history can do neither', () => {
        expect(canUndo(emptyHistory())).toBe(false);
        expect(canRedo(emptyHistory())).toBe(false);
    });
});

/**
 * The guided editor's state: the geometry text and the control points a
 * tramo hangs from travel as one entry, because two parallel stacks could
 * desync — one undoing what the other never saw.
 */
interface GuidedState {
    geometry: string;
    waypoints: string[];
}

describe('a composite state (the guided pair)', () => {
    const state = (geometry: string, ...waypoints: string[]): GuidedState => ({
        geometry,
        waypoints,
    });

    test('the pair is restored whole, geometry and controls together', () => {
        const history = record(
            record(emptyHistory<GuidedState>(), state('a', 'w1'), 10),
            state('b', 'w1', 'w2'),
            10,
        );

        const step = undoStep(history, state('c', 'w1', 'w2', 'w3'));

        expect(step.value).toEqual(state('b', 'w1', 'w2'));
    });

    test('redo replays the composite pair too', () => {
        const first = record(emptyHistory<GuidedState>(), state('a', 'w1'), 10);
        const undone = undoStep(first, state('b', 'w1', 'w2'));
        const redone = redoStep(undone.history, undone.value!);

        expect(redone.value).toEqual(state('b', 'w1', 'w2'));
    });

    test('an aliased object in the stack is not the entry the next record pushed', () => {
        // The caller builds one state object and hands it over; if the stack
        // kept it by reference and the caller then mutated it, the stack's
        // "old" state would change under it. record() stores what it was
        // handed, so the caller who mutates after recording lies to the
        // stack — the assertion documents which side owns the copy.
        const shared = state('a', 'w1');
        const history = record(emptyHistory<GuidedState>(), shared, 10);

        shared.waypoints.push('w2');

        expect(history.undo[0].waypoints).toEqual(['w1', 'w2']);
    });
});
