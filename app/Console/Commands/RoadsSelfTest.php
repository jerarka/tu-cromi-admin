<?php

namespace App\Console\Commands;

use App\Http\Controllers\Admin\RoadsController;
use App\Http\Requests\Road\RelayRoadRequest;
use App\Http\Requests\Road\SnapRoadRequest;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Throwable;

/**
 * Exercises the street-snap lookup against a real PostGIS instance.
 *
 * The lookup is the one piece of this feature the test suite cannot reach: the
 * roads table is PostGIS-only, so `php artisan test` on SQLite takes the
 * controller's non-pgsql branch and every spatial query in it is skipped. The
 * existing docblock in SnapRoadTest says the query is verified against real
 * PostgreSQL, and until now that claim had no artifact behind it — the checks
 * were run by hand and thrown away, so the next maintainer inherited an
 * assertion of coverage with no way to reproduce it.
 *
 * This command is that artifact. It builds three short roads in an empty part
 * of the map, asks the real controller the questions that matter, and prints
 * what it found. Everything it writes is rolled back.
 *
 * It runs against the configured connection, which is why it writes at all, so
 * it refuses to touch production without being told to: a test that leaves
 * geometry behind in the real network is worse than no test.
 *
 * @phpstan-type FixtureRoad array{name: string, oneway: string, coords: string}
 * @phpstan-type Fixture array{
 *     anchor: array{lng: float, lat: float, clearBy: float},
 *     alpha: FixtureRoad,
 *     bravo: FixtureRoad,
 *     charlie: FixtureRoad,
 *     delta: FixtureRoad,
 * }
 */
class RoadsSelfTest extends Command
{
    protected $signature = 'roads:self-test
        {--force : Allow running outside development, where this writes to the configured database}';

    protected $description = 'Verify the street snap lookup against a real PostGIS instance, rolling back after';

    /**
     * Reported outcomes, in the order they are checked.
     *
     * @var list<array{0: string, 1: bool, 2: string}>
     */
    private array $results = [];

    public function handle(): int
    {
        if (! $this->allowedHere()) {
            return self::FAILURE;
        }

        if (Schema::getConnection()->getDriverName() !== 'pgsql') {
            $this->error(
                'This check needs PostgreSQL with PostGIS. The configured connection is '
                .Schema::getConnection()->getDriverName()
                .', which cannot answer the spatial query, so passing here would prove nothing.',
            );

            return self::FAILURE;
        }

        $geometry = $this->fixture();

        DB::beginTransaction();

        try {
            $this->insertRoads($geometry);

            $this->checkNearestStreet($geometry);
            $this->checkCrossingTieBreaksOnVotes($geometry);
            $this->checkThresholdGoverns($geometry);
            $this->checkNothingInRangeAnswers204($geometry);
            $this->checkProjectionLiesOnTheStreet($geometry);
            $this->checkOnewayKeepsItsToken($geometry);
            $this->checkStreetGeometryTravelsWithTheSnap($geometry);
            $this->checkStreetGeometryKeepsItsOrder($geometry);
            $this->checkRelayAnswersEachPointOnItsOwnStreet($geometry);
            $this->checkRelayLetsACornerBeTwoStreets($geometry);
            $this->checkRelayVotesBeatDistanceAtACrossing($geometry);
            $this->checkRelayIsIndexedByPosition($geometry);
            $this->checkRelayOmitsPointsWithNoStreet($geometry);
            $this->checkRelayGeometryKeepsItsOrder($geometry);
        } catch (Throwable $e) {
            $this->results[] = ['ran the whole sequence', false, $e->getMessage()];

            DB::rollBack();
            $this->report();

            return self::FAILURE;
        }

        DB::rollBack();

        $this->report();

        return $this->failed() ? self::FAILURE : self::SUCCESS;
    }

