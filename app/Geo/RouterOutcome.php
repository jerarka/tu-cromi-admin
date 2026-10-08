<?php

namespace App\Geo;

/**
 * What the router answered, and for what reason when it answered with nothing.
 *
 * Not found does not throw and is not null-decorated: the editor needs to tell
 * the reviewer WHY a tramo could not be drawn (the origin was nowhere near a
 * street, or the network simply does not connect the two ends), and that is a
 * different message for each. Carrying the reason is what keeps the client
 * from having to guess.
 */
final readonly class RouterOutcome
{
    /**
     * @param  list<array{0: float, 1: float}>|null  $coordinates  [lng, lat] chain, origin to destination
     * @param  list<array{road_id: int, osm_id: int, name: string|null, highway: string, meters: float}>|null  $streets
     */
    private function __construct(
        public ?array $coordinates,
        public ?array $streets,
        public ?float $distanceM,
        public ?string $reason,
    ) {}

    /**
     * @param  list<array{0: float, 1: float}>  $coordinates
     * @param  list<array{road_id: int, osm_id: int, name: string|null, highway: string, meters: float}>  $streets
     */
    public static function foundPath(array $coordinates, array $streets, float $distanceM): self
    {
        return new self($coordinates, $streets, $distanceM, null);
    }

    /** @param  'no-path' | 'budget'  $reason */
    public static function notFound(string $reason): self
    {
        return new self(null, null, null, $reason);
    }

    public function found(): bool
    {
        return $this->reason === null;
    }
}
