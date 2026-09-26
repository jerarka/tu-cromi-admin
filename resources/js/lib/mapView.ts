/**
 * Whether a geometry change should leave the map's framing alone.
 *
 * Pulled out of the component because the invariant it protects is a claim
 * about a sequence of events, and a claim about a sequence of events cannot be
 * checked by reading the code that implements it. The map refits the route into
 * view whenever the geometry changes, which is right after a drag and wrong
 * after an undo: the reviewer has just zoomed to look at a detail, and a refit
 * discards that at the exact moment they are checking what the undo did.
 *
 * The parent's counter rather than a flag, because a flag cannot say "this
 * once". Left set, it would still be set when the reviewer moves to the next
 * line, and that navigation is precisely the case where the bounds do want to
 * change.
 */

/**
 * Record that a preserve request has been seen, and report whether it was new.
 *
 * Pure, and given the previously seen value rather than reaching for it, so
 * that the whole sequence can be driven from a test.
 */
export function consumePreserveToken(
    seen: number,
    token: number,
): { seen: number; preserve: boolean } {
    if (token === seen) {
        return { seen, preserve: false };
    }

    return { seen: token, preserve: true };
}