    /**
     * Whether this database is one that may be written to.
     *
     * Development and testing are the only environments where a rolled-back
     * transaction into the real network is acceptable. Local is included
     * because that is where this will be run.
     */
    private function allowedHere(): bool
    {
        $environment = app()->environment();

        if ($environment === 'production' && ! $this->option('force')) {
            $this->error(
                'Refusing to run in production: this writes to the configured roads table and relies on '
                .'a rollback. Re-run with --force if that is genuinely what you want.',
            );

            return false;
        }

        if (! in_array($environment, ['local', 'testing', 'development', 'production'], true)) {
            $this->error("Refusing to run in the '{$environment}' environment: not a known one.");

            return false;
        }

        return true;
    }

    /**
     * Three short roads in an empty corner of the map, in metres from an anchor.
     *
     * The anchor is the point furthest from any imported street, found by
     * scanning the data. Sitting the fixture there is what makes the check
     * independent of the network: with thirty thousand real roads in the table,
     * a fixture anywhere near them competes with them for the answer, and a
     * check that only passes when the surrounding data happens to cooperate is
     * not a check.
     *
     * Alpha runs east-west through the anchor. Bravo is a short north-south
     * street three metres east of it, so the two cross and a drop near the
     * crossing is genuinely ambiguous. Delta runs parallel to alpha four metres
     * south of it, which is what makes the local vote testable: two streets a few
     * metres apart, like a road and the lane beside it, are the only arrangement
     * where a point can be closer to one while its neighbours are all on the
     * other. Charlie is far to the north, close enough to prove nothing
     * interferes and far enough never to win.
     *
     * @return Fixture
     */
    private function fixture(): array
    {
        $anchor = $this->isolatedAnchor();

        $east = fn (float $metres): float => $metres / ($this->metresPerDegreeLon($anchor['lat']));
        $north = fn (float $metres): float => $metres / 110574.0;

        $lng = fn (float $metres): string => $this->coord($anchor['lng'] + $east($metres));
        $lat = fn (float $metres): string => $this->coord($anchor['lat'] + $north($metres));

        return [
            'anchor' => $anchor,
            'alpha' => [
                'name' => 'selftest alpha',
                'oneway' => 'no',
                'coords' => sprintf('(%s %s, %s %s)', $lng(-400.0), $lat(0.0), $lng(400.0), $lat(0.0)),
            ],
            'bravo' => [
                'name' => 'selftest bravo',
                'oneway' => 'forward',
                'coords' => sprintf('(%s %s, %s %s)', $lng(3.0), $lat(-30.0), $lng(3.0), $lat(30.0)),
            ],
            'charlie' => [
                'name' => 'selftest charlie',
                'oneway' => 'backward',
                'coords' => sprintf('(%s %s, %s %s)', $lng(-400.0), $lat(300.0), $lng(400.0), $lat(300.0)),
            ],
            'delta' => [
                'name' => 'selftest delta',
                'oneway' => 'no',
                'coords' => sprintf('(%s %s, %s %s)', $lng(-400.0), $lat(-4.0), $lng(400.0), $lat(-4.0)),
            ],
        ];
    }

    /**
     * The point in the data furthest from any imported street.
     *
     * Scanned on a grid rather than answered with a correlated subquery over
     * every road against every other road, which is a billion distance
     * calculations and does not finish. The nearest street is found with the
     * KNN operator, which uses the geography index.
     *
     * @return array{lng: float, lat: float, clearBy: float}
     */
    private function isolatedAnchor(): array
    {
        $extent = DB::selectOne(
            'SELECT ST_XMin(e) AS minx, ST_XMax(e) AS maxx, ST_YMin(e) AS miny, ST_YMax(e) AS maxy
             FROM (SELECT ST_Extent(geom) AS e FROM roads) s',
        );

        $best = ['lng' => 0.0, 'lat' => 0.0, 'clearBy' => -1.0];
        $steps = 14;

        for ($i = 0; $i <= $steps; $i++) {
            for ($j = 0; $j <= $steps; $j++) {
                $lng = $extent->minx + ($extent->maxx - $extent->minx) * $i / $steps;
                $lat = $extent->miny + ($extent->maxy - $extent->miny) * $j / $steps;

                $nearest = DB::selectOne(
                    'SELECT ST_Distance(geom::geography, ST_SetSRID(ST_Point(?, ?), 4326)::geography) AS d
                     FROM roads
                     ORDER BY geom::geography <-> ST_SetSRID(ST_Point(?, ?), 4326)
                     LIMIT 1',
                    [$lng, $lat, $lng, $lat],
                );

                if ($nearest !== null && (float) $nearest->d > $best['clearBy']) {
                    $best = ['lng' => $lng, 'lat' => $lat, 'clearBy' => (float) $nearest->d];
                }
            }
        }

        return $best;
    }

