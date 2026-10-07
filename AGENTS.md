# tu-cromi-admin

Laravel 13 + Vue 3 + Inertia.js v3 SPA (TypeScript, Tailwind CSS v4, shadcn-vue new-york-v4, PostGIS).

## Commands

| What | Command | Notes |
|---|---|---|
| Dev server | `composer dev` | Laravel Chisel (PHP + Vite + SSR concurrently) |
| Vite only | `npm run dev` | |
| **All PHP checks** | `composer test` | `config:clear` → `lint:check` → `types:check` → `artisan test`. Currently green end to end. |
| PHP tests | `php artisan test --compact` | One test: `--filter=ClassNameOrTestName` |
| PHP lint | `composer lint` | Pint (`laravel` preset) |
| PHP lint check | `composer lint:check` | `pint --parallel --test` |
| PHPStan | `composer types:check` | Level 7 over `app/`, `config/`, `database/`, `routes/` |
| Frontend tests | `npm run test` | `vitest run`. One file: `npm run test -- resources/js/lib/undoStack` |
| Frontend lint | `npm run lint` | ESLint + fix (`lint:check` without fix) |
| Frontend format | `npm run format` | Prettier over `resources/` |
| TypeScript check | `npm run types:check` | `vue-tsc --noEmit` |
| Everything | `composer ci:check` | Runs **both** stacks: frontend lint → format → vue-tsc → vitest → `composer test` |
| Build | `npm run build` | |
| Codegen | `composer codegen` | Regenerates the gitignored `resources/js/{actions,routes,wayfinder}/`. **`--with-form` is not optional** — see below |

Use **npm**, not pnpm. `pnpm-workspace.yaml` exists but the lockfile and CI are npm. `.npmrc` sets `ignore-scripts=true`, so no postinstall hooks run.

## CI

Two workflows, both on push/PR to `develop`/`main`/`master`/`workos`:

- **`.github/workflows/tests.yml`** — PHP **8.3, 8.4 and 8.5** matrix, Node 22, copies `.env.example`. Runs `composer types:check` then `php artisan test`. **PHPStan errors fail CI**, so keep it at zero.
- **`.github/workflows/lint.yml`** — `composer lint`, `npm run format`, `npm run lint` (writes, does not check).

**`.env.example` ships `DB_CONNECTION=sqlite`** but dev and prod are PostgreSQL + PostGIS. Copying it verbatim gives you SQLite, and every spatial query then fails confusingly.

## Domain model — Lines

- **Each `lines` row = one direction** (OUTBOUND or RETURN), not a full line. Real lines ("Línea 1") are two rows sharing a `code`.
- **UNIQUE index on `(code, sense)`** — two rows may share a `code`, never with the same `sense`. Two factory-created lines with a fixed `code` and a random `sense` collide ~50% of the time; pin `->outbound()` / `->return()`.
- `code_number` (NOT NULL) is a **sort key**, not the number: `Line::sortNumber()` writes the numeric prefix of `code`, or `Line::SORT_LAST` (2147483647) when there is none. `lines_sort_index (code_number, code, sense)` makes `"2"` sort before `"22 rojo"`. `code_suffix` was dropped — don't reintroduce it.
- **Not every bus has a number.** A service identified only by the route name painted on it uses a lowercase slug as its `code` (`la-guardia-nueva-terminal`) and puts the rider-facing wording in `name`. `App\Rules\LineCode` accepts either shape and still rejects the `2O rojo` typo. The sentinel keeps numberless rows last on **both** drivers — a NULL there would sort last on PostgreSQL and first on SQLite, and would break `adjacent()`'s row comparison, since a row value containing a NULL compares to NULL. `Line::numberFromCode()` returns `?int` and stays honest about what it found; do not make it return the sentinel.
- Opposite directions link bidirectionally via `parent_line_id`. Circular lines (72, 73) have no counterpart; that is expected, not a bug.
- `geo_json` (JSONB) is the source of truth: MultiLineString `[lng, lat]`. `geom` is derived from it via `ST_GeomFromGeoJSON` and is written **only** by `Line::syncGeometry()` through a raw statement — it does not exist on SQLite.
- **`geometry_adjusted` is a dirty flag, not state**: it marks a line whose geometry a human corrected after import (`applyDirectionOperation()`). When set, previously computed transfer point indices point at different coordinates, so `transfers:compute` must be re-run.
- `LineSense` enum: `Outbound = 'OUTBOUND'` (ida), `Return = 'RETURN'` (vuelta).

