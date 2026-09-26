<?php

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Translation\PotentiallyTranslatedString;

/**
 * Validate that a payload is a usable GeoJSON MultiLineString.
 *
 * The built-in `json` rule only proves the value parses, so payloads such as
 * `123`, `[]` or a whole FeatureCollection are accepted and then written into
 * the jsonb column. Line casts geo_json to an array and LineMap reads
 * `.coordinates` off it, so a malformed payload renders an empty map with no
 * error anywhere — a silent loss of route geometry.
 *
 * A line string is only required to hold at least one position, not two: the
 * map editor emits a single-vertex geometry while the user is still placing
 * points (see LineMap.vue), and rejecting that intermediate state would break
 * drawing a route.
 */
final class GeoJsonMultiLineString implements ValidationRule
{
    /**
     * Run the validation rule.
     *
     * @param  Closure(string, ?string=): PotentiallyTranslatedString  $fail
     */
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (is_string($value)) {
            $decoded = json_decode($value, true);

            if (json_last_error() !== JSON_ERROR_NONE) {
                $fail('The :attribute must be valid JSON.');

                return;
            }

            $value = $decoded;
        }

        if (! is_array($value)) {
            $fail('The :attribute must be valid GeoJSON.');

            return;
        }

        if (($value['type'] ?? null) !== 'MultiLineString') {
            $fail('The :attribute must be a GeoJSON MultiLineString.');

            return;
        }

        $lineStrings = $value['coordinates'] ?? null;

        if (! is_array($lineStrings) || $lineStrings === []) {
            $fail('The :attribute must contain at least one line string.');

            return;
        }

        foreach ($lineStrings as $lineString) {
            if (! is_array($lineString) || $lineString === []) {
                $fail('Each line string in the :attribute must contain at least one position.');

                return;
            }

            foreach ($lineString as $position) {
                if (! $this->isPosition($position)) {
                    $fail('Each position in the :attribute must be a [longitude, latitude] pair of numbers.');

                    return;
                }
            }
        }
    }

    /**
     * A position is an array whose first two entries are numbers, in
     * [longitude, latitude] order.
     */
    private function isPosition(mixed $position): bool
    {
        if (! is_array($position) || count($position) < 2) {
            return false;
        }

        return is_numeric($position[0]) && is_numeric($position[1]);
    }
}
