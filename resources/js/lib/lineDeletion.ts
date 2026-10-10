import type { LineSense } from '@/types/line';

/**
 * What the delete dialog says, derived in one place.
 *
 * The dialog is mounted from two surfaces — the row in the index table and
 * the button in the edit page's direction card — and a reviewer has to be told
 * the same true thing from either one. Two copies of this copy would drift,
 * and a delete dialog that describes a different set of consequences depending
 * on where it was opened from is worse than no dialog at all.
 *
 * Pure on purpose: it touches no DOM and no Vue, so it is testable in the
 * `node` environment Vitest runs in, where a component test is not possible.
 */

/** The minimum a caller has to hand over to describe the deletion. */
export interface DeletableLine {
    id: number;
    code: string;
    sense: LineSense;
}

export interface DeleteConsequencesOptions {
    /**
     * Whether the opposite direction of the same code exists.
     *
     * Decides the one sentence that matters most, because the record being
     * deleted is one *direction*: without this the reviewer cannot tell
     * whether they are removing half of "Línea 1" or all of it.
     */
    hasCounterpart?: boolean;

    /**
     * Whether this visit of the page has unsaved edits.
     *
     * Deleting navigates, and an Inertia visit throws away anything typed but
     * not saved. On the index there is nothing to lose, so the sentence only
     * appears where there is something.
     */
    hasUnsavedEdits?: boolean;
}

export interface DeleteConsequences {
    title: string;
    /** Body sentences, in the order they should be read. */
    lines: string[];
}

/**
 * Whether a code names a numbered line.
 *
 * Mirrors `Line::numberFromCode()` and `App\Rules\LineCode`: a code is either
 * "<number>[ <suffix>]", or a lowercase slug for a service that has no number
 * at all. The copy needs the distinction because a numbered line is
 * recoverable from the committed source GeoJSON and a slug-coded one exists
 * only in this database — deleting the second is final even though the
 * reviewer may not know it.
 */
export function isNumberedCode(code: string): boolean {
    return /^\d+/.test(code.trim());
}

export function senseLabel(sense: LineSense): string {
    return sense === 'RETURN' ? 'Vuelta' : 'Ida';
}

/**
 * The other direction of the same code.
 *
 * Exact rather than a lookup: there is at most one row per (code, sense), so
 * the counterpart of an OUTBOUND is the RETURN and vice versa. Circular routes
 * such as 72 and 73 are the case where no such row exists, which is why the
 * caller words this sentence around a boolean rather than around the row.
 */
export function oppositeSense(sense: LineSense): LineSense {
    return sense === 'OUTBOUND' ? 'RETURN' : 'OUTBOUND';
}

/**
 * Every consequence of deleting this direction, in words.
 *
 * The rule the wording exists to serve: never name a consequence the delete
 * does not have, and never omit one it does. A numbered line really does come
 * back on the next import, transfers really do go, and the counterpart really
 * does survive — so all three are said, out loud, every time.
 */
export function describeDeleteConsequences(
    line: DeletableLine,
    options: DeleteConsequencesOptions = {},
): DeleteConsequences {
    const { hasCounterpart = false, hasUnsavedEdits = false } = options;

    const label = `${line.code} (${senseLabel(line.sense)})`;

    const lines = [
        hasCounterpart
            ? `Only this direction is deleted. The ${line.code} ${senseLabel(
                  oppositeSense(line.sense),
              ).toLowerCase()} stays in the table.`
            : 'This is the only record of this route, so nothing is left of it under that code.',
        'Its control points, its reviews and favourites, and every precomputed transfer that touches it go with it.',
        isNumberedCode(line.code)
            ? 'A numbered line can be re-imported from the source GeoJSON, so lines:import would bring this back.'
            : 'This code has no number and no source feature, so nothing upstream can bring it back.',
    ];

    if (hasUnsavedEdits) {
        lines.push('The unsaved edits on this form are discarded.');
    }

    return {
        title: `Delete ${label}?`,
        lines,
    };
}
