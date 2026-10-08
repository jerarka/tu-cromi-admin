<?php

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Translation\PotentiallyTranslatedString;

/**
 * The guided editor's control-point payload, as one rule.
 *
 * The form sends the recipe the way it sends geometry: as a JSON string the
 * client controls, in one field, validated as a whole. The payload is a list
 * of {lat, lng} pairs — nothing else. Ordinal and role are deliberately
 * absent from what the client may send: the server derives both from the
 * array order, so a forged or stale role is not a validation question but a
 * non-surface, and the payloads that survive this rule are exactly the ones
 * syncWaypoints() can consume without a second look.
 *
 * Absence is not handled here: a missing waypoints field means "leave the
 * stored recipe alone", the same asymmetry geo_json already rides on, and it
 * lives at the controller where the abssence is visible.
 */
class WaypointsPayload implements ValidationRule
{
    /**
     * How many control points one route may hold.
     *
     * The same ceiling the editor's own WAYPOINT_LIMIT declares; two names
     * for one number is deliberate duplication — the rule cannot reach into
     * the frontend, and the frontend cannot load this file — so each side
     * holds its honest copy and the tests keep them honest with each other.
     */
    public const MAX_WAYPOINTS = 200;

    /** A validated payload, decoded once and typed once. */ /**
     * The validated string as the list the controller stores.
     *
     * Only valid to call after the rule accepted the payload: the decode
     * repeats json_decode, which is cheaper than inventing a second request
     * shape, and returns floats so the transaction never sees a string where
     * a position belongs — the PDO-numeric trap, avoided at the boundary.
     *
     * @return list<array{lat: float, lng: float}>
     */
    public static function decode(string $payload): array
    {
        /** @var list<array{lat: float, lng: float}> */
        $decoded = json_decode($payload, true) ?? [];

        return array_map(
            fn (array $point): array => [
                'lat' => (float) $point['lat'],
                'lng' => (float) $point['lng'],
            ],
            $decoded,
        );
    }

    /**
     * @param  Closure(string, string|null=): PotentiallyTranslatedString  $fail
     */
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if ($value === null || $value === '') {
            return;
        }

        if (! is_string($value)) {
            $fail('The control points payload must be a JSON string.');

            return;
        }

        /** @var mixed $decoded */
        $decoded = json_decode($value, true);

        if (json_last_error() !== JSON_ERROR_NONE || ! is_array($decoded)) {
            $fail('The control points payload is not valid JSON.');

            return;
        }

        if (count($decoded) > self::MAX_WAYPOINTS) {
            $fail('A route may hold at most '.self::MAX_WAYPOINTS.' control points.');

            return;
        }

        foreach ($decoded as $index => $point) {
            $this->validatePoint($index, $point, $fail);
        }
    }

    /**
     * @param  Closure(string, string|null=): PotentiallyTranslatedString  $fail
     */
    private function validatePoint(int|string $index, mixed $point, Closure $fail): void
    {
        if (! is_array($point)) {
            $fail("Control point #{$index} is not an object.");

            return;
        }

        $lat = $point['lat'] ?? null;
        $lng = $point['lng'] ?? null;

        if (! is_numeric($lat) || $lat < -90 || $lat > 90) {
            $fail("Control point #{$index} has no valid latitude.");

            return;
        }

        if (! is_numeric($lng) || $lng < -180 || $lng > 180) {
            $fail("Control point #{$index} has no valid longitude.");

            return;
        }
    }
}
