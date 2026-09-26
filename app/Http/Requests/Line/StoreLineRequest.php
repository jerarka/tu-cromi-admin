<?php

namespace App\Http\Requests\Line;

use App\Rules\GeoJsonMultiLineString;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreLineRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'code' => [
                'required',
                'string',
                'max:255',
                // A code is "<number>[ <suffix>]", e.g. "1", "104 C", "22 rojo".
                // Rejecting anything else keeps the derived sort keys
                // meaningful and catches typos like "2O rojo" (letter O).
                'regex:/^\d+(\s+.+)?$/',
                // A code has at most one row per direction. The same code with
                // the other sense is the ida/vuelta pair and is expected;
                // a duplicate sense is not. Mirrored by a unique index, this
                // exists so the failure surfaces as a 422 rather than a 500.
                Rule::unique('lines', 'code')
                    ->where(fn ($query) => $query->where('sense', $this->input('sense'))),
            ],
            'sense' => ['required', 'string', 'in:OUTBOUND,RETURN'],
            'name' => ['nullable', 'string', 'max:255'],
            'color' => ['nullable', 'string', 'max:255'],
            'syndicate' => ['nullable', 'string', 'max:255'],
            'geo_json' => ['nullable', new GeoJsonMultiLineString],
        ];
    }

    /** @return array<string, string> */
    public function messages(): array
    {
        return [
            'code.regex' => 'The code must start with a number, optionally followed by a suffix (e.g. "1" or "22 rojo").',
            'code.unique' => 'A line with this code already exists for this direction.',
        ];
    }
}