## Offline bundle (`lines:export-offline`)

The command writes three files into the bundle's directory and publishes the last two:

- **`data.ndjson.gz`** — the intermediate, and the **contract with the Dart CLI**: one JSON object per line, record order fixed (`meta`, then lines by `id`, then transfers by `(line_a_id, line_b_id, point_a_index, point_b_index)`). Not uploaded: the app no longer reads it.
- **`data.db.gz`** — the gzipped SQLite database the app installs as a file copy. **Only the Flutter app's Dart CLI builds it** (`tools/build_offline_db.dart`, run from the Flutter checkout because `dart run` resolves `package:tu_cromi_app/...` from the working directory). The schema belongs to the app; a PHP-built database would make every schema change a cross-stack change. Needs Dart 3.11+ (not the Flutter SDK) and a checkout where `dart pub get` has run — `OFFLINE_FLUTTER_REPO` or `--flutter-repo=`. On Dart 3.12 the run needs `--enable-experiment=native-assets` (the app's graph reaches `objective_c` via its Apple platform plugins); the command passes it by default and `OFFLINE_DART_RUN_FLAGS` overrides it. **Older than 3.11 cannot build the bundle at all**, and the SDK's error blames the missing experiment flag even when it is present. On Windows a bare `dart` can resolve to an older SDK because PHP's executable lookup skips `.bat` wrappers; set `OFFLINE_DART_BINARY` to the real binary (e.g. Flutter's `bin/dart.bat`) and the command's version preflight will catch the rest.
- **`meta.json`** — the published manifest, written by Laravel after the CLI. Fields: `version` (int, from `--data-version`), `updated_at`, `generated_at`, `total_lines`, `total_transfers` (counts read from the CLI's manifest), `data_bytes`, `data_sha256`. **Every size and hash is of the gzipped `data.db.gz`**, measured on the exact file about to be uploaded. The CLI's own manifest names the size `gz_bytes` and writes `version` as a string — never publish it as-is.

The version has one source of truth: `--data-version` → NDJSON meta record → database `offline_metadata` (stamped by the CLI) → `meta.json`. Bump it and the app's update prompt follows.

- **Ordering must be total.** Ordering transfers by the pair alone leaves ~22 tied rows per pair and the compressed output changes every run. The body is byte-reproducible; only `meta.generated_at` differs between runs, so compare content hashes, not file hashes.
- **Every float is a JSON double, every integer a JSON integer.** `JSON_PRESERVE_ZERO_FRACTION` is what keeps a 0 m transfer emitting `0.0` instead of `0`. Encode through `LinesExportOffline::writeRecord()` — do not call `json_encode` directly for bundle records.
- **`PDO_PGSQL` returns numerics as PHP strings.** Without explicit `(float)` casts, `walk_distance` and the coordinates ship quoted and `(map['walk_distance'] as num)` throws a `TypeError` in Dart. `line_a_id` and the indices arrive as real ints and need no cast.
- `serialize_precision` must be `-1` or ≥ 17; with the legacy default of 6, `json_encode` silently truncates doubles to ~cm. The command corrects it with `ini_set` and only fails if that is rejected.
- Known inconsistency: `average_rating` still ships as a **string**, because Laravel's `decimal:2` cast returns a string by design. `resources/js/types/line.ts` declares it `number | null`, so the admin's type is already wrong. The column is NULL everywhere and nothing writes it.

`EARTH_RADIUS_M` is **6371000.0** (mean radius), not WGS84's 6378137. The app measures with the same value; swapping it shifts every ride by ~0.1%, enough to reorder transfer rankings with no visible failure. Same for the operand order in `GreatCircle::metersBetween()`. Both ride lengths and walk distances come from that one class — see `app/Geo/`.

## Artisan commands

| Command | Purpose |
|---|---|
| `lines:export-offline` | Build the offline bundle: NDJSON intermediate → `data.db.gz` via the Flutter app's Dart CLI → published `meta.json`. `--data-version=N` (required), `--path=` (relative to `storage/app`, default `offline/data.db.gz`; the other two files share its directory), `--flutter-repo=`, `--dart=`, `--skip-dart-cli` (NDJSON only), `--upload`. Needs Dart 3.x and a Flutter checkout with `dart pub get` run (`OFFLINE_FLUTTER_REPO`). |
| `transfers:compute` | Precompute pedestrian transfers. PostGIS `ST_DWithin` 300 m + KNN lateral join, deduped on a 100 m spatial grid. **~17 min.** Logs to `command_executions`. |
| `lines:import` | Import from `database/data/rutas_scz.geojson`. `sentido=1` → OUTBOUND, else RETURN with reversed coordinates. Links opposite directions by `code`. |
| `lines:refresh-geometry` | Rebuild `geom` from `geo_json` after a manual geometry edit. |
| `lines:backfill-sort-keys` | Recompute `code_number`. `--dry-run` reports first. |
| `roads:import-overpass` | Import streets from Overpass for snapping. `--bbox=`, `--tile=`, `--truncate`, `--dry-run`. |
| `roads:self-test` | Exercises the PostGIS snap path against a real instance and rolls back. |

**Destructive by default — read before running:**

- `transfers:compute` **truncates `line_transfers` unconditionally, including with `--limit`**. `--limit=20` still wipes all 1.35M rows and rebuilds from 20 lines. Dump the table first, or run against a scratch database.
- `lines:import --force` requires `--discard-everything` to confirm, because it destroys user data and manual corrections.
- `lines:export-offline --upload` **deletes both R2 objects before uploading either**. A failed upload therefore leaves the bucket with neither, which makes clients fall back to their cached version. That ordering is deliberate: `meta.json` is what advertises a new version, so it must go up after `data.db.gz`, never before.

## Architecture

- **Frontend entry**: `resources/js/app.ts` — layout dispatch, theme init, flash toasts. Boots `initializeTheme()` + `initializeFlashToast()` on every page.
- **Pages**: `resources/js/pages/` auto-discovered by Inertia. Auth under `auth/`, settings under `settings/`.
- **Layouts**: chosen by page name in `app.ts` — `auth/*` → AuthLayout, `settings/*` → AppLayout + SettingsLayout, `Welcome` → none, else AppLayout.
- **`@` alias** → `resources/js/`, declared in `vitest.config.ts` as well as tsconfig, because a test runner does not read tsconfig.
- **`resources/js/lib/`**: pure, framework-free modules — `routeEditing` (geometry + snap decisions), `snapWire`/`snapTransport` (the lat/lng boundary and the street lookup), `mapView`, `undoStack`, `flashToast`, `utils` (`cn()`).
- **`resources/js/composables/`**: Vue-aware shared state — `useRouteGeometry` (shared by the create and edit pages), `useSnapPreset`, `usePropagation`, `useResampleSpacing`, `useAppearance`. Several have colocated `.test.ts` siblings and are testable because they touch no DOM.
- If logic is worth testing, it belongs in one of those two rather than in a component.
- **`app/Geo/`**: pure, framework-free PHP. `GreatCircle` owns the bundle's distance model.
- **`app/Concerns/`**: traits, not services — `ProfileValidationRules`, `PasswordValidationRules`, `UploadsBundleToR2`.
- **Testable geometry belongs in `app/Geo/`, not inside a Command.** A Command's data path is usually PostGIS and therefore unreachable from the SQLite suite; that is why the rounding policy in `walkMeters()` lives on the class.
- **No service layer**: domain logic lives in Models, Commands, and `app/Geo/`.
- **DB**: PostgreSQL + PostGIS (dev/prod), SQLite `:memory:` (tests). Two GIST indexes on `lines`: `geom` and `geography(geom)`.
- **SSR**: enabled, dev server at `127.0.0.1:13714` (`config/inertia.php`).
- **Auth**: Laravel Fortify — registration, password reset, email verification, 2FA, passkeys.
- **Gated pages**: `dashboard` requires `auth` + `verified`.
- **Incomplete**: the `issue_reports` migration exists with no Model or UI.

## Testing quirks

- **PHPUnit classes, not Pest.** `RefreshDatabase`; `skipUnlessFortifyHas()` for conditional Fortify tests.
- **Vitest** for `resources/js/**/*.test.ts`, configured in its own `vitest.config.ts` — a `test` block in `vite.config.ts` would start `php artisan pail`. `environment: 'node'`, so there is no jsdom and **component tests are not possible**; anything worth asserting has to live in `lib/` or `composables/`.
- **PostGIS is untestable on SQLite**: the `roads` table and the snap lookup are PostgreSQL-only, and `ST_DWithin`/`ST_Distance` will fail. `transfers:compute` cannot be tested by the suite at all — it is verified by hand against a real instance (it is deterministic: two runs hash identically).
- **Pin the vectors you assert against.** The line-230 coordinate array in the bundle tests is a hardcoded copy on purpose. Deriving it from the database would make the test unable to detect the drift it exists to catch.
- **Assert against a clock you control** when the code stamps two artifacts at different points; two `now()` calls in a sub-second test land in the same second and the test cannot fail. Freeze with `Carbon::setTestNow()` and advance it from an `eloquent.retrieved` listener.
- **Mutation-check new tests.** Reintroduce the bug and confirm they go red — twice this session, a test passed with the bug present and another shipped a wrong type that only the failing branch reached.

## Conventions

- **Pint after every PHP change**: `vendor/bin/pint --dirty --format agent` (not `--test`).
- **Prettier**: 4-space indent, single quotes, semicolons; YAML 2-space. Ignores `resources/js/components/ui/*`, `resources/views/mail/*`.
- **ESLint**: `1tbs` braces, padding around control statements, sorted imports (builtin → external → internal → parent → sibling → index). Ignores codegen output.
- **shadcn-vue**: `cn()` from `@/lib/utils` (clsx + tailwind-merge), lucide icons.
- **Wayfinder**: controllers from `@/actions/`, named routes from `@/routes/`. Generated dirs are gitignored — regenerate, never edit.
- **`--with-form` is not optional, and running the command without it looks like success.** Seventeen components call `SomeController.method.form()`, which is the `{ action, method }` shape Inertia's `<Form v-bind="…">` takes. Wayfinder emits those helpers only under the `--with-form` flag (`method.blade.ts:77,116`), and without it the generated files come out perfectly well-formed with the helpers simply absent — so the command reports success, and the failure lands later as `vue-tsc` saying `Property 'form' does not exist` in seventeen unrelated-looking files. Measured both directions: without the flag, zero `.form` assignments and 17 type errors; with it, 103 assignments and zero errors. `composer codegen` wraps the flag so the working invocation is the short one.
- **Cookies excluded from encryption**: `appearance`, `sidebar_state` (`bootstrap/app.php`).
- **Passkeys**: `PASSKEYS_USER_HANDLE_SECRET`, falling back to `APP_KEY`.
- **Migrations**: `$table->timestamps()`; `$table->softDeletes()`; `string()` defaults to 255; `foreignId('foo_id')->constrained()` resolves by convention. `numeric` columns come back from PDO as strings — cast at the boundary.

## MCP

`opencode.json` runs the **laravel-boost** MCP server (`php artisan boost:mcp`). Use it for DB schema, application and browser error logs, and version-specific docs. `boost.json` scopes it to opencode.