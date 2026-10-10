<?php

namespace App\Http\Controllers\Admin;

use App\Enums\DirectionOperation;
use App\Enums\LineSense;
use App\Http\Controllers\Controller;
use App\Http\Requests\Line\DirectionOperationRequest;
use App\Http\Requests\Line\StoreLineRequest;
use App\Http\Requests\Line\UpdateLineRequest;
use App\Models\Line;
use App\Rules\WaypointsPayload;
use Illuminate\Console\Command;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Inertia\Inertia;
use Inertia\Response;

class LineController extends Controller
{
    public function index(): Response
    {
        $search = request('search');
        $sense = request('sense');

        $query = Line::query()
            ->when($search, fn ($q) => $q->where(function ($q) use ($search) {
                $q->where('code', 'like', "%{$search}%")
                    ->orWhere('name', 'like', "%{$search}%");
            }))
            ->when($sense, fn ($q) => $q->where('sense', $sense));

        $lines = $this->applyIndexOrder($query)
            ->paginate(15)
            ->withQueryString();

        return Inertia::render('lines/Index', [
            'lines' => $lines,
            'filters' => [
                'search' => $search,
                'sense' => $sense,
            ],
        ]);
    }

    public function create(): Response
    {
        return Inertia::render('lines/Create');
    }

    public function store(StoreLineRequest $request): RedirectResponse
    {
        $data = $request->validated();

        if (! empty($data['geo_json'])) {
            $data['geo_json'] = json_decode($data['geo_json'], true);
        }

        $line = DB::transaction(function () use ($data) {
            $line = Line::create($data);

            $line->syncGeometry();
            $line->linkCounterpart();

            if (isset($data['waypoints'])) {
                $line->syncWaypoints(WaypointsPayload::decode($data['waypoints']));
            }

            return $line;
        });

        Inertia::flash('toast', [
            'type' => 'success',
            'message' => __('Line created.'),
        ]);

        return to_route('lines.index');
    }

    public function edit(Line $line): Response
    {
        return Inertia::render('lines/Edit', [
            'line' => $line,
            // The control points the guided editor left behind, if any. A
            // line with none boots from its own geometry — that fallback is
            // the client's §4.1 bootstrap, not the server's; the server only
            // hands back what it stored.
            'waypoints' => $line->waypoints,
            // Resolved by code and sense instead of parent_line_id, which is
            // only a cache that the import fills in and that can be null or
            // stale on a row whose counterpart plainly exists. The direction
            // buttons need the truth, and a row with no counterpart is the
            // normal case for circular routes such as 72 and 73.
            'counterpart' => $line->counterpart(),
            'nav' => [
                'prev' => $this->adjacent($line, 'prev'),
                'next' => $this->adjacent($line, 'next'),
            ],
        ]);
    }

    /**
     * Re-orient a line together with its counterpart.
     *
     * The source data cannot say which end a bus departs from, so this is a
     * manual correction rather than something derivable. Both operations are
     * their own inverse, which is what makes an undo unnecessary: repeating the
     * same button restores the previous geometry.
     *
     * A line with no counterpart cannot be re-oriented — the operation spans
     * two records by definition — so it is refused with an error instead of
     * silently half-applying. The UI already disables the buttons in that case;
     * this is the guard for a direct request.
     */
    public function directions(DirectionOperationRequest $request, Line $line): RedirectResponse
    {
        $operation = $request->operation();

        if (! $line->applyDirectionOperation($operation)) {
            Inertia::flash('toast', [
                'type' => 'error',
                'message' => __('This line has no counterpart, so its direction cannot be changed.'),
            ]);

            return to_route('lines.edit', $line);
        }

        Inertia::flash('toast', [
            'type' => 'success',
            'message' => match ($operation) {
                DirectionOperation::Invert => __('Both directions were reversed. Each keeps its own streets.'),
                DirectionOperation::Swap => __('The geometry was swapped between both directions.'),
            },
        ]);

        return to_route('lines.edit', $line);
    }

    /**
     * Restore this line's geometry from the source GeoJSON.
     *
     * Delegates to the command instead of repeating it: the source lookup, the
     * flag reset and the stale-transfer warning all live in one place, and a
     * second copy here would be free to drift away from it. The cost is reading
     * the whole GeoJSON per click, which is the price of a deliberate
     * operation on a route nobody is likely to hit twice.
     */
    public function refreshGeometry(Line $line): RedirectResponse
    {
        $exitCode = Artisan::call('lines:refresh-geometry', ['code' => $line->code]);

        $output = trim(Artisan::output());

        Inertia::flash('toast', [
            'type' => $exitCode === Command::SUCCESS ? 'success' : 'error',
            'message' => $output !== '' ? $output : 'Geometry restored from the source.',
        ]);

        return to_route('lines.edit', $line);
    }

