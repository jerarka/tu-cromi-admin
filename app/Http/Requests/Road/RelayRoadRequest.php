<?php

namespace App\Http\Requests\Road;

use Illuminate\Foundation\Http\FormRequest;

class RelayRoadRequest extends FormRequest
{
    /**
     * How many points one re-lay may ask about.
     *
     * Nothing like the cap on a single drop, because this is a different
     * question: a drop sends one point as the reference and a handful more to
     * break a tie, and past that the extra points genuinely stop changing the
     * answer. Here every point is its own reference and every point's answer is
     * wanted, so the cost scales with the selection and the reviewer is the one
     * deciding how much to select.
     *
     * A marquee over a long route can easily catch five hundred vertices, so
     * this is a real ceiling rather than a formality. It is set where the
     * lookup still answers inside the time a person waits for a button, measured
     * against the real network rather than guessed: the whole query is a KNN
     * index scan per point, which is a couple of milliseconds each.
     */
    public const MAX_POINTS = 120;

    /**
     * Two streets this close count as the same spot.
     *
     * The same three metres a single drop uses, and for the same reason: it is a
     * kerb, which is the width of a crossing. Deliberately not scaled with the
     * threshold — a band that grew with the preset would stop meaning "the
     * street the reviewer pointed at" and start meaning "a street somewhere
     * near the one they pointed at".
     */
    public const TIE_BAND_METERS = 3.0;

    public function authorize(): bool
    {
        return true;
    }

    /**
     * Both distances are capped rather than trusted, exactly as on a drop. A
     * caller asking to re-lay a stretch onto a street it never touched is
     * describing a different feature, and one that rewrites a whole selection.
     *
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'points' => ['required', 'array', 'min:2', 'max:'.self::MAX_POINTS],
            'points.*.lat' => ['required', 'numeric', 'between:-90,90'],
            'points.*.lng' => ['required', 'numeric', 'between:-180,180'],
            'radius' => ['nullable', 'numeric', 'min:1', 'max:200'],
            'threshold' => ['nullable', 'numeric', 'min:0', 'max:200'],
        ];
    }

    /**
     * How far each point looks for a street to vote for.
     */
    public function radius(): float
    {
        $radius = $this->input('radius');

        return $radius === null || $radius === '' ? 60.0 : (float) $radius;
    }

    /** How close a street must be to a point to be considered for it. */
    public function threshold(): float
    {
        $threshold = $this->input('threshold');

        return $threshold === null || $threshold === ''
            ? 25.0
            : (float) $threshold;
    }

    /**
     * The selected points as `[lat, lng]` pairs, in the order they were sent.
     *
     * Order is the contract, and it is the whole contract here: the reply is
     * matched to the selection position by position, and the client re-lays the
     * route in that order so it can tell a corner from a straight run. A
     * reordering would not shuffle the answer, it would apply each street to
     * somebody else's vertex.
     *
     * @return list<array{0: float, 1: float}>
     */
    public function points(): array
    {
        // Wrapped in array_values for the same reason as SnapRoadRequest, though
        // nothing here builds placeholders from the key: the reply is a JSON
        // array and its order has to survive the round trip as a list.
        return array_values(
            array_map(
                fn (array $point): array => [(float) $point['lat'], (float) $point['lng']],
                $this->validated('points'),
            ),
        );
    }
}
