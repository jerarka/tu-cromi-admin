<?php

namespace App\Models;

use App\Enums\DirectionOperation;
use App\Enums\LineSense;
use Database\Factories\LineFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Represents a single direction of a transport line.
 *
 * Each real-world line (e.g. "1") generates two records:
 * OUTBOUND (ida) and RETURN (vuelta), each with its own geometry (MultiLineString).
 * The `code` field groups the two opposite directions.
 * When both directions exist, they link via parent_line_id (bidirectional).
 * Lines with only one sense (e.g. 72, 73) have no counterpart.
 *
 * Column ownership
 * ----------------
 * The source GeoJSON is a bootstrap snapshot, not a feed: it is committed once
 * and never updated. It only ever seeded the table. The database is where the
 * data is curated from here on, and each column has a single owner that
 * lines:import respects:
 *
 *   objectid, syndicate  the source. Safe to refresh.
 *   code, code_number,
 *   sense                the source, as identity. Set on insert only.
 *   geo_json             a human, since the bootstrap. Never overwritten.
 *   name, color          a human, through the admin form. Never touched.
 *   parent_line_id       derived. Recomputed after every import.
 *   geom                 derived from geo_json. Resynced when geo_json changes.
 *   average_rating,
 *   total_reviews        the users. Never touched.
 *
 * @property int $id Auto-increment primary key
 * @property string $code Public identifier grouping OUTBOUND and RETURN (e.g. "1", "16 azul", "104 C"). Not unique — two rows share the same code
 * @property int $code_number Derived numeric prefix of $code, used for natural ordering
 * @property string|null $name Display name (e.g. "Línea 1")
 * @property string|null $color Hex color for UI
 * @property GeoJson|null $geo_json Raw GeoJSON MultiLineString coordinates [lng, lat]. The only source of truth for which way a line travels
 * @property bool $geometry_adjusted Whether a human changed the geometry after the import. A dirty flag, not state: see applyDirectionOperation()
 * @property LineSense $sense Direction of travel: OUTBOUND (ida) or RETURN (vuelta)
 * @property int|null $parent_line_id Opposite-direction sibling ID (self-referential FK). Null when no counterpart exists
 * @property string|null $syndicate Operating company
 * @property int|null $objectid External system identifier
 * @property float|null $average_rating Average user rating (1.00–5.00)
 * @property int $total_reviews Number of user reviews
 * @property \Geometry|null $geom PostGIS geometry(MultiLineString, 4326) with GIST index for spatial queries (ST_DWithin, etc.)
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 *
 * @phpstan-type GeoJson array{type: string, coordinates: array<int, array<int, array<int, float>>>}
 */
#[Fillable([
    'code',
    'name',
    'color',
    'geo_json',
    'sense',
    'parent_line_id',
    'syndicate',
    'objectid',
    'average_rating',
    'total_reviews',
])]
class Line extends Model
{
    /** @use HasFactory<LineFactory> */
    use HasFactory;

    /**
     * Mirrors the column default so a model that was just created reports the
     * same value in memory as the row it wrote. Without this, a freshly
     * inserted instance leaves the attribute null — the insert never carried
     * it — and every read of the flag on a new model looks like a missing value
     * rather than "not corrected yet".
     *
     * @var array<string, mixed>
     */
    protected $attributes = [
        'geometry_adjusted' => false,
    ];

    /**
     * geometry_adjusted is intentionally absent, like code_number: a user
     * must never be able to set it, and nothing in this class mass-assigns it.
     */
    protected function casts(): array
    {
        return [
            'geo_json' => 'array',
            'sense' => LineSense::class,
            'geometry_adjusted' => 'boolean',
            'average_rating' => 'decimal:2',
        ];
    }

    /**
     * Extract the numeric prefix of a public code.
     *
     * Codes take the form "<number>[ <suffix>]" — "1", "104 C", "22 rojo" —
     * and ordering by that prefix as an integer is what makes "2" precede
     * "10". The suffix needs no counterpart column: within a number a bare
     * code is a strict prefix of the suffixed ones, so sorting by `code` after
     * this value already places "22" before "22 rojo".
     *
     * A code with no leading digits is not expected (StoreLineRequest rejects
     * them) but can exist in legacy data. Returning 0 keeps ordering
     * deterministic instead of producing a NULL, which PostgreSQL and SQLite
     * would sort in opposite directions.
     */
    public static function numberFromCode(string $code): int
    {
        if (preg_match('/^\d+/', trim($code), $matches) === 1) {
            return (int) $matches[0];
        }

        return 0;
    }