    /**
     * Save a line's fields and stay on its own screen.
     *
     * Redirects back to the edit page rather than the index table because
     * correcting a route is a per-line job: a reviewer works down a list
     * flipping directions, and being thrown back to the table after every save
     * turns that into a hunt for where they were. Inertia re-renders this same
     * page with fresh props, which also clears the dirty flag client-side, so
     * the reviewer can go straight to the next line.
     */
    public function update(UpdateLineRequest $request, Line $line): RedirectResponse
    {
        $data = $request->validated();

        if (! empty($data['geo_json'])) {
            $data['geo_json'] = json_decode($data['geo_json'], true);
        }

        DB::transaction(function () use ($line, $data): void {
            $line->update($data);

            // Only touch geom when the payload actually carried the field.
            // Absent means "leave the geometry alone"; present-but-null means
            // the user cleared it.
            if (array_key_exists('geo_json', $data)) {
                $line->syncGeometry();

                // The geometry no longer matches what the import produced.
                // Recording that lets a later source refresh warn before it
                // discards this edit, and lets the import price a destructive
                // run by counting rows rather than diffing geometries.
                $line->geometry_adjusted = true;
                $line->save();
            }

            // Same asymmetry as the geometry: a payload that never carried
            // waypoints means this save used no control points, and an edit
            // made on a surface below the guided mode must not invent a
            // recipe that points at vertices it did not look at.
            if (isset($data['waypoints'])) {
                $line->syncWaypoints(WaypointsPayload::decode($data['waypoints']));
            }
        });

        Inertia::flash('toast', [
            'type' => 'success',
            'message' => __('Line updated.'),
        ]);

        return to_route('lines.edit', $line);
    }

    /**
     * Delete this line's direction.
     *
     * One row, not one route: a row IS a direction, and the index lists rows.
     * Deleting "Línea 1" would have to delete both and then the reviewer has
     * no way back to the one they did not mean, so this is deliberately
     * partial and the counterpart survives. It also cannot be left in a broken
     * state — parent_line_id goes NULL and Line::counterpart() resolves by
     * code and sense instead, which is exactly why that column is only ever a
     * cache.
     *
     * Nothing is cleaned up by hand: the database already cascades to
     * line_waypoints, favorites, reviews and line_transfers (whose *both* ends
     * are foreign keys, so transfers involving this direction in either
     * position go with it), and nulls issue_reports.line_id. Re-implementing
     * any of that here would be a second copy to keep in step with the
     * migrations, and a forgotten delete() in a controller is exactly the kind
     * of orphan no test notices.
     *
     * The redirect carries the index's own filters back, because deleting from
     * a table the reviewer is filtering by is a list operation and landing them
     * on an unfiltered page 1 throws away where they were.
     */
    public function destroy(Line $line): RedirectResponse
    {
        // Read before the delete: after it, the model still holds these in
        // memory but a fresh() would be gone, and the toast has to name the
        // row the reviewer just removed.
        $code = $line->code;
        $sense = $line->sense;

        $line->delete();

        Inertia::flash('toast', [
            'type' => 'success',
            // Both the code and the sense, because the code alone is ambiguous
            // on this table: two rows carry it, and the one that survives is
            // the one the reviewer did not press delete on. The wording is
            // split out rather than concatenated so a translator never has to
            // re-order a half-built sentence.
            'message' => __('Deleted :code (:sense).', [
                'code' => $code,
                'sense' => $sense === LineSense::Return ? __('vuelta') : __('ida'),
            ]),
        ]);

        return to_route('lines.index', $this->indexFilters());
    }

    /**
     * The index's own query string, minus what is not set.
     *
     * Read from the QUERY bag on purpose. That is where the filters actually
     * are: the delete dialog posts a form, and a form's action URL is the only
     * place it can carry them. Laravel's input() would answer the same thing by
     * merging the query over the body, which is a kindness that stops being one
     * the moment a request carries a field called `page` in its body — then a
     * hidden input would decide which page of the table the reviewer lands on.
     *
     * The explicit key list is also what keeps the redirect honest: an absent
     * filter stays absent rather than arriving as an empty one that reads as
     * "search for nothing" to whatever looks at it next, and `_method` never
     * leaks into the URL.
     *
     * @return array<string, mixed>
     */
    private function indexFilters(): array
    {
        return array_intersect_key(
            request()->query->all(),
            array_flip(['search', 'sense', 'page']),
        );
    }

    /**
     * Order a query the way the index lists lines.
     *
     * Numbered lines come first in natural numeric order — "2" precedes "10" —
     * and a service with no number follows them, ordered by code. That needs no
     * special handling here: Line::sortNumber() stores the largest possible integer
     * for a code with no number, so plain ascending code_number already places
     * those rows last. A NULL would not, because PostgreSQL sorts it last and
     * SQLite first.
     *
     * @param  Builder<Line>  $query
     * @param  'asc'|'desc'  $direction
     * @return Builder<Line>
     */
    private function applyIndexOrder(Builder $query, string $direction = 'asc'): Builder
    {
        $query->orderBy('code_number', $direction);
        $query->orderBy('code', $direction);
        $query->orderBy('sense', $direction);

        return $query;
    }

    /**
     * Find the line immediately before or after the given line in index order.
     *
     * The ordering must mirror index() exactly so that prev/next walk the same
     * sequence the user sees in the table.
     *
     * sense is stored as a string in the database but cast to the LineSense
     * enum on the model, hence the ->value access here.
     *
     * Deliberately unpaginated: stepping from the last row of page 1 walks
     * into the first row of page 2 without a discontinuity. A unique index on
     * (code, sense) keeps the three-column tuple unique, so this resolves to
     * exactly one row.
     */
    private function adjacent(Line $line, string $direction): ?Line
    {
        $ascending = $direction === 'next';

        return $this->applyIndexOrder(
            Line::query()->whereRowValues(
                ['code_number', 'code', 'sense'],
                $ascending ? '>' : '<',
                Line::indexOrderValues($line)
            ),
            $ascending ? 'asc' : 'desc'
        )->first(['id', 'code', 'sense']);
    }
}
