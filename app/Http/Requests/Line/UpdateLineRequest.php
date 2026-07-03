<?php

namespace App\Http\Requests\Line;

use Illuminate\Foundation\Http\FormRequest;

class UpdateLineRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'name' => ['nullable', 'string', 'max:255'],
            'color' => ['nullable', 'string', 'max:255'],
            'syndicate' => ['nullable', 'string', 'max:255'],
            'geo_json' => ['nullable', 'json'],
        ];
    }
}
