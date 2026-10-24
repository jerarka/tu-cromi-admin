<?php

namespace App\Console\Commands;

use App\Geo\MapWindow;
use Illuminate\Console\Command;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Calculate the mobile map windows from the line geometries.
 *
 * Two windows, because the app has two jobs: a reduced one that keeps the map
 * small by dropping whole outlying routes, and a full one that is guaranteed to
 * contain every route. Both are expanded by the same margin and both are
 * EPSG:3857, which is the CRS the mobile map consumes.
 *
 * The reduced window is the exact minimum-area window containing the requested
 * percentage of routes. A route is one `code`, with both directions unioned:
 * "fully contains" is deliberate, because a window that only intersects a route
 * makes the app draw that route cut off at the map edge.
 *
 * The published string is the mobile config's pair order, not the conventional
 * [minX,minY,maxX,maxY]: X pair first, then Y pair (minX,maxX,minY,maxY).
 */
class LinesMapBounds extends Command
{
    protected $signature = 'lines:map-bounds
        {--coverage=95 : Percentage of routes the reduced window must fully contain}
        {--margin=1000 : Margin applied to both windows, in EPSG:3857 units}
        {--decimals=1 : Decimal places used in the published coordinates}
        {--exclude=* : Line code to leave out of both windows (repeatable)}';

    protected $description = 'Calculate the reduced and full mobile map windows (EPSG:3857) from line geometries';

    public function handle(): int
    {
        if (Schema::getConnection()->getDriverName() !== 'pgsql') {
            $this->error(
                'lines.geom only exists on PostgreSQL with PostGIS. The configured driver is '
                .Schema::getConnection()->getDriverName().', so there are no projected bounds to read.'
            );

            return self::FAILURE;
        }

        $coverage = (float) $this->option('coverage');
        $margin = (float) $this->option('margin');
        $decimals = (int) $this->option('decimals');

        if ($coverage <= 0.0 || $coverage > 100.0) {
            $this->error('--coverage must be greater than 0 and at most 100.');

            return self::FAILURE;
        }

        if ($margin < 0.0) {
            $this->error('--margin cannot be negative.');

            return self::FAILURE;
        }

        if ($decimals < 0 || $decimals > 6) {
            $this->error('--decimals must be between 0 and 6.');

            return self::FAILURE;
        }

        $excluded = $this->excludedCodes();
        $boxes = $this->routeBoxes($excluded);

        if ($boxes === []) {
            $this->error('No lines with geometry were found for the current filter.');

            return self::FAILURE;
        }

        $routes = count($boxes);
        $minimum = max(1, min($routes, (int) ceil($routes * $coverage / 100)));

        $reduced = MapWindow::containingAtLeast($boxes, $minimum)->expanded($margin)->roundedOutward($decimals);
        $full = MapWindow::enclosing($boxes)->expanded($margin)->roundedOutward($decimals);

        $reducedContained = count(array_filter($boxes, static fn (array $box): bool => $reduced->contains($box)));
        $fullContained = count(array_filter($boxes, static fn (array $box): bool => $full->contains($box)));

        $totalLength = $this->totalLength($excluded);
        $reducedLength = $this->coveredLength($reduced, $excluded);
        $fullLength = $this->coveredLength($full, $excluded);

        $reducedPercent = $this->percentOf($reducedLength, $totalLength);
        $fullPercent = $this->percentOf($fullLength, $totalLength);

        return $this->printReport(
            $routes,
            $excluded,
            $coverage,
            $margin,
            $decimals,
            $reduced,
            $reducedContained,
            $reducedPercent,
            $full,
            $fullContained,
            $fullPercent,
        );
    }

    /**
     * @return list<string>
     */
    private function excludedCodes(): array
    {
        /** @var array<int, mixed> $raw */
        $raw = (array) $this->option('exclude');

        return array_values(array_filter(
            array_map(static fn (mixed $code): string => trim((string) $code), $raw),
            static fn (string $code): bool => $code !== '',
        ));
    }

