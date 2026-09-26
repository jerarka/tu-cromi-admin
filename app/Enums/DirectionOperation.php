<?php

namespace App\Enums;

/**
 * How a line's two directions are re-oriented.
 *
 * Both operations act on the OUTBOUND/RETURN pair that shares a `code`, and
 * both are their own inverse — applying either twice returns the pair to its
 * previous state. That is what makes them safe to expose as a manual
 * correction with no undo log.
 */
enum DirectionOperation: string
{
    /**
     * Reverse the point order of both records.
     *
     * Each direction keeps its own streets and only the direction of travel
     * flips. This is the correction when the source digitised the right paths
     * in the wrong order.
     */
    case Invert = 'invert';

    /**
     * Exchange the geometry between the two records.
     *
     * The OUTBOUND then traces the streets the RETURN used and vice versa.
     * Only geo_json moves: code, sense, name, color and syndicate stay with
     * the sense label they describe. This is the correction when the source
     * labelled the two paths themselves crossed.
     */
    case Swap = 'swap';
}