    /**
     * Derive the sort key whenever the code is assigned.
     *
     * code_number is intentionally absent from $fillable so it cannot be set
     * independently and drift out of sync with the code.
     *
     * The returned array must include `code` itself. A set mutator that returns
     * an array replaces the attribute set entirely — Laravel merges the
     * returned keys and never writes the original one, so omitting it here
     * silently drops the code and the insert fails on a NOT NULL violation.
     *
     * Note that bulk inserts bypass Eloquent mutators, so callers inserting
     * through the query builder (LinesImport) must set both columns
     * explicitly.
     *
     * No @return annotation is given for Attribute: larastan's stub declares
     * TGet/TSet without @template-covariant, so PHPStan treats them as
     * invariant and rejects any explicit annotation, including one identical
     * to the inferred type.
     */
    protected function code(): Attribute
    {
        return Attribute::set(function (?string $value): array {
            $code = (string) $value;

            return [
                'code' => $code,
                'code_number' => self::numberFromCode($code),
            ];
        });
    }

    public function parentLine(): BelongsTo
    {
        return $this->belongsTo(self::class, 'parent_line_id');
    }

    /**
     * The record holding the opposite direction of the same line.
     *
     * Resolved by code and sense rather than by walking parent_line_id on
     * purpose. parent_line_id is a denormalised cache that lines:import fills
     * in, so it can be null or stale on a row whose counterpart plainly exists.
     * A code plus a sense always identifies at most one row, backed by the
     * unique index, so this lookup stays correct regardless of that cache.
     *
     * Null for a line that is alone in its direction — circular routes such as
     * 72 and 73 legitimately have no counterpart.
     */
    public function counterpart(): ?self
    {
        $opposite = $this->sense === LineSense::Outbound
            ? LineSense::Return
            : LineSense::Outbound;

        return static::query()
            ->where('code', $this->code)
            ->where('sense', $opposite->value)
            ->first();
    }

    /**
     * Re-orient this line together with its counterpart, atomically.
     *
     * The source GeoJSON cannot tell us which way a bus actually travels: it
     * stores both directions of most lines in the same coordinate order, so
     * the order of points is an artefact of digitising, not data. Deciding
     * which end is the departure point is therefore a human judgement, and this
     * is the correction that records it. Both operations are their own inverse,
     * so applying one twice is how you undo it — no undo log is needed.
     *
     * Reversing only one record would leave the pair travelling in the same
     * direction, which is why the operation always spans both.
     *
     * The pair is located by code and sense and locked for the duration, so
     * two concurrent corrections of the same line cannot interleave and leave
     * a half-applied pair. The unique index on (code, sense) keeps this to
     * exactly two rows.
     *
     * Setting geometry_adjusted marks the row as curated. It is a dirty flag
     * and never a source of truth: geo_json alone decides the orientation, so
     * the flag cannot drift out of sync with the geometry. It exists so the UI
     * can warn before a source refresh discards a manual correction, and so
     * lines:import can price a destructive run by counting rows instead of
     * diffing every geometry.
     *
     * @return bool False when this line has no counterpart, in which case
     *              nothing is written.
     */
    public function applyDirectionOperation(DirectionOperation $operation): bool
    {
        return DB::transaction(function () use ($operation): bool {
            $pair = static::query()
                ->where('code', $this->code)
                ->lockForUpdate()
                ->get();

            $outbound = $pair->first(
                fn (self $line): bool => $line->sense === LineSense::Outbound
            );
            $return = $pair->first(
                fn (self $line): bool => $line->sense === LineSense::Return
            );

            if (! $outbound instanceof self || ! $return instanceof self) {
                return false;
            }

            match ($operation) {
                DirectionOperation::Invert => $this->invertPair($outbound, $return),
                DirectionOperation::Swap => $this->swapPair($outbound, $return),
            };

            $outbound->geometry_adjusted = true;
            $return->geometry_adjusted = true;

            $outbound->save();
            $return->save();

            $outbound->syncGeometry();
            $return->syncGeometry();

            return true;
        });
    }

    /**
     * Reverse the point order of both records.
     *
     * Each direction keeps its own streets and only the direction of travel
     * flips. Reversing the segments as well as the points is required: a
     * MultiLineString is traversed segment by segment in order, so [A→B][B→C]
     * only becomes [C→B][B→A] when the outer array is reversed too.
     */
    private function invertPair(self $outbound, self $return): void
    {
        $outbound->geo_json = self::reversedGeometry($outbound->geo_json);
        $return->geo_json = self::reversedGeometry($return->geo_json);
    }

    /**
     * Exchange the geometry between the two records.
     *
     * Only geo_json moves. code, sense, name, color and syndicate stay with
     * the sense they describe, which is what makes the result meaningful: the
     * OUTBOUND keeps being the ida and starts drawing the streets the vuelta
     * used. A line with no geometry on one side simply takes the other's.
     */
    private function swapPair(self $outbound, self $return): void
    {
        $outboundGeometry = $outbound->geo_json;
        $returnGeometry = $return->geo_json;

        $outbound->geo_json = $returnGeometry;
        $return->geo_json = $outboundGeometry;
    }

