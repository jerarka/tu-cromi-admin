<?php

namespace Tests\Feature\Lines;

use Tests\TestCase;

/**
 * The window math runs on SQLite, but the data it needs does not: lines.geom is
 * a PostGIS column. The command must say so instead of reporting an empty or
 * misleading window.
 */
class LinesMapBoundsTest extends TestCase
{
    public function test_it_refuses_to_run_without_postgis(): void
    {
        $this->artisan('lines:map-bounds')
            ->expectsOutputToContain('PostgreSQL')
            ->assertFailed();
    }
}
