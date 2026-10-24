<?php

namespace Tests\Unit\Geo;

use App\Geo\MapWindow;
use InvalidArgumentException;
use Tests\TestCase;

/**
 * The mobile map windows are hand-checked geometry, not a snapshot of the
 * implementation.
 *
 * The containing test is built so the cheapest three-box window is visibly not
 * the one a trim-each-edge heuristic would produce: the three southern boxes
 * share a thin latitude band while the third box is far north, so a window that
 * starts from the full extent and only tightens one edge at a time keeps a
 * 110-unit height it does not need.
 */
class MapWindowTest extends TestCase
{
    /**
     * @return list<array{minX: float, minY: float, maxX: float, maxY: float}>
     */
    private static function boxes(): array
    {
        return [
            ['minX' => 0.0, 'minY' => 0.0, 'maxX' => 10.0, 'maxY' => 10.0],
            ['minX' => 100.0, 'minY' => 0.0, 'maxX' => 110.0, 'maxY' => 10.0],
            ['minX' => 0.0, 'minY' => 100.0, 'maxX' => 10.0, 'maxY' => 110.0],
            ['minX' => 50.0, 'minY' => 0.0, 'maxX' => 60.0, 'maxY' => 10.0],
        ];
    }

    public function test_enclosing_contains_every_box(): void
    {
        $window = MapWindow::enclosing(self::boxes());

        $this->assertSame(0.0, $window->minX);
        $this->assertSame(0.0, $window->minY);
        $this->assertSame(110.0, $window->maxX);
        $this->assertSame(110.0, $window->maxY);
    }

    public function test_expanding_adds_the_margin_on_every_side(): void
    {
        $window = (new MapWindow(0.0, 0.0, 10.0, 10.0))->expanded(1000.0);

        $this->assertSame(-1000.0, $window->minX);
        $this->assertSame(-1000.0, $window->minY);
        $this->assertSame(1010.0, $window->maxX);
        $this->assertSame(1010.0, $window->maxY);
    }

    public function test_containing_three_boxes_drops_the_far_north_one(): void
    {
        $window = MapWindow::containingAtLeast(self::boxes(), 3);

        $this->assertSame(0.0, $window->minX);
        $this->assertSame(0.0, $window->minY);
        $this->assertSame(110.0, $window->maxX);
        $this->assertSame(10.0, $window->maxY);
        $this->assertSame(1100.0, $window->area());
    }

    public function test_containing_every_box_is_the_enclosing_window(): void
    {
        $boxes = self::boxes();

        $this->assertEquals(
            MapWindow::enclosing($boxes),
            MapWindow::containingAtLeast($boxes, count($boxes)),
        );
    }

    public function test_only_boxes_fully_inside_are_contained(): void
    {
        $window = new MapWindow(0.0, 0.0, 10.0, 10.0);

        $this->assertTrue($window->contains([
            'minX' => 0.0, 'minY' => 0.0, 'maxX' => 10.0, 'maxY' => 10.0,
        ]));
        $this->assertFalse($window->contains([
            'minX' => -1.0, 'minY' => 0.0, 'maxX' => 10.0, 'maxY' => 10.0,
        ]));
        $this->assertFalse($window->contains([
            'minX' => 0.0, 'minY' => 0.0, 'maxX' => 11.0, 'maxY' => 10.0,
        ]));
    }

    public function test_rounding_moves_every_edge_outwards(): void
    {
        $window = (new MapWindow(-1.25, -2.25, 3.25, 4.25))->roundedOutward(1);

        $this->assertSame(-1.3, $window->minX);
        $this->assertSame(-2.3, $window->minY);
        $this->assertSame(3.3, $window->maxX);
        $this->assertSame(4.3, $window->maxY);
    }

    public function test_format_uses_the_consumed_axis_order(): void
    {
        $window = new MapWindow(-7042091.1, -2029513.6, -7016262.6, -1996190.7);

        $this->assertSame(
            '-7042091.1,-7016262.6,-2029513.6,-1996190.7',
            $window->format(1),
        );
    }

    public function test_a_minimum_outside_the_box_count_is_refused(): void
    {
        $this->expectException(InvalidArgumentException::class);

        MapWindow::containingAtLeast(self::boxes(), 0);
    }

    public function test_an_empty_box_list_is_refused(): void
    {
        $this->expectException(InvalidArgumentException::class);

        MapWindow::enclosing([]);
    }
}