    private function metresPerDegreeLon(float $lat): float
    {
        return 111320 * cos(deg2rad($lat));
    }

    private function coord(float $value): string
    {
        return number_format($value, 8, '.', '');
    }

    /**
     * @param  Fixture  $geometry
     */
    private function insertRoads(array $geometry): void
    {
        $osmId = 990_000_000;

        foreach (['alpha', 'bravo', 'charlie', 'delta'] as $key) {
            DB::insert(
                'INSERT INTO roads (osm_id, name, highway, oneway, point_count, created_at, updated_at, geom)
                 VALUES (?, ?, ?, ?, 2, now(), now(), ST_GeomFromText(?, 4326))',
                [
                    $osmId++,
                    $geometry[$key]['name'],
                    'residential',
                    $geometry[$key]['oneway'],
                    sprintf('MULTILINESTRING(%s)', $geometry[$key]['coords']),
                ],
            );
        }
    }

    /**
     * The whole selection is sampled, but the reference is the answer.
     *
     * A point sitting on alpha and two hundred metres from bravo must come back
     * as alpha. This is the case the veto of agreement used to break: the other
     * sampled points vote for other streets, and if those votes could refuse the
     * snap, dragging a route would do nothing.
     *
     * @param  Fixture  $geometry
     */
    private function checkNearestStreet(array $geometry): void
    {
        $response = $this->snap([
            $this->offset($geometry, 200.0, 0.0),
        ], threshold: 25.0, radius: 60.0);

        $this->assertSame(
            'a drop on a street is answered with that street',
            $geometry['alpha']['name'],
            $response['name'] ?? '(no street)',
            $response,
        );
    }

    /**
     * At a crossing, the street the rest of the drop recognises wins.
     *
     * Bravo runs three metres east of the anchor, so the reference is placed one
     * metre east and just under four north: two metres from bravo and four from
     * alpha. Distance alone would answer bravo, and both are inside the tie
     * band, so the vote is what has to decide. The remaining sampled points sit
     * on alpha.
     *
     * The margins are deliberately uneven — two against four, inside a three
     * metre band — because a fixture with the reference equidistant from both
     * would pass whether or not the votes were ever read.
     *
     * @param  Fixture  $geometry
     */
    private function checkCrossingTieBreaksOnVotes(array $geometry): void
    {
        $response = $this->snap([
            $this->offset($geometry, 1.0, 3.9),
            $this->offset($geometry, 50.0, 0.0),
            $this->offset($geometry, 120.0, 0.0),
            $this->offset($geometry, 200.0, 0.0),
        ], threshold: 25.0, radius: 60.0);

        $this->assertSame(
            'a crossing is resolved by the moved vertices, not by the closest road',
            $geometry['alpha']['name'],
            $response['name'] ?? '(no street)',
            $response,
        );

        $this->assert(
            'the crossing winner is the one the drop was pointed at, not the nearest',
            ($response['distance_m'] ?? 0) > 3.0,
            sprintf('answered with a street %.1fm away', $response['distance_m'] ?? -1),
        );
    }

