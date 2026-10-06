<?php

namespace App\Http\Requests\Road;

use Illuminate\Foundation\Http\FormRequest;

class ContinueRoadRequest extends FormRequest
{
    /**
     * How far from the point where the walk ran out a candidate street may be.
     *
     * Twenty-five metres, which is a junction and a bit: two OSM ways that share a
     * node can still have their nearest approaches a few metres apart, and the
     * walk is asking about the geometry rather than about the node table.
     *
     * Capped rather than trusted, on the same grounds as the other two road
     * lookups: a caller asking to continue across three blocks is describing a
     * different feature, and the answer it would get back would be a plausible
     * street that has nothing to do with the one the route is on.
     */
    public const MAX_RADIUS_METERS = 200.0;

    /**
     * How far the radius is when the caller does not say.
     */
    public const DEFAULT_RADIUS_METERS = 25.0;

    /**
     * How far ahead of the junction the continuation is measured.
     *
     * This is the whole heuristic, and it is worth being explicit about what it
     * does. There is no graph in this table — one row is one OSM way and nothing
     * records which node a way ends at — so "the street that continues" cannot be
     * looked up. It can only be approximated by asking which street you would be
     * on had you kept going.
     *
     * Ten metres is that distance, and it is set where a turn still answers: at a
     * corner the street you turned onto passes within a metre of the junction, so
     * a probe ten metres ahead is about ten metres from it while the street you
     * came along is ten metres away in the other direction. Ordering by distance
     * to the probe therefore prefers going straight and falls back to turning —
     * which is the right order for a route and would be the wrong one for a
     * navigator.
     *
     * A tighter probe would reject most turns; a longer one would walk past them
     * and pick up whatever is two blocks ahead instead.
     */
    public const PROBE_METERS = 10.0;

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
            // Required and not nullable, because without a road to exclude there
            // is nothing to distinguish the continuation from the street the walk
            // is already on, and the answer comes back as the way the route is
            // already following — a correct-looking loop that never leaves the
            // block.
            'road_id' => ['required', 'integer', 'min:1'],
            'lat' => ['required', 'numeric', 'between:-90,90'],
            'lng' => ['required', 'numeric', 'between:-180,180'],
            // The compass direction of travel at the point the walk ran out,
            // clockwise from north. Sent rather than recomputed because only the
            // caller knows which way along the route it was going: a route runs
            // against a way's own node order about half the time, and the two
            // senses of a line are separate rows.
            //
            // Numeric but not range-checked, which is the one place this request
            // does not cap what it is given. A bearing is an angle and every angle
            // is meaningful modulo a full turn, so a value outside 0-360 is a
            // bearing that wrapped rather than a mistake — and the client produces
            // exactly those, having derived one from a turn. `bearing()` folds it;
            // refusing it here would reject the value for being correct.
            'bearing' => ['required', 'numeric'],
            'radius' => ['nullable', 'numeric', 'min:1', 'max:'.self::MAX_RADIUS_METERS],
        ];
    }

    /** The road the walk is leaving, and must not be handed back. */
    public function roadId(): int
    {
        return (int) $this->validated('road_id');
    }

    /** How far from the junction a candidate street may be. */
    public function radius(): float
    {
        $radius = $this->input('radius');

        return $radius === null || $radius === ''
            ? self::DEFAULT_RADIUS_METERS
            : (float) $radius;
    }

    /**
     * The compass bearing the walk was travelling, in degrees clockwise from north.
     *
     * Modulo 360 rather than trusted as sent, because the arithmetic that produces
     * it on the client ends anywhere in a turn and `ST_Project` wants a direction
     * it can point at. A negative bearing is a perfectly ordinary way of saying
     * "west" and is not an error worth rejecting.
     */
    public function bearing(): float
    {
        return fmod(fmod((float) $this->validated('bearing'), 360.0) + 360.0, 360.0);
    }
}
