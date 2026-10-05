<?php

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Translation\PotentiallyTranslatedString;

/**
 * Validate that a payload is a usable line code.
 *
 * Two accepted shapes, because two kinds of bus exist:
 *
 * - A numbered code: "<number>", or a number and a suffix — "1", "22 rojo",
 *   "104 C". This is what the rider looks for on the bus.
 * - A slug for a service that has no number at all, only a route name painted
 *   on the side — "la-guardia-nueva-terminal". The slug is the identity and the
 *   rider-facing wording goes in `name`, so a rename never changes the code and
 *   never orphans the (code, sense) pairing, the transfer rows or the app's
 *   deep link.
 *
 * The two are told apart by requiring the slug to be lowercase with hyphens and
 * no spaces. That is also what keeps the typo guard: "2O rojo", a letter O where
 * a zero belongs, matches neither shape — the numbered branch needs digits up
 * to the first space, and the slug branch rejects both the space and the
 * uppercase letter. Dropping the rule would let that typo through as a valid
 * slug, and the mistake would surface much later as a line that sorts and
 * displays as text nobody recognises.
 *
 * Slugs are matched strictly rather than slugified from whatever was typed. A
 * code is identity, so "La Guardia - Nueva Terminal" is not silently rewritten
 * into something that only looks like the value the operator meant.
 */
final class LineCode implements ValidationRule
{
    private const NUMBERED = '/^\d+(\s+.+)?$/';

    private const SLUG = '/^[a-z0-9]+(?:-[a-z0-9]+)*$/';

    /**
     * Run the validation rule.
     *
     * @param  Closure(string, ?string=): PotentiallyTranslatedString  $fail
     */
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (! is_string($value)) {
            $fail('The :attribute must be a string.');

            return;
        }

        if (preg_match(self::NUMBERED, $value) === 1 || preg_match(self::SLUG, $value) === 1) {
            return;
        }

        $fail(
            'The :attribute must be a number, optionally followed by a suffix (e.g. "1" or "22 rojo"), '
            .'or a lowercase slug for a route with no number (e.g. "la-guardia-nueva-terminal").'
        );
    }
}
