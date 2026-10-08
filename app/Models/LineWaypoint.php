<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class LineWaypoint extends Model
{
    protected $fillable = [
        'line_id',
        'ordinal',
        'role',
        'lat',
        'lng',
    ];

    /**
     * The values PDO hands back have to be the types they claim to be.
     *
     * A double column arrives as float on SQLite and may arrive as string
     * elsewhere; the editor round-trips these positions straight into code
     * that multiplies and compares them, so the cast is the boundary.
     *
     * @var array<string, string>
     */
    protected $casts = [
        'ordinal' => 'integer',
        'lat' => 'float',
        'lng' => 'float',
    ];

    /** @return BelongsTo<Line, $this> */
    public function line(): BelongsTo
    {
        return $this->belongsTo(Line::class);
    }
}
