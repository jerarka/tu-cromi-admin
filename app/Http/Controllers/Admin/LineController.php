<?php

namespace App\Http\Controllers\Admin;

use App\Enums\DirectionOperation;
use App\Http\Controllers\Controller;
use App\Http\Requests\Line\DirectionOperationRequest;
use App\Http\Requests\Line\StoreLineRequest;
use App\Http\Requests\Line\UpdateLineRequest;
use App\Models\Line;
use Illuminate\Console\Command;
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

        $lines = Line::query()
            ->when($search, fn ($q) => $q->where(function ($q) use ($search) {
                $q->where('code', 'like', "%{$search}%")
                    ->orWhere('name', 'like', "%{$search}%");
            }))
            ->when($sense, fn ($q) => $q->where('sense', $sense))
            ->orderBy('code_number')
            ->orderBy('code')
            ->orderBy('sense')
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
        });

        Inertia::flash('toast', [
            'type' => 'success',
            'message' => __('Line updated.'),
        ]);

        return to_route('lines.index');
    }

    /**
     * Find the line immediately before or after the given line in index order.
     *
     * The ordering must mirror index() exactly so that prev/next walk the same
     * sequence the user sees in the table. It is natural, not lexicographic:
     * code_number is an integer column so "2" precedes "10". The suffix needs
     * no column — within a number a bare code is a strict prefix of the
     * suffixed ones, so ordering by `code` next already yields "22",
     * "22 amarillo", "22 rojo". `code` is NOT NULL, so PostgreSQL and SQLite
     * cannot disagree on where a missing value lands.
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

        return Line::query()
            ->whereRowValues(
                ['code_number', 'code', 'sense'],
                $ascending ? '>' : '<',
                [$line->code_number, $line->code, $line->sense->value]
            )
            ->orderBy('code_number', $ascending ? 'asc' : 'desc')
            ->orderBy('code', $ascending ? 'asc' : 'desc')
            ->orderBy('sense', $ascending ? 'asc' : 'desc')
            ->first(['id', 'code', 'sense']);
    }
}
