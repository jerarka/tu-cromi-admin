/**
 * An immutable undo/redo history for a single piece of state.
 *
 * Pulled out of the component so it can be tested without a DOM. The two bugs
 * it guards against are both aliasing: a stack mutated in place leaves the
 * previous state readable after it has been "undone" past, and a shared
 * reference between the undo and redo stacks makes a step move the same entry
 * twice. Every operation here returns a new history and never touches the one
 * it was given.
 *
 * Generic over the state it carries. The first consumer stored raw text on
 * purpose — a map edit emits valid GeoJSON, but the surrounding textarea can
 * hold anything the reviewer typed, including a half-finished edit that does
 * not parse, and storing the text means undo restores exactly what was there.
 * Guided drawing made the state a pair: the geometry text and the control
 * points that tramos hang from. Storing those in two parallel stacks would
 * let the pair desync — one stack undoing what the other never saw — so the
 * pair is one entry, and the type is honest about carrying whatever the
 * caller says a step is.
 *
 * This is per-visit history for one line. It is not a version log: a direction
 * change, a save, or navigating to another line all reload the page, and the
 * history goes with them.
 */

export interface History<T> {
    /** Past states, oldest first. The last entry is the one undo restores. */
    undo: T[];
    /** States that were undone, oldest first. The last is the one redo restores. */
    redo: T[];
}

export const emptyHistory = <T = unknown>(): History<T> => ({
    undo: [],
    redo: [],
});

/**
 * Push the state being left behind, so it can be returned to.
 *
 * Clearing redo is what makes undo linear: once a new edit is made, the branch
 * that was undone is no longer reachable, and keeping it would let redo walk
 * into a future that the user then abandoned.
 *
 * `limit` drops from the front, which is the oldest entry. Discarding the
 * deepest history rather than the shallowest is deliberate: the recent edits
 * are the ones still being worked on.
 */
export function record<T>(
    history: History<T>,
    current: T,
    limit: number,
): History<T> {
    const undo = [...history.undo, current];

    return {
        undo: undo.length > limit ? undo.slice(undo.length - limit) : undo,
        redo: [],
    };
}

export interface Step<T> {
    history: History<T>;
    /** The state to apply, or null when there was nothing to move to. */
    value: T | null;
}

/**
 * Move one step back, returning the state to show.
 *
 * `current` is what is on screen right now, not necessarily what the top of
 * the undo stack holds — the reviewer may have typed in the textarea since the
 * last map edit. Whichever it is, it is the state redo has to come back to.
 */
export function undoStep<T>(history: History<T>, current: T): Step<T> {
    const undo = [...history.undo];
    const previous = undo.pop();

    if (previous === undefined) {
        return { history, value: null };
    }

    return {
        history: { undo, redo: [...history.redo, current] },
        value: previous,
    };
}

/**
 * Move one step forward, returning the state to show.
 *
 * The mirror of undoStep, and asymmetric in exactly one place: redoStep
 * consumes the redo stack, so an empty one is a genuine no-op rather than a
 * silent "undo back".
 */
export function redoStep<T>(history: History<T>, current: T): Step<T> {
    const redo = [...history.redo];
    const next = redo.pop();

    if (next === undefined) {
        return { history, value: null };
    }

    return {
        history: { undo: [...history.undo, current], redo },
        value: next,
    };
}

/**
 * Whether an undo or redo would do anything.
 *
 * Kept next to the stack so the disabled state of a button cannot drift from
 * what the step would actually do.
 */
export function canUndo(history: History<unknown>): boolean {
    return history.undo.length > 0;
}

export function canRedo(history: History<unknown>): boolean {
    return history.redo.length > 0;
}
