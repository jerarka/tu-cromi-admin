<?php

namespace Tests\Unit;

use App\Geo\GreatCircle;
use Tests\TestCase;

/**
 * The distances in the offline bundle are a wire contract: the app re-measures
 * the same rides in Dart and compares, and picks transfer options by the
 * result. A drift of a few metres does not crash anything — it just ranks the
 * wrong option first — which is exactly why these tests are pinned to a real
 * exported route instead of to hand-picked numbers.
 *
 * The vector is line id 230, code "105 verde", sense OUTBOUND, taken verbatim
 * from the bundle the app consumes.
 *
 * Not covered here: the PostGIS query in TransfersCompute that finds the
 * candidate vertex pairs. Everything in that command's data path needs
 * PostgreSQL and PostGIS, so it cannot run on the SQLite test database. What
 * it delegates outward — the distance itself, and the precision it is
 * published at — lives on GreatCircle and is pinned here, which is why the
 * rounding was moved out of the command to be reachable at all.
 */
class GreatCircleTest extends TestCase
{
    private const DELTA = 1e-6;

    /**
     * The 19 vertices of line 230, exactly as they appear in the bundle.
     *
     * @return list<array{0: float, 1: float}>
     */
    private static function route105Points(): array
    {
        return [
            [-63.0552587326916, -17.8429626188005],
            [-63.0589724255409, -17.8387443569103],
            [-63.0785144249511, -17.8301941507457],
            [-63.1144618019879, -17.8163473862732],
            [-63.1390344306766, -17.8286731038785],
            [-63.1478002442692, -17.8195621268096],
            [-63.1489680716429, -17.8184809647604],
            [-63.1499538727786, -17.8179779927435],
            [-63.1508649370356, -17.8176783520792],
            [-63.1513643077542, -17.8177018808698],
            [-63.1517210930637, -17.8180181948853],
            [-63.1520143995535, -17.8183151992451],
            [-63.1524137793852, -17.818195312405],
            [-63.1524731397271, -17.8181649834817],
            [-63.1594608772332, -17.8107437491848],
            [-63.1595976036995, -17.8105032456900],
            [-63.1600667780381, -17.8102828427869],
            [-63.1605660982662, -17.8102728676999],
            [-63.1610354768371, -17.8102820474922],
        ];
    }

    /**
     * @return list<float>
     */
    private static function route105Expected(): array
    {
        return [
            0.000000, 611.983440, 2888.560631, 6993.572822, 9933.775745,
            11307.606639, 11480.049139, 11598.449023, 11700.488497, 11753.417311,
            11805.027986, 11850.357488, 11894.688145, 11901.819858, 13010.054670,
            13040.463399, 13095.850103, 13148.722704, 13198.424352,
        ];
    }

    /**
     * @param  list<array{0: float, 1: float}>  $points
     */
    private static function geometry(array $points): array
    {
        return [
            'type' => 'MultiLineString',
            'coordinates' => [$points],
        ];
    }

    public function test_it_matches_the_conformity_vector_of_line_230()
    {
        $cum = GreatCircle::forGeometry(self::geometry(self::route105Points()));

        $this->assertCount(19, $cum);

        foreach (self::route105Expected() as $i => $expected) {
            $this->assertEqualsWithDelta($expected, $cum[$i], self::DELTA, "vertex {$i}");
        }
    }

    public function test_the_accumulation_starts_at_exactly_zero()
    {
        $cum = GreatCircle::forGeometry(self::geometry(self::route105Points()));

        $this->assertSame(0.0, $cum[0]);
    }

    public function test_it_uses_the_mean_earth_radius_and_not_the_wgs84_axis()
    {
        $cum = GreatCircle::cumulative(self::route105Points());
        $total = $cum[count($cum) - 1];

        $this->assertEqualsWithDelta(13198.424352, $total, self::DELTA);

        // The discriminant: 6378137 gives 13213.209653 for this very route, so
        // the delta above already rejects it. This assertion exists to name the
        // number, because a radius swap is the one "improvement" that looks
        // like a correction and silently reorders transfer rankings.
        $this->assertGreaterThan(14.0, 13213.209653 - $total);
        $this->assertSame(6371000.0, GreatCircle::EARTH_RADIUS_M);
    }

    public function test_the_accumulation_is_strictly_non_decreasing()
    {
        $cum = GreatCircle::forGeometry(self::geometry(self::route105Points()));

        for ($i = 1, $count = count($cum); $i < $count; $i++) {
            $this->assertGreaterThanOrEqual(
                $cum[$i - 1],
                $cum[$i],
                "vertex {$i} went backwards",
            );
        }

        $this->assertGreaterThan(0.0, $cum[count($cum) - 1]);
    }