    /**
     * @param  GeoJson|null  $geometry
     * @return GeoJson|null
     */
    private static function reversedGeometry(?array $geometry): ?array
    {
        if ($geometry === null) {
            return null;
        }

        return [
            'type' => $geometry['type'],
            'coordinates' => array_map(
                static fn (array $segment): array => array_reverse($segment),
                array_reverse($geometry['coordinates']),
            ),
        ];
    }

    /**
     * Map the source's numeric `sentido` onto a sense label.
     *
     * This is the only place the source vocabulary is translated, shared by
     * lines:import and lines:refresh-geometry so the two cannot drift apart.
     */
    public static function senseFromSourceSentido(int $sentido): LineSense
    {
        return $sentido === 1 ? LineSense::Outbound : LineSense::Return;
    }

    /**
     * The geometry a source feature produces, under the import's convention.
     *
     * The convention is arbitrary and is documented as such. The source stores
     * the two directions of most lines in the same coordinate order, so
     * reversing one of them does not encode a real direction of travel — it
     * only makes the two records of a pair differ, so the map draws them as
     * opposite. Which record is actually the ida is a human judgement, applied
     * with applyDirectionOperation().
     *
     * Kept here rather than duplicated in each command because both the import
     * and the refresh have to produce byte-identical geometry, and a future
     * change to the convention must not land in only one of them.
     *
     * @param  array<string, mixed>  $feature
     * @return GeoJson|null
     */
    public static function geometryFromSourceFeature(array $feature): ?array
    {
        $geometry = $feature['geometry'] ?? null;

        if (! is_array($geometry) || ($geometry['type'] ?? null) !== 'MultiLineString') {
            return null;
        }

        /** @var array<int, array<int, array<int, float>>> $coordinates */
        $coordinates = $geometry['coordinates'];

        $sentido = (int) (data_get($feature, 'properties.sentido') ?? 1);

        if (self::senseFromSourceSentido($sentido) === LineSense::Return) {
            $coordinates = array_map(
                static fn (array $segment): array => array_reverse($segment),
                array_reverse($coordinates),
            );
        }

        return [
            'type' => 'MultiLineString',
            'coordinates' => $coordinates,
        ];
    }

    /**
     * Recompute the PostGIS geometry from the line's raw GeoJSON.
     *
     * A null geo_json clears the column. The geom column only exists on
     * PostgreSQL — the lines migration skips it on other drivers — so this is
     * a no-op under the SQLite test database. The consequence is that the
     * geometry write itself is not covered by the standard test suite.
     *
     * The write is a statement rather than an assignment because geom has no
     * cast and no accessor: setting the attribute would hand the model a
     * PostGIS value it cannot round-trip back out as a string.
     */
    public function syncGeometry(): void
    {
        if (Schema::getConnection()->getDriverName() !== 'pgsql') {
            return;
        }

        if ($this->geo_json === null) {
            DB::statement('UPDATE lines SET geom = NULL WHERE id = ?', [$this->id]);

            return;
        }

        DB::statement('UPDATE lines SET geom = ST_GeomFromGeoJSON(geo_json::text) WHERE id = ?', [
            $this->id,
        ]);
    }

    /**
     * Pair this line with its opposite direction, if the counterpart exists.
     *
     * Mirrors what lines:import does, and is needed because creating a line
     * through the admin UI would otherwise leave parent_line_id null and
     * silently break the ida/vuelta pairing.
     *
     * A line that is alone in its direction is legitimate — circular routes
     * such as 72 and 73 have no counterpart — so a missing match is a no-op
     * rather than an error. The unique index on (code, sense) guarantees the
     * lookup resolves to at most one row.
     *
     * Both sides are updated, so linking the second direction also repairs the
     * first. This bumps updated_at on the counterpart, which is accurate: the
     * record genuinely changed.
     */
    public function linkCounterpart(): void
    {
        $opposite = $this->sense === LineSense::Outbound
            ? LineSense::Return
            : LineSense::Outbound;

        $counterpart = static::query()
            ->where('code', $this->code)
            ->where('sense', $opposite->value)
            ->first();

        if (! $counterpart instanceof self) {
            return;
        }

        static::query()
            ->whereKey($this->getKey())
            ->update(['parent_line_id' => $counterpart->getKey()]);

        static::query()
            ->whereKey($counterpart->getKey())
            ->update(['parent_line_id' => $this->getKey()]);

        $this->parent_line_id = $counterpart->getKey();
    }

    public function childLines(): HasMany
    {
        return $this->hasMany(self::class, 'parent_line_id');
    }

    public function favorites(): HasMany
    {
        return $this->hasMany(Favorite::class);
    }

    public function reviews(): HasMany
    {
        return $this->hasMany(Review::class);
    }
}
