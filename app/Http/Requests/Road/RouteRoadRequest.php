<?php

namespace App\Http\Requests\Road;

use Illuminate\Foundation\Http\FormRequest;

class RouteRoadRequest extends FormRequest
{
    /**
     * How far a control point may sit from a road vertex and still be snapped.
     *
     * The same ceiling the other three road lookups share, and for the same
     * reason: a caller asking for a mile-wide origin is describing a route
     * from somewhere else, and a wrong start point moves the whole tramo.
     */
    public const MAX_RADIUS_METERS = 200.0;

    /**
     * The radius that is used when the caller does not say.
     *
     * A hundred metres is far above a way's own vertex spacing, so a point
     * dropped onto a street always has a vertex to snap to, and still small
     * enough that the nearest vertex is the street the caller dropped on
     * rather than the street a block over.
     */
    public const DEFAULT_RADIUS_METERS = 100.0;

    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'origin.lat' => ['required', 'numeric', 'between:-90,90'],
            'origin.lng' => ['required', 'numeric', 'between:-180,180'],
            'destination.lat' => ['required', 'numeric', 'between:-90,90'],
            'destination.lng' => ['required', 'numeric', 'between:-180,180'],
            'bearing' => ['nullable', 'numeric'],
            'radius' => ['nullable', 'numeric', 'min:1', 'max:'.self::MAX_RADIUS_METERS],
        ];
    }

    /**
     * Where the tramo starts, as validation leaves it — the SQL never sees a
     * string because the memory says so.
     *
     * @return array{lat: float, lng: float}
     */
    public function origin(): array
    {
        return $this->point('origin');
    }

    /**
     * Where the tramo ends.
     *
     * @return array{lat: float, lng: float}
     */
    public function destination(): array
    {
        return $this->point('destination');
    }

    /**
     * The compass bearing the route was travelling at the origin, or null.
     *
     * The same contract as ContinueRoadRequest: a bearing is an angle, values
     * outside 0-360 are wrap-arounds rather than mistakes, and the folding
     * into [0, 360) happens here rather than in every reader. It is what
     * chooses the carriageway when two one-way halves run side by side — the
     * one question the distance alone cannot answer.
     */
    public function bearing(): ?float
    {
        $bearing = $this->input('bearing');

        if ($bearing === null || $bearing === '') {
            return null;
        }

        $degrees = fmod(fmod((float) $bearing, 360.0) + 360.0, 360.0);

        return $degrees;
    }

    /** How far a control point looks for the vertex it will snap to. */
    public function radius(): float
    {
        $radius = $this->input('radius');

        return $radius === null || $radius === ''
            ? self::DEFAULT_RADIUS_METERS
            : (float) $radius;
    }

    /**
     * @return array{lat: float, lng: float}
     */
    private function point(string $field): array
    {
        return [
            'lat' => (float) $this->input("{$field}.lat"),
            'lng' => (float) $this->input("{$field}.lng"),
        ];
    }
}