    public function test_it_accumulates_across_segment_boundaries()
    {
        [$a, $b, $c, $d] = self::route105Points();

        $twoSegments = [
            'type' => 'MultiLineString',
            'coordinates' => [
                [$a, $b],
                [$c, $d],
            ],
        ];

        $cum = GreatCircle::forGeometry($twoSegments);

        $this->assertCount(4, $cum);
        $this->assertSame(0.0, $cum[0]);

        // A MultiLineString is travelled segment by segment in order, so the
        // third vertex carries on from the second. Restarting the accumulation
        // at each segment would report the A→B leg twice over instead.
        $flat = GreatCircle::forGeometry(self::geometry([$a, $b, $c, $d]));
        $this->assertEqualsWithDelta($flat[2], $cum[2], self::DELTA);
        $this->assertGreaterThan($cum[1], $cum[2]);
    }

    public function test_a_geometry_with_a_single_vertex_yields_a_single_zero()
    {
        $cum = GreatCircle::forGeometry(self::geometry([[-63.05, -17.84]]));

        $this->assertSame([0.0], $cum);
    }

    public function test_a_missing_geometry_yields_an_empty_array()
    {
        $this->assertSame([], GreatCircle::forGeometry(null));
    }

    public function test_the_values_survive_a_json_round_trip_bit_for_bit()
    {
        $cum = GreatCircle::forGeometry(self::geometry(self::route105Points()));

        $json = json_encode(
            ['cumulative_distance' => $cum],
            JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION,
        );

        $this->assertIsString($json);
        $this->assertStringStartsWith('{"cumulative_distance":[0.0,', $json);
        $this->assertStringContainsString('611.983440', $json);
        $this->assertSame($cum, json_decode($json, true)['cumulative_distance']);
    }

    public function test_a_walk_and_a_ride_are_measured_on_the_same_scale()
    {
        $points = self::route105Points();
        $cum = GreatCircle::cumulative($points);

        // The property the whole walk-distance change buys: a transfer leg
        // between two vertices of a line and the ride across those same two
        // vertices are the same measurement. The app adds walk_distance to a
        // cumulative_distance difference to score an option, so if these two
        // ever disagreed by even a third of a percent the ranking would bend
        // towards one kind of option for reasons that have nothing to do with
        // the journey.
        for ($i = 1, $count = count($points); $i < $count; $i++) {
            $this->assertEqualsWithDelta(
                $cum[$i] - $cum[$i - 1],
                GreatCircle::metersBetween($points[$i - 1], $points[$i]),
                self::DELTA,
                "leg {$i} - 1 → {$i}",
            );
        }
    }

    public function test_a_published_walk_distance_carries_exactly_one_decimal()
    {
        // The first hop of line 230: 611.9834402331257 unrounded.
        $walk = GreatCircle::walkMeters(
            [-63.0552587326916, -17.8429626188005],
            [-63.0589724255409, -17.8387443569103],
        );

        $this->assertSame(612.0, $walk);
        $this->assertSame($walk, round($walk, 1));
        $this->assertLessThanOrEqual(0.05, abs(GreatCircle::metersBetween(
            [-63.0552587326916, -17.8429626188005],
            [-63.0589724255409, -17.8387443569103],
        ) - $walk));
    }

    public function test_walk_distances_round_toward_the_nearest_decimetre()
    {
        // Guards the rounding against a silent switch to truncation, which
        // would bias every published walk 5 cm short.
        foreach (self::route105Points() as $i => $point) {
            if ($i === 0) {
                continue;
            }

            $previous = self::route105Points()[$i - 1];
            $exact = GreatCircle::metersBetween($previous, $point);
            $walk = GreatCircle::walkMeters($previous, $point);

            $this->assertLessThanOrEqual(0.05, abs($exact - $walk));
            $this->assertSame(round($exact, 1), $walk);
        }
    }

    /**
     * The degree-to-metre vocabulary, one owner.
     *
     * These two numbers were literals in three files before this, and one of the
     * copies of the longitude one had no clamp while another did. A test that
     * pins the pole is therefore pinning the difference, not the arithmetic: at
     * the latitude this project's data lives at, the clamp never fires and the
     * value is the plain cosine.
     */
    public function test_the_degree_scales_are_the_one_place_that_knows_them(): void
    {
        $this->assertSame(110574.0, GreatCircle::METRES_PER_DEGREE_LATITUDE);

        // Santa Cruz de la Sierra, where every route in the app lives: the
        // longitude degree is about half the equator's, and the clamp is nowhere
        // near firing.
        $this->assertEqualsWithDelta(
            111320.0 * cos(deg2rad(-63.18)),
            GreatCircle::metresPerDegreeLongitude(-63.18),
            0.001,
        );

        // At the equator there is no correction at all.
        $this->assertEqualsWithDelta(
            111320.0,
            GreatCircle::metresPerDegreeLongitude(0.0),
            0.001,
        );
    }

    public function test_the_longitude_scale_never_reaches_zero(): void
    {
        // cos(90°) is zero, and a zero here is a division by zero somewhere
        // downstream that nobody would trace back to here. The floor is 1% of
        // the equatorial value.
        $this->assertGreaterThan(0.0, GreatCircle::metresPerDegreeLongitude(90.0));
        $this->assertEqualsWithDelta(
            1113.2,
            GreatCircle::metresPerDegreeLongitude(90.0),
            0.001,
        );
    }
}
