<?php

namespace App\Models;

use Database\Factories\LineTransferFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Represents a pedestrian transfer point between two transport lines.
 *
 * Stores the nearest pair of points (one per line) and the walking distance
 * between them. Both forward and inverse directions are stored: for each
 * transfer A→B, a corresponding B→A record exists with swapped coordinates.
 *
 * @property int $id
 * @property int $line_a_id Source line
 * @property int $line_b_id Destination line
 * @property float $point_a_lng Longitude of the transfer point on line A
 * @property float $point_a_lat Latitude of the transfer point on line A
 * @property int $point_a_index Point index along line A's geometry
 * @property float $point_b_lng Longitude of the transfer point on line B
 * @property float $point_b_lat Latitude of the transfer point on line B
 * @property int $point_b_index Point index along line B's geometry
 * @property float $walk_distance Walking distance in meters
 * @property string $created_at
 */
class LineTransfer extends Model
{
    /** @use HasFactory<LineTransferFactory> */
    use HasFactory;

    const UPDATED_AT = null;

    protected $fillable = [
        'line_a_id',
        'line_b_id',
        'point_a_lng',
        'point_a_lat',
        'point_a_index',
        'point_b_lng',
        'point_b_lat',
        'point_b_index',
        'walk_distance',
    ];

    protected function casts(): array
    {
        return [
            'walk_distance' => 'float',
        ];
    }

    /** @return BelongsTo<Line, $this> */
    public function lineA(): BelongsTo
    {
        return $this->belongsTo(Line::class, 'line_a_id');
    }

    /** @return BelongsTo<Line, $this> */
    public function lineB(): BelongsTo
    {
        return $this->belongsTo(Line::class, 'line_b_id');
    }
}