    /**
     * The threshold is the reviewer's setting, and it holds.
     *
     * A point forty metres off the nearest street is refused by the normal
     * threshold and accepted by the aggressive one. If votes could widen this,
     * a stretch dragged across a block would be pulled onto a road the reviewer
     * never aimed at.
     *
     * @param  Fixture  $geometry
     */
    private function checkThresholdGoverns(array $geometry): void
    {
        $point = [$this->offset($geometry, 200.0, 40.0)];

        $refused = $this->status($this->snap($point, threshold: 25.0, radius: 60.0));

        $this->assertSame(
            'a street past the threshold is refused',
            204,
            $refused,
        );

        $accepted = $this->snap($point, threshold: 50.0, radius: 60.0);

        $this->assertSame(
            'the same street is accepted by a wider threshold',
            $geometry['alpha']['name'],
            $accepted['name'] ?? '(no street)',
            $accepted,
        );
    }

    /**
     * No street in range is an answer, not an error.
     *
     * Overpass coverage has real gaps, so the client has to be able to tell
     * "nothing close enough" from "the lookup broke" and neither may look like
     * an empty success.
     *
     * @param  Fixture  $geometry
     */
    private function checkNothingInRangeAnswers204(array $geometry): void
    {
        $response = $this->snap([
            $this->offset($geometry, 0.0, 1000.0),
        ], threshold: 25.0, radius: 60.0);

        $this->assertSame(
            'a drop with no street in range is answered 204',
            204,
            $this->status($response),
        );
    }

    /**
     * The returned position is on the street, not where the drop was released.
     *
     * The caller moves the reference point here and carries the rest of the
     * selection with it, so a projection that came back anywhere else would put
     * the route somewhere the reviewer never dropped it.
     *
     * @param  Fixture  $geometry
     */
    private function checkProjectionLiesOnTheStreet(array $geometry): void
    {
        $drop = $this->offset($geometry, 200.0, 0.0);
        $response = $this->snap([$drop], threshold: 25.0, radius: 60.0);

        $this->assert(
            'the projection lands on the centreline rather than where it was released',
            isset($response['lat'], $response['lng'])
                && abs($response['lat'] - $drop['lat']) < 0.000001
                && abs($response['lng'] - $drop['lng']) < 0.000001,
            sprintf('dropped at %.6f,%.6f and answered %.6f,%.6f',
                $drop['lat'], $drop['lng'], $response['lat'] ?? 0, $response['lng'] ?? 0),
        );
    }

    /**
     * Direction survives the trip out.
     *
     * The column holds OSM tokens, not a boolean, and a two-way street is the
     * string 'no' — which is truthy in PHP. A cast to bool therefore reports
     * every road in the network as one-way, and folds 'forward' and 'backward'
     * together, which on a domain built around outbound and return is the one
     * distinction the field exists to carry.
     *
     * @param  Fixture  $geometry
     */
    private function checkOnewayKeepsItsToken(array $geometry): void
    {
        foreach (['alpha' => 'no', 'bravo' => 'forward', 'charlie' => 'backward', 'delta' => 'no'] as $key => $expected) {
            $response = $this->snap([
                $this->offsetOn($geometry, $key),
            ], threshold: 25.0, radius: 60.0);

            $this->assertSame(
                sprintf('the oneway token of %s survives the lookup', $key),
                $expected,
                $response['oneway'] ?? '(missing)',
                $response,
            );
        }
    }