    /**
     * One box per route code, unioning its directions.
     *
     * The unit is the route, not the direction: a window that contains the
     * outbound but not the return leaves the app drawing a route cut in half.
     * Unioning both directions before the search is what makes "95% of routes"
     * mean both halves are inside.
     *
     * @param  list<string>  $excluded
     * @return list<array{minX: float, minY: float, maxX: float, maxY: float}>
     */
    private function routeBoxes(array $excluded): array
    {
        $rows = DB::select(<<<'SQL'
            SELECT code,
                   ST_XMin(b) AS x_min,
                   ST_YMin(b) AS y_min,
                   ST_XMax(b) AS x_max,
                   ST_YMax(b) AS y_max
            FROM (
                SELECT code, ST_Extent(ST_Transform(geom, 3857)) AS b
                FROM lines
                WHERE geom IS NOT NULL
                GROUP BY code
            ) t
            ORDER BY code
        SQL);

        $boxes = [];

        foreach ($rows as $row) {
            if (in_array((string) $row->code, $excluded, true)) {
                continue;
            }

            $boxes[] = [
                'minX' => (float) $row->x_min,
                'minY' => (float) $row->y_min,
                'maxX' => (float) $row->x_max,
                'maxY' => (float) $row->y_max,
            ];
        }

        return $boxes;
    }

    /**
     * @param  list<string>  $excluded
     */
    private function totalLength(array $excluded): float
    {
        $row = $this->lengthQuery($excluded)
            ->selectRaw('sum(ST_Length(ST_Transform(geom, 3857))) AS meters')
            ->first();

        return (float) ($row->meters ?? 0.0);
    }

    /**
     * @param  list<string>  $excluded
     */
    private function coveredLength(MapWindow $window, array $excluded): float
    {
        $row = $this->lengthQuery($excluded)
            ->selectRaw(
                'sum(ST_Length(ST_CollectionExtract(ST_Intersection('
                .'ST_Transform(geom, 3857), ST_MakeEnvelope(?, ?, ?, ?, 3857)), 2))) AS meters',
                [$window->minX, $window->minY, $window->maxX, $window->maxY],
            )
            ->first();

        return (float) ($row->meters ?? 0.0);
    }

    /**
     * @param  list<string>  $excluded
     */
    private function lengthQuery(array $excluded): Builder
    {
        $query = DB::table('lines')->whereNotNull('geom');

        if ($excluded !== []) {
            $query->whereNotIn('code', $excluded);
        }

        return $query;
    }

    private function percentOf(float $part, float $total): float
    {
        return $total > 0.0 ? round($part / $total * 100, 2) : 0.0;
    }

    /**
     * @param  list<string>  $excluded
     */
    private function printReport(
        int $routes,
        array $excluded,
        float $coverage,
        float $margin,
        int $decimals,
        MapWindow $reduced,
        int $reducedContained,
        float $reducedPercent,
        MapWindow $full,
        int $fullContained,
        float $fullPercent,
    ): int {
        $filter = $excluded === [] ? '' : ' (excluding '.implode(', ', $excluded).')';
        $this->info(sprintf('%d routes with geometry%s', $routes, $filter));
        $this->newLine();

        $this->line(sprintf(
            'Reduced - %.1f%% target, +%s m margin: %d/%d routes fully inside, %.1f%% of route km',
            $coverage,
            number_format($margin, 0, '.', ''),
            $reducedContained,
            $routes,
            $reducedPercent,
        ));
        $this->line('  '.$reduced->format($decimals).' [EPSG:3857]');
        $this->line(sprintf(
            '  %.1f x %.1f km, %.0f km2',
            $reduced->width() / 1000,
            $reduced->height() / 1000,
            $reduced->area() / 1e6,
        ));
        $this->newLine();

        $this->line(sprintf(
            'Full + %s m margin: %d/%d routes fully inside, %.1f%% of route km',
            number_format($margin, 0, '.', ''),
            $fullContained,
            $routes,
            $fullPercent,
        ));
        $this->line('  '.$full->format($decimals).' [EPSG:3857]');
        $this->line(sprintf(
            '  %.1f x %.1f km, %.0f km2',
            $full->width() / 1000,
            $full->height() / 1000,
            $full->area() / 1e6,
        ));

        return self::SUCCESS;
    }
}
