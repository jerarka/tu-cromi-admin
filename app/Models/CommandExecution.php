<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * @property int $id
 * @property string $command
 * @property Carbon $started_at
 * @property Carbon|null $finished_at
 * @property int|null $duration_ms
 * @property string $status
 * @property array<string, mixed>|null $options
 * @property array<string, mixed>|null $result
 * @property string|null $error
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 */
#[Fillable([
    'command',
    'started_at',
    'finished_at',
    'duration_ms',
    'status',
    'options',
    'result',
    'error',
])]
class CommandExecution extends Model
{
    protected function casts(): array
    {
        return [
            'started_at' => 'datetime',
            'finished_at' => 'datetime',
            'options' => 'array',
            'result' => 'array',
        ];
    }
}
