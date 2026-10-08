<?php

namespace Tests\Unit\Osm;

use App\Osm\TurnRestriction;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * The turn restrictions are what keeps the router from turning where the
 * street network does not allow it, so a parsing mistake here is not a wrong
 * count — it is an illegal turn becoming legal. The cases below pin the two
 * domain skips (buses exempted, via-way) as well as the structural ones.
 */
class TurnRestrictionTest extends TestCase
{
    /**
     * A well-formed `out geom` relation: roles on the members, the via as a
     * node carrying its coordinate.
     *
     * @return array<string, mixed>
     */
    private static function relation(array $overrides = []): array
    {
        return array_merge([
            'type' => 'relation',
            'id' => 991,
            'members' => [
                ['type' => 'way', 'ref' => 1234, 'role' => 'from'],
                ['type' => 'node', 'ref' => 5678, 'role' => 'via', 'lat' => -17.78, 'lon' => -63.18],
                ['type' => 'way', 'ref' => 4321, 'role' => 'to'],
            ],
            'tags' => [
                'type' => 'restriction',
                'restriction' => 'no_left_turn',
            ],
        ], $overrides);
    }

    public function test_it_parses_the_from_to_and_via_identities(): void
    {
        $restriction = TurnRestriction::fromElement(self::relation());

        $this->assertNotNull($restriction);
        $this->assertSame(991, $restriction->osmId);
        $this->assertSame('no_left_turn', $restriction->kind);
        $this->assertSame(1234, $restriction->fromOsmWay);
        $this->assertSame(4321, $restriction->toOsmWay);
        $this->assertSame(-17.78, $restriction->viaLat);
        $this->assertSame(-63.18, $restriction->viaLng);
    }

    public function test_a_usable_element_has_no_skip_reason(): void
    {
        $this->assertNull(TurnRestriction::skipReason(self::relation()));
    }

    public function test_a_restriction_exempting_buses_is_skipped(): void
    {
        // Buses are the routed vehicle, so an exemption naming them makes the
        // restriction a non-restriction for this router. Stored anyway, it
        // would forbid a turn the bus is allowed to take.
        $element = self::relation([
            'tags' => [
                'type' => 'restriction',
                'restriction' => 'no_left_turn',
                'except' => 'bus',
            ],
        ]);

        $this->assertSame('except_bus', TurnRestriction::skipReason($element));
        $this->assertNull(TurnRestriction::fromElement($element));
    }

    public function test_public_service_vehicle_and_motor_vehicle_exemptions_are_skipped_too(): void
    {
        // psv names buses by their service role, and motor_vehicle names every
        // car on the road — which includes them. Matching is case-insensitive
        // because the tag values in the wild are not consistent about it.
        foreach (['psv', 'motor_vehicle', 'BUS', 'psv;bus'] as $except) {
            $element = self::relation([
                'tags' => [
                    'type' => 'restriction',
                    'restriction' => 'no_right_turn',
                    'except' => $except,
                ],
            ]);

            $this->assertSame(
                'except_bus',
                TurnRestriction::skipReason($element),
                "except={$except} should exempt buses.",
            );
        }
    }

    public function test_an_exemption_for_other_vehicles_does_not_skip(): void
    {
        // hgv exempts trucks, and taxi nothing a bus route is; both leave the
        // restriction binding on the bus, so it must be stored.
        $element = self::relation([
            'tags' => [
                'type' => 'restriction',
                'restriction' => 'no_left_turn',
                'except' => 'hgv;taxi',
            ],
        ]);

        $this->assertNull(TurnRestriction::skipReason($element));
    }

    public function test_a_via_way_restriction_is_skipped(): void
    {
        // The "no U-turn via the next block" pattern names a stretch, not a
        // junction; the graph stores nodes, so it has nothing to address it by.
        $element = self::relation([
            'members' => [
                ['type' => 'way', 'ref' => 1234, 'role' => 'from'],
                ['type' => 'way', 'ref' => 9876, 'role' => 'via'],
                ['type' => 'way', 'ref' => 4321, 'role' => 'to'],
            ],
        ]);

        $this->assertSame('via_way', TurnRestriction::skipReason($element));
        $this->assertNull(TurnRestriction::fromElement($element));
    }

    public function test_a_missing_via_is_malformed(): void
    {
        $element = self::relation([
            'members' => [
                ['type' => 'way', 'ref' => 1234, 'role' => 'from'],
                ['type' => 'way', 'ref' => 4321, 'role' => 'to'],
            ],
        ]);

        $this->assertSame('malformed', TurnRestriction::skipReason($element));
    }

    public function test_a_relation_that_is_not_a_restriction_is_reported_as_such(): void
    {
        // The Overpass query filters on type, so reaching this token means the
        // query and the parser disagree — worth its own reason rather than
        // folding into a generic skip.
        $element = self::relation([
            'tags' => ['type' => 'route', 'route' => 'bus'],
        ]);

        $this->assertSame('not_restriction', TurnRestriction::skipReason($element));
    }

    /** @return array<string, list{list<array<string, mixed>>, list<array<string, mixed>>}> */
    public static function incompleteElementProvider(): array
    {
        return [
            'missing from' => [[
                ['type' => 'node', 'ref' => 5678, 'role' => 'via', 'lat' => -17.78, 'lon' => -63.18],
                ['type' => 'way', 'ref' => 4321, 'role' => 'to'],
            ], []],
            'missing to' => [[
                ['type' => 'way', 'ref' => 1234, 'role' => 'from'],
                ['type' => 'node', 'ref' => 5678, 'role' => 'via', 'lat' => -17.78, 'lon' => -63.18],
            ], []],
            'via without a coordinate' => [[
                ['type' => 'way', 'ref' => 1234, 'role' => 'from'],
                ['type' => 'node', 'ref' => 5678, 'role' => 'via'],
                ['type' => 'way', 'ref' => 4321, 'role' => 'to'],
            ], []],
            'from without a ref' => [[
                ['type' => 'way', 'role' => 'from'],
                ['type' => 'node', 'ref' => 5678, 'role' => 'via', 'lat' => -17.78, 'lon' => -63.18],
                ['type' => 'way', 'ref' => 4321, 'role' => 'to'],
            ], []],
            'no restriction kind' => [[], ['type' => 'restriction']],
        ];
    }

    #[DataProvider('incompleteElementProvider')]
    public function test_an_incomplete_element_parses_to_nothing(array $members = [], array $tags = []): void
    {
        $element = self::relation();

        if ($members !== []) {
            $element['members'] = $members;
        }

        if ($tags !== []) {
            $element['tags'] = $tags;
        }

        $this->assertNull(TurnRestriction::fromElement($element));
    }
}
