<?php

namespace App\Geo;

use InvalidArgumentException;
use SplPriorityQueue;

/**
 * An axis-aligned window in projected units, and the two ways this project
 * derives one from a set of line bounds.
 *
 * The windows the mobile app consumes are EPSG:3857, but nothing in this class
 * knows that: it only adds, compares and rounds the numbers it is given, which
 * is what keeps it reachable from the SQLite test suite while the PostGIS query
 * that feeds it lives in the command.
 */
final readonly class MapWindow
{
    public function __construct(
        public float $minX,
        public float $minY,
        public float $maxX,
        public float $maxY,
    ) {
        if ($maxX < $minX || $maxY < $minY) {
            throw new InvalidArgumentException('A map window cannot have a negative width or height.');
        }
    }

    /**
     * The window that contains every box.
     *
     * @param  list<array{minX: float, minY: float, maxX: float, maxY: float}>  $boxes
     */
    public static function enclosing(array $boxes): self
    {
        if ($boxes === []) {
            throw new InvalidArgumentException('At least one bounding box is required.');
        }

        return new self(
            (float) min(array_column($boxes, 'minX')),
            (float) min(array_column($boxes, 'minY')),
            (float) max(array_column($boxes, 'maxX')),
            (float) max(array_column($boxes, 'maxY')),
        );
    }

    /**
     * The smallest-area window that fully contains at least $minimum boxes.
     *
     * "Contains fully" is the point: a window that merely intersects a route is
     * a window the mobile app draws a route cut off at its edge. The reduced
     * window is therefore chosen by dropping whole routes, not by clipping them.
     *
     * The search is exact, not a trim-each-edge heuristic. For a fixed pair of
     * Y bounds, the cheapest X interval containing $minimum eligible boxes is
     * found by sweeping Xmin downwards and keeping the $minimum smallest Xmax
     * values in a max-heap. Only the (n - minimum + 1) lowest distinct Ymin and
     * highest distinct Ymax values can possibly be valid bounds: anything
     * further in already excludes too many boxes, so the candidate set stays
     * small even when a caller asks for a low coverage.
     *
     * @param  list<array{minX: float, minY: float, maxX: float, maxY: float}>  $boxes
     */
    public static function containingAtLeast(array $boxes, int $minimum): self
    {
        $count = count($boxes);

        if ($count === 0) {
            throw new InvalidArgumentException('At least one bounding box is required.');
        }

        if ($minimum < 1 || $minimum > $count) {
            throw new InvalidArgumentException('The minimum must be between one and the number of boxes.');
        }

        if ($minimum === $count) {
            return self::enclosing($boxes);
        }

        $slack = $count - $minimum;
        $minYCandidates = self::lowestDistinct(array_column($boxes, 'minY'), $slack + 1);
        $maxYCandidates = self::highestDistinct(array_column($boxes, 'maxY'), $slack + 1);

        $best = null;
        $bestArea = INF;

        foreach ($minYCandidates as $minY) {
            foreach ($maxYCandidates as $maxY) {
                if ($maxY < $minY) {
                    continue;
                }

                $eligible = array_values(array_filter(
                    $boxes,
                    static fn (array $box): bool => $box['minY'] >= $minY && $box['maxY'] <= $maxY,
                ));

                if (count($eligible) < $minimum) {
                    continue;
                }

                $x = self::narrowestX($eligible, $minimum);

                if ($x === null) {
                    continue;
                }

                [$xMin, $xMax] = $x;
                $area = ($xMax - $xMin) * ($maxY - $minY);

                if ($area < $bestArea) {
                    $bestArea = $area;
                    $best = new self($xMin, $minY, $xMax, $maxY);
                }
            }
        }

        return $best ?? self::enclosing($boxes);
    }

    /**
     * The narrowest X interval containing at least $minimum of the boxes.
     *
     * @param  list<array{minX: float, minY: float, maxX: float, maxY: float}>  $boxes
     * @return array{0: float, 1: float}|null
     */
    private static function narrowestX(array $boxes, int $minimum): ?array
    {
        usort($boxes, static fn (array $a, array $b): int => $b['minX'] <=> $a['minX']);

        /** @var SplPriorityQueue<float, int> $heap */
        $heap = new SplPriorityQueue;
        $heap->setExtractFlags(SplPriorityQueue::EXTR_PRIORITY);

        $bestWidth = INF;
        $best = null;
        $added = 0;

        foreach ($boxes as $box) {
            $heap->insert(0, $box['maxX']);
            $added++;

            while ($heap->count() > $minimum) {
                $heap->extract();
            }

            if ($added < $minimum) {
                continue;
            }

            $xMax = (float) $heap->top();
            $width = $xMax - $box['minX'];

            if ($width < $bestWidth) {
                $bestWidth = $width;
                $best = [$box['minX'], $xMax];
            }
        }

        return $best;
    }

    /**
     * @param  list<float>  $values
     * @return list<float>
     */
    private static function lowestDistinct(array $values, int $limit): array
    {
        $values = array_values(array_unique($values));
        sort($values);

        return array_slice($values, 0, $limit);
    }

    /**
     * @param  list<float>  $values
     * @return list<float>
     */
    private static function highestDistinct(array $values, int $limit): array
    {
        $values = array_values(array_unique($values));
        sort($values);

        return array_slice($values, max(0, count($values) - $limit));
    }

    public function expanded(float $margin): self
    {
        if ($margin < 0.0) {
            throw new InvalidArgumentException('A margin cannot be negative.');
        }

        return new self(
            $this->minX - $margin,
            $this->minY - $margin,
            $this->maxX + $margin,
            $this->maxY + $margin,
        );
    }

    /**
     * Round every edge outwards, so a line lying exactly on the edge survives.
     *
     * Nearest rounding is not good enough here: several routes can share the same
     * terminal vertex, and rounding such an edge inwards drops them all while the
     * printed box still looks like it covers them.
     */
    public function roundedOutward(int $decimals): self
    {
        if ($decimals < 0) {
            throw new InvalidArgumentException('Decimal places cannot be negative.');
        }

        $factor = (float) (10 ** $decimals);

        return new self(
            floor($this->minX * $factor + 1e-9) / $factor,
            floor($this->minY * $factor + 1e-9) / $factor,
            ceil($this->maxX * $factor - 1e-9) / $factor,
            ceil($this->maxY * $factor - 1e-9) / $factor,
        );
    }

    /**
     * @param  array{minX: float, minY: float, maxX: float, maxY: float}  $box
     */
    public function contains(array $box): bool
    {
        return $box['minX'] >= $this->minX
            && $box['maxX'] <= $this->maxX
            && $box['minY'] >= $this->minY
            && $box['maxY'] <= $this->maxY;
    }

    public function width(): float
    {
        return $this->maxX - $this->minX;
    }

    public function height(): float
    {
        return $this->maxY - $this->minY;
    }

    public function area(): float
    {
        return $this->width() * $this->height();
    }

    /**
     * The wire format the mobile map config consumes: X pair first, then Y pair.
     *
     * Not [minX, minY, maxX, maxY]. The config reads these positionally, and the
     * second value being a longitude (~-7 0xx xxx) rather than a latitude
     * (~-2 0xx xxx) is the only visible sign that the order is the pair order.
     */
    public function format(int $decimals = 1): string
    {
        return number_format($this->minX, $decimals, '.', '')
            .','.number_format($this->maxX, $decimals, '.', '')
            .','.number_format($this->minY, $decimals, '.', '')
            .','.number_format($this->maxY, $decimals, '.', '');
    }
}
