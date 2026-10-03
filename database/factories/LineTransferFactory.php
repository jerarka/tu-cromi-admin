<?php

namespace Database\Factories;

use App\Models\Line;
use App\Models\LineTransfer;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<LineTransfer>
 */
class LineTransferFactory extends Factory
{
    protected $model = LineTransfer::class;

    /**
     * The model's only timestamp is created_at — LineTransfer sets
     * UPDATED_AT = null — so it has to be supplied rather than left to the
     * migration default, or two rows built in the same second are
     * indistinguishable when ordering by it.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'line_a_id' => Line::factory(),
            'line_b_id' => Line::factory(),
            'point_a_lng' => fake()->longitude(-63.3, -63.1),
            'point_a_lat' => fake()->latitude(-17.9, -17.7),
            'point_a_index' => fake()->numberBetween(0, 500),
            'point_b_lng' => fake()->longitude(-63.3, -63.1),
            'point_b_lat' => fake()->latitude(-17.9, -17.7),
            'point_b_index' => fake()->numberBetween(0, 500),
            'walk_distance' => fake()->randomFloat(1, 0, 300),
            'created_at' => now(),
        ];
    }

    /**
     * A transfer between two specific lines.
     */
    public function between(int $lineAId, int $lineBId): static
    {
        return $this->state(fn (): array => [
            'line_a_id' => $lineAId,
            'line_b_id' => $lineBId,
        ]);
    }
}
