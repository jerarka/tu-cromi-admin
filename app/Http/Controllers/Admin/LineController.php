<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Line\UpdateLineRequest;
use App\Models\Line;
use Illuminate\Http\RedirectResponse;
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

    public function edit(Line $line): Response
    {
        $line->load('parentLine');

        return Inertia::render('lines/Edit', [
            'line' => $line,
        ]);
    }

    public function update(UpdateLineRequest $request, Line $line): RedirectResponse
    {
        $line->update($request->validated());

        Inertia::flash('toast', [
            'type' => 'success',
            'message' => __('Line updated.'),
        ]);

        return to_route('lines.index');
    }
}
