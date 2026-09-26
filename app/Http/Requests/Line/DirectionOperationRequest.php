<?php

namespace App\Http\Requests\Line;

use App\Enums\DirectionOperation;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class DirectionOperationRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * The operation is the whole payload: it acts on the line in the route and
     * on the counterpart that the line resolves to, so there is nothing else to
     * validate and nothing a client could usefully tamper with.
     *
     * Rule::enum keeps the accepted set tied to the enum itself, so adding a
     * case opens it up here automatically instead of leaving a forgotten string
     * rule behind.
     *
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'operation' => ['required', Rule::enum(DirectionOperation::class)],
        ];
    }

    public function operation(): DirectionOperation
    {
        return DirectionOperation::from($this->string('operation')->toString());
    }
}
