import { describe, expect, it } from 'vitest';
import {
    describeDeleteConsequences,
    isNumberedCode,
    oppositeSense,
    senseLabel,
} from './lineDeletion';

const outbound = { id: 1, code: '22 rojo', sense: 'OUTBOUND' as const };
const slug = {
    id: 2,
    code: 'la-guardia-nueva-terminal',
    sense: 'OUTBOUND' as const,
};

describe('isNumberedCode', () => {
    it('accepts a bare number and a number with a suffix', () => {
        expect(isNumberedCode('2')).toBe(true);
        expect(isNumberedCode('104 C')).toBe(true);
        expect(isNumberedCode('  22 rojo')).toBe(true);
    });

    it('rejects a service with no number', () => {
        expect(isNumberedCode('la-guardia-nueva-terminal')).toBe(false);
    });
});

describe('senseLabel', () => {
    it('names the direction the way the index badge does', () => {
        expect(senseLabel('OUTBOUND')).toBe('Ida');
        expect(senseLabel('RETURN')).toBe('Vuelta');
    });
});

describe('oppositeSense', () => {
    it('is exact in both directions', () => {
        expect(oppositeSense('OUTBOUND')).toBe('RETURN');
        expect(oppositeSense('RETURN')).toBe('OUTBOUND');
    });
});

describe('describeDeleteConsequences', () => {
    it('names the row being deleted, code and direction together', () => {
        // Two rows share a code, so "Deleted 22 rojo" would be ambiguous about
        // which of them went.
        const { title } = describeDeleteConsequences(outbound);

        expect(title).toBe('Delete 22 rojo (Ida)?');
    });

    it('says the opposite direction survives when there is one', () => {
        const { lines } = describeDeleteConsequences(outbound, {
            hasCounterpart: true,
        });

        expect(lines[0]).toBe(
            'Only this direction is deleted. The 22 rojo vuelta stays in the table.',
        );
    });

    it('names the surviving sibling from a return direction too', () => {
        // The sentence is derived, not a fixed string: from the other end of
        // the pair it must name the other leg, not repeat the one being deleted.
        const { lines } = describeDeleteConsequences(
            { id: 3, code: '22 rojo', sense: 'RETURN' },
            { hasCounterpart: true },
        );

        expect(lines[0]).toBe(
            'Only this direction is deleted. The 22 rojo ida stays in the table.',
        );
    });

    it('says nothing survives when the line is alone in its direction', () => {
        // Circular routes such as 72 and 73: no counterpart, so the partial
        // delete is a total one and the copy has to say so.
        const { lines } = describeDeleteConsequences({
            id: 4,
            code: '72',
            sense: 'OUTBOUND',
        });

        expect(lines[0]).toBe(
            'This is the only record of this route, so nothing is left of it under that code.',
        );
    });

    it('always names the rows that go with it', () => {
        const { lines } = describeDeleteConsequences(outbound);

        expect(lines).toContain(
            'Its control points, its reviews and favourites, and every precomputed transfer that touches it go with it.',
        );
    });

    it('warns that a numbered line comes back on the next import', () => {
        const { lines } = describeDeleteConsequences(outbound);

        expect(lines[2]).toBe(
            'A numbered line can be re-imported from the source GeoJSON, so lines:import would bring this back.',
        );
    });

    it('says a slug-coded line has no source to come back from', () => {
        // The same warning would be a lie here, and a reviewer who read it
        // would believe the delete was recoverable.
        const { lines } = describeDeleteConsequences(slug);

        expect(lines[2]).toBe(
            'This code has no number and no source feature, so nothing upstream can bring it back.',
        );
    });

    it('mentions unsaved edits only when there are some', () => {
        const clean = describeDeleteConsequences(outbound);
        const dirty = describeDeleteConsequences(outbound, {
            hasUnsavedEdits: true,
        });

        expect(clean.lines).not.toContain(
            'The unsaved edits on this form are discarded.',
        );
        expect(dirty.lines).toContain(
            'The unsaved edits on this form are discarded.',
        );
    });
});
