<?php

namespace App\Http\Requests\Road;

use Illuminate\Foundation\Http\FormRequest;

class SnapRoadRequest extends FormRequest
{
    /**
     * How many points one drop may ask about.
     *
     * Matches the client sample limit. The extra points exist to break ties at
     * a crossing, not to establish a majority: past a handful they stop
     * changing which street is closest to the point that was dropped, so there
     * is nothing to buy by asking for more.
     */
    public const MAX_POINTS = 7;

    /**
     * How far apart two streets may be and still count as the same spot.
     *
     * Fixed, and deliberately not scaled with the threshold. A band that grew
     * with the preset would let a wide preset accept a street meaningfully
     * further away than the closest one, and "the street the user dropped on
     * wins" would stop being true — which is the one property this lookup
     * cannot trade away. Three metres is a kerb, which is the crossing case the
     * votes exist to resolve.
     */
    public const TIE_BAND_METERS = 3.0;

    public function authorize(): bool
    {
        return true;
    }

    /**
     * Both distances are capped rather than trusted. A caller asking for a
     * kilometre-wide snap is almost certainly going to be shown a road it did
     * not drop a vertex near, and a wrong snap moves a route.
     *
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'points' => ['required', 'array', 'min:1', 'max:'.self::MAX_POINTS],
            'points.*.lat' => ['required', 'numeric', 'between:-90,90'],
            'points.*.lng' => ['required', 'numeric', 'between:-180,180'],
            'radius' => ['nullable', 'numeric', 'min:1', 'max:200'],
            'threshold' => ['nullable', 'numeric', 'min:0', 'max:200'],
        ];
    }

    /**
     * How far each sampled point looks for the street it votes for.
     *
     * This is about gathering votes and is deliberately separate from the
     * threshold: a point three blocks away still has a view on which street the
     * drop is on, but the reference point's own distance is what decides whether
     * any of them are acceptable.
     */
    public function radius(): float
    {
        $radius = $this->input('radius');

        return $radius === null || $radius === '' ? 60.0 : (float) $radius;
    }

    /** How close a street must be to the reference point to be considered. */
    public function threshold(): float
    {
        $threshold = $this->input('threshold');

        return $threshold === null || $threshold === ''
            ? 25.0
            : (float) $threshold;
    }

    /**
     * The sampled points as `[lat, lng]` pairs, in the order they were sent.
     *
     * Order is the contract: the first point is the reference the caller
     * actually dropped on, and it is the one that decides which street is close
     * enough. Every other point only votes on which street that is.
     *
     * @return list<array{0: float, 1: float}>
     */
    public function points(): array
    {
        // Wrapped in array_values because the caller indexes these positionally
        // and builds query placeholders from that index, so the keys have to be
        // a sequence. validated() hands back a plain array, and array_map keeps
        // whatever keys it was given.
        return array_values(
            array_map(
                fn (array $point): array => [(float) $point['lat'], (float) $point['lng']],
                $this->validated('points'),
            ),
        );
    }
}
