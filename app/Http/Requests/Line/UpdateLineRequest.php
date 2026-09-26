<?php

namespace App\Http\Requests\Line;

use App\Rules\GeoJsonMultiLineString;
use Illuminate\Foundation\Http\FormRequest;

class UpdateLineRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * `code` and `sense` are deliberately absent: both are immutable once a
     * line exists, and allowing a change would orphan the parent_line_id
     * pairing and the derived sort keys.
     *
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'name' => ['nullable', 'string', 'max:255'],
            'color' => ['nullable', 'string', 'max:255'],
            'syndicate' => ['nullable', 'string', 'max:255'],
            'geo_json' => ['nullable', new GeoJsonMultiLineString],
        ];
    }
}