    /**
     * The chosen street's own coordinates travel with the answer.
     *
     * The editor walks the route's neighbouring vertices onto this line, and it
     * can only do that if the line arrives. So this is a check on the response
     * shape rather than on the geometry: the client accepts a MultiLineString
     * and nothing else, and a response carrying anything else is one it will
     * read as "no street", which is a refinement lost with nothing on screen to
     * say why.
     *
     * The size is why this costs nothing. A way in this table averages six
     * points, so the street rides along with the snap instead of costing a round
     * trip of its own.
     *
     * @param  Fixture  $geometry
     */
    private function checkStreetGeometryTravelsWithTheSnap(array $geometry): void
    {
        $response = $this->snap([
            $this->offset($geometry, 200.0, 0.0),
        ], threshold: 25.0, radius: 60.0);

        $this->assertSame(
            'the snap carries the street it chose',
            'MultiLineString',
            $response['geometry']['type'] ?? '(missing)',
            $response,
        );

        $this->assertSame(
            'the street arrives as one drawable part of at least two positions',
            1,
            is_array($coordinates = $response['geometry']['coordinates'] ?? null)
                && is_array($coordinates[0] ?? null)
                && count($coordinates[0]) >= 2
                && count($coordinates) === 1
                    ? 1
                    : 0,
            $response,
        );
    }

    /**
     * GeoJSON order, asserted rather than assumed.
     *
     * The street has to come back as [lng, lat] to match the editor's own
     * convention, and there is no way to tell from the response alone that it
     * did: both orders are arrays of two numbers, and the transposed one is
     * still perfectly valid GeoJSON. The snapped position beside it is
     * separately and correctly ordered, so a transposed street would read as a
     * good snap sitting next to a mirrored continuation of the route, and
     * nothing downstream would object.
     *
     * The fixture makes the two orders distinguishable. Alpha runs east-west
     * through the anchor, so its west end is 400 m *west* of a longitude near
     * -63 and level with a latitude near -25. Read in the wrong order those two
     * numbers trade places, and the comparison below fails.
     *
     * @param  Fixture  $geometry
     */
    private function checkStreetGeometryKeepsItsOrder(array $geometry): void
    {
        $response = $this->snap([
            $this->offset($geometry, 200.0, 0.0),
        ], threshold: 25.0, radius: 60.0);

        $west = $response['geometry']['coordinates'][0][0] ?? null;
        $east = $response['geometry']['coordinates'][0][1] ?? null;

        $this->assert(
            'the street reads as [lng, lat], the order the editor speaks',
            is_array($west)
            && is_array($east)
            && $this->is($west[1] ?? null, $geometry['anchor']['lat'])
            && $this->is($east[1] ?? null, $geometry['anchor']['lat'])
            && $this->is($west[0] ?? null, $this->westEnd($geometry)),
            sprintf(
                'answered %s to %s for a street running west to east at latitude %.6f',
                $this->show($west),
                $this->show($east),
                $geometry['anchor']['lat'],
            ),
        );
    }

    /**
     * The longitude of alpha's west end, in the same rounded form the fixture
     * was inserted with.
     *
     * @param  Fixture  $geometry
     */
    private function westEnd(array $geometry): float
    {
        return (float) number_format(
            $geometry['anchor']['lng'] - 400.0 / $this->metresPerDegreeLon($geometry['anchor']['lat']),
            8,
            '.',
            '',
        );
    }

    /**
     * Whether a coordinate is the expected one.
     *
     * The fixture is inserted rounded to eight decimals, so the comparison has
     * to allow for that much and no more — tight enough that a transposed pair
     * could not pass, loose enough that the rounding is not itself a failure.
     */
    private function is(mixed $actual, float $expected): bool
    {
        return is_float($actual) || is_int($actual)
            ? abs($actual - $expected) < 0.0000001
            : false;
    }

    /**
     * Ask the real controller which street each point belongs to.
     *
     * The same contract as the snap helper — through the controller and the form
     * request, because the binding order and the row shape are what is really
     * under test here and a fixture that went straight to the query would pass
     * while the editor's actual call failed.
     *
     * @param  list<array{lat: float, lng: float}>  $points
     * @return list<array<string, mixed>>
     */
    private function relay(array $points, float $threshold = 25.0, float $radius = 60.0): array
    {
        $request = RelayRoadRequest::create('/roads/relay', 'POST', [
            'points' => $points,
            'threshold' => $threshold,
            'radius' => $radius,
        ]);
        $request->setContainer(app());
        $request->setRedirector(app('redirect'));
        $request->validateResolved();

        $response = app(RoadsController::class)->relay($request);
        $content = $response->getContent();
        $decoded = json_decode($content === false ? '' : $content, true);

        // array_values on something json_decode already gave back as a list, and
        // it is here on purpose rather than as decoration: the reply's order is
        // the contract the client re-lays a route against, so asserting it is a
        // list here is the same claim the test below makes about it.
        return is_array($decoded) ? array_values($decoded) : [];
    }

