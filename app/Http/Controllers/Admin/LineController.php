<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Line\StoreLineRequest;
use App\Http\Requests\Line\UpdateLineRequest;
use App\Models\Line;
use Illuminate\Http\RedirectResponse;
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

        $line = Line::create($data);

        if ($request->filled('geo_json')) {
            DB::statement(
                'UPDATE lines SET geom = ST_GeomFromGeoJSON(geo_json::text) WHERE id = ?',
                [$line->id],
            );
        }

        Inertia::flash('toast', [
            'type' => 'success',
            'message' => __('Line created.'),
        ]);

        return to_route('lines.index');
    }

    public function edit(Line $line): Response
    {
        $line->load('parentLine');

        return Inertia::render('lines/Edit', [
            'line' => $line,
        ]);
    }

    public function update(UpdateLineRequest $request, Line $line): RedirectResponse
    {
        $data = $request->validated();
        if (! empty($data['geo_json'])) {
            $data['geo_json'] = json_decode($data['geo_json'], true);
        }

        $line->update($data);

        if ($request->filled('geo_json')) {
            DB::statement(
                'UPDATE lines SET geom = ST_GeomFromGeoJSON(geo_json::text) WHERE id = ?',
                [$line->id],
            );
        } elseif (array_key_exists('geo_json', $request->validated())) {
            DB::statement('UPDATE lines SET geom = NULL WHERE id = ?', [$line->id]);
        }

        Inertia::flash('toast', [
            'type' => 'success',
            'message' => __('Line updated.'),
        ]);

        return to_route('lines.index');
    }
}
