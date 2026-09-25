<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('command_executions', function (Blueprint $table) {
            $table->id();
            $table->string('command');
            $table->timestamp('started_at');
            $table->timestamp('finished_at')->nullable();
            $table->unsignedInteger('duration_ms')->nullable();
            $table->string('status');
            $table->jsonb('options')->nullable();
            $table->jsonb('result')->nullable();
            $table->text('error')->nullable();
            $table->timestamps();

            $table->index('command');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('command_executions');
    }
};