    /**
     * A straight run along one street is answered with that street, point by point.
     *
     * The shape of the whole feature in one assertion: unlike a drop, there is no
     * single winner, because every point is its own reference. A response that
     * named one street for the lot would be the rigid behaviour this exists to
     * replace.
     *
     * @param  Fixture  $geometry
     */
    private function checkRelayAnswersEachPointOnItsOwnStreet(array $geometry): void
    {
        $points = [
            $this->offset($geometry, -150.0, 0.0),
            $this->offset($geometry, -50.0, 0.0),
            $this->offset($geometry, 50.0, 0.0),
            $this->offset($geometry, 150.0, 0.0),
        ];

        $rows = $this->relay($points);

        $this->assertSame(
            'a straight run is answered with one row per point',
            count($points),
            count($rows),
        );

        $this->assert(
            'every point of a run along one street is answered with that street',
            array_reduce(
                $rows,
                fn (bool $all, array $row): bool => $all && $row['name'] === $geometry['alpha']['name'],
                true,
            ),
            $this->show(array_column($rows, 'name')),
        );
    }

    /**
     * A selection that turns a corner is answered with two streets.
     *
     * The case a per-drop lookup cannot express at all. The points along alpha
     * belong to alpha and the ones up bravo belong to bravo, and neither is wrong
     * — a rule insisting on one street for the whole selection would have to be
     * wrong about one of them, which is why this answers per point.
     *
     * @param  Fixture  $geometry
     */
    private function checkRelayLetsACornerBeTwoStreets(array $geometry): void
    {
        $rows = $this->relay([
            $this->offset($geometry, -150.0, 0.0),
            $this->offset($geometry, -100.0, 0.0),
            $this->offsetOn($geometry, 'bravo'),
            $this->offset($geometry, 3.0, 10.0),
            $this->offset($geometry, 3.0, 20.0),
        ]);

        $names = array_column($rows, 'name');

        $this->assertSame(
            'the points along alpha are answered with alpha',
            2,
            count(array_keys($names, $geometry['alpha']['name'], true)),
        );

        $this->assert(
            'the points up bravo are answered with bravo, and the corner is not smoothed into one street',
            count(array_keys($names, $geometry['bravo']['name'], true)) === 3,
            $this->show($names),
        );
    }

    /**
     * Where two streets run close alongside each other, the neighbours decide —
     * not the closer one.
     *
     * Alpha and delta run parallel four metres apart, and the point in question
     * sits three metres south of alpha: one metre from delta, three from alpha. So
     * delta is the closer street by a factor of three, and every neighbour of the
     * point is on alpha. Both are inside the three-metre tie band, so the distance
     * cannot separate them and the vote has to. Alpha must win.
     *
     * This is the assertion that fails if the votes were counted across the whole
     * selection instead of locally. A global count over a route with two long
     * stretches on parallel roads ties exactly, and a tie broken by distance is a
     * coin flip at every crossing — which is to say exactly where the route turns.
     *
     * It is also the shape of the real problem: a divided road, or a street and
     * the service lane beside it, are two rows a few metres apart and a route
     * between them must not be split down the middle.
     *
     * @param  Fixture  $geometry
     */
    private function checkRelayVotesBeatDistanceAtACrossing(array $geometry): void
    {
        $rows = $this->relay([
            $this->offset($geometry, -160.0, 0.0),
            $this->offset($geometry, -130.0, 0.0),
            $this->offset($geometry, -100.0, -3.0),
            $this->offset($geometry, -70.0, 0.0),
            $this->offset($geometry, -60.0, 0.0),
        ]);

        $middle = $rows[2] ?? [];

        $this->assertSame(
            'a point between two streets is answered by the one its neighbours are on',
            $geometry['alpha']['name'],
            $middle['name'] ?? '(no street)',
        );

        $this->assert(
            'and the answer really was the further of the two, so the vote is what decided it',
            (float) ($middle['distance_m'] ?? 0) > 2.0,
            sprintf(
                'answered with %s at %.2fm, delta was at 1.00m',
                (string) ($middle['name'] ?? '(none)'),
                (float) ($middle['distance_m'] ?? -1),
            ),
        );
    }

