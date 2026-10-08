<?php

namespace App\Http\Requests\Line;

use App\Rules\GeoJsonMultiLineString;
use App\Rules\WaypointsPayload;
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
            // The guided editor's control points, same shape and same trust
            // model as geometry: valid JSON list of {lat, lng}. Absent means
            // "leave the stored recipe alone", which is what the form relies
            // on when a session never opened the guided mode — an edit on
            // geometry that used no controls must not invent a recipe.
            'waypoints' => ['nullable', 'string', new WaypointsPayload],
        ];
    }
}
