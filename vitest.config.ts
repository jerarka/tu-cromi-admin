import vue from '@vitejs/plugin-vue';
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
    test: {
        // The route-editing logic is pure functions over coordinate arrays, so
        // it runs in plain node. jsdom is an opt-in dependency and is only
        // worth adding if a component test ever needs a DOM.
        environment: 'node',
        include: ['resources/js/**/*.test.ts'],
    },
});
