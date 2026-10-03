<?php

namespace App\Geo;

use App\Models\Line;

/**
 * Great-circle distance over a fixed sphere, and the cumulative walk along a
 * route.
 *
 * This class is the single owner of the distance model used by the offline
 * bundle. Both published distances in it come from here — the ride lengths in
 * `cumulative_distance` and the transfer legs in `walk_distance` — so they are
 * on one scale by construction, not by two copies of a formula agreeing.
 *
 * Why they have to agree: the app scores a transfer option as roughly
 * ride + walk, and the two are read from the same row set. Measured over the
 * real data, a spherical mean radius and PostGIS' spheroid geodesic disagree
 * by +0,38% on north-south legs and −0,05% on east-west ones — roughly 33 m of
 * phantom distance on a 25 km ride, against a median walk of 46 m. That is
 * larger than the walk term itself, so it reorders genuinely close options.
 *
 * The arithmetic below is a wire contract, not an implementation detail:
 *
 *   - EARTH_RADIUS_M is 6371000, not the WGS84 semi-major axis 6378137. The
 *     app already uses the mean radius; the WGS84 value would inflate a
 *     13.2 km route by 14.79 m (+0.112%), which is enough to flip ties
 *     between rows of the same transfer.
 *   - Accumulation is sequential and left to right, from the first vertex to
 *     the last. Never summed in parallel and never reordered.
 *   - The operand order is the one written below. Reassociating a sum of
 *     floats moves the last bit, and the last bit is the whole tolerance
 *     budget.
 *
 * Bit-for-bit parity with Dart is not the goal and not achievable: PHP and
 * Dart both use IEEE-754 binary64 and the formulas are equivalent, so the
 * real divergence is 1-2 ULP, well under a nanometre. The same constant and
 * the same order are what matter.
 *
 * @phpstan-import-type GeoJson from Line
 */
final class GreatCircle
{
    /**
     * Mean Earth radius in metres, matching the value used by the app.
     *
     * Public so a test can pin it: this number looks like a mistake to anyone
     * who knows the WGS84 axis, and it is the one value in the pipeline that
     * must never be "corrected".
     */
    public const EARTH_RADIUS_M = 6371000.0;

    /**
     * Decimal places a published walk distance carries.
     *
     * Ten centimetres is two orders of magnitude finer than the ~0,3 m bias
     * this class exists to remove, and the value is a straight-line lower
     * bound on a walk whose median is 46 m — it is not physically meaningful
     * below a metre. Full float64 would multiply the bundle by 1,35M
     * high-entropy mantissa digits for no accuracy anyone can use, and one
     * decimal still leaves the transfer legs comparable to the ride lengths
     * they are added to.
     */
    private const WALK_DECIMALS = 1;

    /**
     * Cumulative distances for a GeoJSON MultiLineString, flattened.
     *
     * A MultiLineString is traversed segment by segment in order, so the
     * distances run straight through a segment boundary rather than restarting
     * at each one. Today's 272 lines all hold a single segment, but the app
     * flattens and accumulates across segments, and the two have to agree.
     *
     * The returned array is parallel to the flattened positions and shares
     * their indices, which is exactly the numbering the app gives its
     * sequence_index column. A transfer point stored as index 7 can therefore
     * be resolved as cumulative_distance[7] minus cumulative_distance[3]
     * without touching the coordinates again.
     *
     * @param  GeoJson|null  $geoJson
     * @return list<float>
     */
    public static function forGeometry(?array $geoJson): array
    {
        if ($geoJson === null) {
            return [];
        }

        /** @var list<array<int, float>> $flat */
        $flat = [];

        foreach ($geoJson['coordinates'] as $segment) {
            foreach ($segment as $position) {
                $flat[] = $position;
            }
        }

        return self::cumulative($flat);
    }

    /**
     * Accumulate the distance between consecutive points.
     *
     * The result starts at exactly 0.0 because that is the origin of the
     * accumulation, and ends at the length of the whole polyline. Values are
     * never rounded: the consumer subtracts cum[b] - cum[a], so rounding to
     * even two decimals would inject up to 5 cm of error into every ride it
     * measures.
     *
     * @param  list<array<int, float>>  $flatPoints  Positions as [lng, lat], in travel order
     * @return list<float>
     */
    public static function cumulative(array $flatPoints): array
    {
        $cum = [0.0];

        for ($i = 1, $count = count($flatPoints); $i < $count; $i++) {
            $cum[] = $cum[$i - 1] + self::metersBetween($flatPoints[$i - 1], $flatPoints[$i]);
        }

        return $cum;
    }

    /**
     * A published transfer distance: one leg, rounded to the bundle's precision.
     *
     * Rounding lives here rather than in TransfersCompute so that it is
     * reachable by the test suite. Everything in that command's data path is
     * PostGIS and therefore untestable on the SQLite test database, so a
     * precision decision made there would ship with no coverage at all.
     *
     * @param  array<int, float>  $a
     * @param  array<int, float>  $b
     */
    public static function walkMeters(array $a, array $b): float
    {
        return round(self::metersBetween($a, $b), self::WALK_DECIMALS);
    }

    /**
     * Great-circle distance in metres between two [lng, lat] positions.
     *
     * Spelled out instead of delegating to deg2rad() so the multiply-then-
     * divide order the app uses stays visible: `$deg * M_PI / 180.0`.
     *
     * @param  array<int, float>  $a
     * @param  array<int, float>  $b
     */
    public static function metersBetween(array $a, array $b): float
    {
        $dLat = self::toRad($b[1] - $a[1]);
        $dLng = self::toRad($b[0] - $a[0]);
        $lat1 = self::toRad($a[1]);
        $lat2 = self::toRad($b[1]);
        $sinDLat2 = sin($dLat / 2);
        $sinDLng2 = sin($dLng / 2);
        $aa = $sinDLat2 * $sinDLat2 + cos($lat1) * cos($lat2) * $sinDLng2 * $sinDLng2;
        $c = 2 * atan2(sqrt($aa), sqrt(1 - $aa));

        return self::EARTH_RADIUS_M * $c;
    }

    private static function toRad(float $deg): float
    {
        return $deg * M_PI / 180.0;
    }
}