    /**
     * The reply is indexed by the position the points were sent in.
     *
     * The client re-lays the route in that order and matches each answer back to
     * a vertex by position, so a renumbered or reordered reply would apply every
     * street to somebody else's vertex. A box gesture has no order of its own, so
     * this is the only thing making the reply mean anything.
     *
     * @param  Fixture  $geometry
     */
    private function checkRelayIsIndexedByPosition(array $geometry): void
    {
        // Sent nearest-first, so the natural answer order is the reverse of the
        // sent order and any reliance on the server sorting would show up.
        $rows = $this->relay([
            $this->offset($geometry, 150.0, 0.0),
            $this->offset($geometry, 50.0, 0.0),
            $this->offset($geometry, -50.0, 0.0),
        ]);

        $this->assertSame(
            'the reply keeps the order the points were sent in',
            [0, 1, 2],
            array_map(fn (array $row): int => (int) $row['index'], $rows),
        );
    }

    /**
     * A point with no street in range gets no row, rather than a wrong one.
     *
     * Thirty-six vertices across nine codes are genuinely in this position — the
     * imported network does not reach them — so it is a real case. The absence is
     * what tells the client to leave that vertex alone, and a row with a street
     * beyond the threshold would be a route moved to a road the reviewer never
     * pointed at.
     *
     * @param  Fixture  $geometry
     */
    private function checkRelayOmitsPointsWithNoStreet(array $geometry): void
    {
        $rows = $this->relay([
            $this->offset($geometry, -100.0, 0.0),
            // A kilometre north of everything, where only charlie is in play and
            // it is 700 m away — well past the threshold.
            $this->offset($geometry, 0.0, 1000.0),
        ]);

        $this->assertSame(
            'a point with no street within range is left out of the reply',
            [0],
            array_map(fn (array $row): int => (int) $row['index'], $rows),
        );
    }

    /**
     * Every street comes back as [lng, lat], in the editor's own order.
     *
     * Stated for the re-lay as well as the drop because a re-lay has no correct
     * position sitting beside it to notice a mirrored one: the snapped vertex is
     * not in this reply at all, so a transposed centreline would put a hundred
     * vertices on the far side of the world and nothing anywhere would object.
     *
     * Alpha runs east-west through the anchor, so read in the wrong order its
     * coordinates trade a longitude near -63 for a latitude near -25, and the
     * comparison below fails.
     *
     * @param  Fixture  $geometry
     */
    private function checkRelayGeometryKeepsItsOrder(array $geometry): void
    {
        // Two points, because a re-lay of one vertex is a snap and the request
        // refuses it — the feature has nothing to add until there is a stretch.
        $rows = $this->relay([
            $this->offset($geometry, -50.0, 0.0),
            $this->offset($geometry, 0.0, 0.0),
        ]);
        $west = $rows[1]['geometry']['coordinates'][0][0] ?? null;
        $east = $rows[1]['geometry']['coordinates'][0][1] ?? null;

        $this->assert(
            'the re-laid street reads as [lng, lat] too',
            is_array($west)
            && is_array($east)
            && $this->is($west[1] ?? null, $geometry['anchor']['lat'])
            && $this->is($east[1] ?? null, $geometry['anchor']['lat'])
            && $this->is($west[0] ?? null, $this->westEnd($geometry)),
            sprintf(
                'answered %s to %s for a street running west to east at latitude %.6f',
                $this->show($west),
                $this->show($east),
                $geometry['anchor']['lat'],
            ),
        );
    }

