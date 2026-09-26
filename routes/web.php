<?php

use App\Http\Controllers\Admin\LineController;
use App\Http\Controllers\Admin\RoadsController;
use Illuminate\Support\Facades\Route;

Route::inertia('/', 'Welcome')->name('home');

Route::middleware(['auth', 'verified'])->group(function () {
    Route::inertia('dashboard', 'Dashboard')->name('dashboard');

    Route::get('/lines', [LineController::class, 'index'])->name('lines.index');
    Route::get('/lines/create', [LineController::class, 'create'])->name('lines.create');
    Route::post('/lines', [LineController::class, 'store'])->name('lines.store');
    Route::get('/lines/{line}/edit', [LineController::class, 'edit'])->name('lines.edit');
    Route::patch('/lines/{line}/directions', [LineController::class, 'directions'])->name('lines.directions');
    Route::post('/lines/{line}/refresh-geometry', [LineController::class, 'refreshGeometry'])->name('lines.refresh-geometry');
    Route::put('/lines/{line}', [LineController::class, 'update'])->name('lines.update');

    Route::post('/roads/snap', [RoadsController::class, 'snap'])->name('roads.snap');
});

require __DIR__.'/settings.php';
