import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Deliberately a separate file from vite.config.ts rather than a `test` block
 * merged into it.
 *
 * vite.config.ts registers laravel({ refresh: true }), which spawns
 * `php artisan pail` as a file watcher. Inheriting that config would start a
 * log server on every `vitest run`. Isolating the file keeps the Laravel plugin
 * out of the test pipeline entirely.
 *
 * @vitejs/plugin-vue is carried over so component tests can be added later
 * without another config change.
 */
export default defineConfig({
    plugins: [vue()],
    resolve: {
        // Stated rather than inherited. vite.config.ts has no `resolve.alias`
        // for it either, and the app resolves `@/` through Vite's tsconfig
        // awareness; a test runner does not. Without this line a test file
        // outside resources/js/lib — the composables, say — cannot import the
        // module it is testing, and the only way round it is a relative path
        // that the rest of the codebase does not use.
        alias: {
            '@': fileURLToPath(new URL('./resources/js', import.meta.url)),
        },
    },
    test: {
        // The route-editing logic is pure functions over coordinate arrays, so
        // it runs in plain node. jsdom is an opt-in dependency and is only
        // worth adding if a component test ever needs a DOM.
        environment: 'node',
        include: ['resources/js/**/*.test.ts'],
    },
});
