<?php

namespace App\Osm;

/**
 * One OSM turn restriction, as the route router needs to consume it.
 *
 * Overpass hands back a relation whose members carry roles rather than
 * meanings: one way is the `from`, one way is the `to`, and the `via` is the
 * node (or, rarely, a way) where the turn is forbidden. This class turns that
 * element into the four identities the router checks against — from way, to
 * way, via position — or explains why it cannot.
 *
 * Two skips are domain decisions, not parsing failures, and both exist because
 * the router routes buses:
 *
 * A restriction whose `except` tag exempts buses (or public service vehicles,
 * or motor vehicles generally) does not apply to a bus route, so storing it
 * would forbid turns the bus is allowed to take.
 *
 * A `via` that is a way instead of a node (the "no U-turn via the next block"
 * pattern) names a stretch rather than a junction. The graph stores nodes, so
 * it cannot be addressed here; it is skipped and counted instead of being
 * stored unusable.
 *
 * The `via` travels as a coordinate rather than as a node id. The ways in the
 * roads table arrive from `out geom`, which carries geometry but no node ids,
 * so the graph's nodes are keyed by coordinate — the coordinate is the only
 * join key that exists end to end.
 */
final class TurnRestriction
{
    /**
     * Why this relation cannot be used, or null when it can.
     *
     * Returned as a short token rather than thrown, because the import counts
     * the reasons in its coverage report: how many restrictions the network
     * actually offers is a data-quality number, and the reason a relation was
     * skipped is the part that says whether a thin count is thin data or a
     * parsing bug.
     *
     * @param  array<string, mixed>  $element
     * @return string|null 'except_bus' | 'via_way' | 'malformed' | 'not_restriction'
     */
    public static function skipReason(array $element): ?string
    {
        $tags = is_array($element['tags'] ?? null) ? $element['tags'] : [];

        if (($tags['type'] ?? null) !== 'restriction') {
            return 'not_restriction';
        }

        if (self::exemptsBuses($tags['except'] ?? null)) {
            return 'except_bus';
        }

        $via = self::member($element, 'via');

        if ($via === null) {
            return 'malformed';
        }

        if (($via['type'] ?? null) === 'way') {
            return 'via_way';
        }

        return null;
    }

    /**
     * Parse a relation element into a restriction, or null when unusable.
     *
     * Callers are expected to have checked skipReason() first — a null here
     * then means "structurally incomplete", the one skip reason the element
     * itself does not announce.
     *
     * @param  array<string, mixed>  $element
     */
    public static function fromElement(array $element): ?self
    {
        if (self::skipReason($element) !== null) {
            return null;
        }

        $id = $element['id'] ?? null;
        $tags = is_array($element['tags'] ?? null) ? $element['tags'] : [];
        $kind = (string) ($tags['restriction'] ?? '');

        $from = self::member($element, 'from');
        $to = self::member($element, 'to');
        $via = self::member($element, 'via');

        if (
            ! is_int($id)
            || $kind === ''
            || mb_strlen($kind) > 32
            || ! is_array($from)
            || ! is_array($to)
            || ! is_array($via)
        ) {
            return null;
        }

        $fromWay = $from['ref'] ?? null;
        $toWay = $to['ref'] ?? null;
        $viaLat = $via['lat'] ?? null;
        $viaLng = $via['lon'] ?? null;

        if (
            ! is_int($fromWay)
            || ! is_int($toWay)
            || ! is_numeric($viaLat)
            || ! is_numeric($viaLng)
        ) {
            return null;
        }

        return new self(
            $id,
            $kind,
            $fromWay,
            $toWay,
            (float) $viaLat,
            (float) $viaLng,
        );
    }

    private function __construct(
        public readonly int $osmId,
        public readonly string $kind,
        public readonly int $fromOsmWay,
        public readonly int $toOsmWay,
        public readonly float $viaLat,
        public readonly float $viaLng,
    ) {}

    /**
     * Whether the restriction's `except` tag exempts the vehicles this router routes.
     *
     * The tag is a list of vehicle types separated by `;` (and, in the wild,
     * sometimes `,`), matched case-insensitively. `bus` and `psv` name buses
     * outright; `motor_vehicle` and `motorcar` name every car on the road,
     * which includes them.
     */
    private static function exemptsBuses(mixed $except): bool
    {
        if (! is_string($except) || trim($except) === '') {
            return false;
        }

        $exempt = array_map(
            fn (string $value): string => strtolower(trim($value)),
            preg_split('/[;,]/', strtolower($except)) ?: [],
        );

        return count(array_intersect($exempt, [
            'bus',
            'psv',
            'motor_vehicle',
            'motorcar',
        ])) > 0;
    }

    /**
     * The relation member carrying a role, or null.
     *
     * A restriction has one member per role; the first wins if a relation
     * somehow repeats one, which keeps the shape deterministic rather than
     * dependent on member order in a subtler way.
     *
     * @param  array<string, mixed>  $element
     * @return array<string, mixed>|null
     */
    private static function member(array $element, string $role): ?array
    {
        $members = is_array($element['members'] ?? null) ? $element['members'] : [];

        foreach ($members as $member) {
            if (is_array($member) && ($member['role'] ?? null) === $role) {
                return $member;
            }
        }

        return null;
    }
}