    /**
     * A point a given distance from the anchor.
     *
     * @param  Fixture  $geometry
     * @return array{lat: float, lng: float}
     */
    private function offset(array $geometry, float $east, float $north): array
    {
        $lat = $geometry['anchor']['lat'] + $north / 110574.0;

        return [
            'lat' => $lat,
            'lng' => $geometry['anchor']['lng'] + $east / $this->metresPerDegreeLon($lat),
        ];
    }

    /**
     * A point that sits on one of the fixture streets.
     *
     * @param  Fixture  $geometry
     * @return array{lat: float, lng: float}
     */
    private function offsetOn(array $geometry, string $key): array
    {
        return match ($key) {
            'alpha' => $this->offset($geometry, 200.0, 0.0),
            'bravo' => $this->offset($geometry, 3.0, 0.0),
            'delta' => $this->offset($geometry, 200.0, -4.0),
            default => $this->offset($geometry, 200.0, 300.0),
        };
    }

    /**
     * Ask the real controller, the way the editor does.
     *
     * Going through the controller and the form request rather than the query
     * directly is the point: the binding order this check is really about lives
     * in the controller, and a fixture that bypassed it would pass while the
     * editor's actual call failed.
     *
     * @param  list<array{lat: float, lng: float}>  $points
     * @return array<string, mixed>
     */
    private function snap(array $points, float $threshold, float $radius): array
    {
        $request = SnapRoadRequest::create('/roads/snap', 'POST', [
            'points' => $points,
            'threshold' => $threshold,
            'radius' => $radius,
        ]);
        $request->setContainer(app());
        $request->setRedirector(app('redirect'));
        $request->validateResolved();

        $response = app(RoadsController::class)->snap($request);

        $content = $response->getContent();

        $decoded = json_decode($content === false ? '' : $content, true);

        return ['status' => $response->getStatusCode(), 'body' => $decoded]
            + (is_array($decoded) ? $decoded : []);
    }

    /**
     * The HTTP status, which is the whole answer when there is no body.
     *
     * @param  array<string, mixed>  $response
     */
    private function status(array $response): int
    {
        return (int) $response['status'];
    }

    /**
     * @param  array<string, mixed>  $response
     */
    private function assertSame(string $claim, mixed $expected, mixed $actual, array $response = []): void
    {
        $this->assert(
            $claim,
            $expected === $actual,
            sprintf(
                'expected %s, got %s%s',
                $this->show($expected),
                $this->show($actual),
                isset($response['status']) ? sprintf(' (HTTP %d)', $response['status']) : '',
            ),
        );
    }

    private function show(mixed $value): string
    {
        if ($value === null || is_scalar($value)) {
            return var_export($value, true);
        }

        return json_encode($value) ?: 'unprintable';
    }

    private function assert(string $claim, bool $holds, string $detail = ''): void
    {
        $this->results[] = [$claim, $holds, $detail];
    }

    private function failed(): bool
    {
        foreach ($this->results as [, $holds]) {
            if (! $holds) {
                return true;
            }
        }

        return $this->results === [];
    }

    private function report(): void
    {
        $this->newLine();
        $this->line('roads:snap against real PostGIS — everything below was rolled back');

        foreach ($this->results as [$claim, $holds, $detail]) {
            $this->line(sprintf(
                '  %s %s%s',
                $holds ? '<fg=green>PASS</>' : '<fg=red>FAIL</>',
                $claim,
                $holds || $detail === '' ? '' : "  ({$detail})",
            ));
        }

        $failed = $this->failed();
        $this->newLine();
        $this->line($failed
            ? '<fg=red>One or more checks did not hold.</>'
            : '<fg=green>All checks held.</>');
    }
}
