# tu-cromi-admin

Admin panel for Santa Cruz de la Sierra bus lines: Laravel 13 + Inertia v3 SPA (Vue 3, TypeScript, Tailwind v4, shadcn-vue). PostgreSQL + PostGIS in dev/prod; SQLite `:memory:` in tests.

## Commands

| What | Command |
|---|---|
| Dev (PHP + Vite + SSR) | `composer dev` |
| Vite only | `npm run dev` |
| All PHP checks | `composer test` — `config:clear` -> `lint:check` -> `types:check` -> `artisan test` |
| PHP tests / one test | `php artisan test --compact` / `--filter=ClassNameOrTestName` |
| PHP lint / check | `composer lint` / `composer lint:check` (Pint, `laravel` preset) |
| PHPStan (level 7) | `composer types:check` |
| Frontend tests / one file | `npm run test` / `npm run test -- resources/js/lib/undoStack` |
| ESLint | `npm run lint` (fix) / `npm run lint:check` |
| Prettier | `npm run format` / `npm run format:check` |
| vue-tsc | `npm run types:check` |
| Both stacks | `composer ci:check` |
| Build | `npm run build` |
| Wayfinder codegen | `composer codegen` |

Use npm, not pnpm. `pnpm-workspace.yaml` is leftover; the lockfile and CI are npm. `.npmrc` sets `ignore-scripts=true`, so no postinstall hooks run.

## CI and environment

- `.github/workflows/tests.yml` — PHP 8.3/8.4/8.5, Node 22, copies `.env.example`, runs `composer types:check` then `php artisan test`. PHPStan errors fail CI.
- `.github/workflows/lint.yml` — `composer lint`, `npm run format`, `npm run lint`; it writes formatting but does not verify it, so run these locally.
- `.env.example` ships `DB_CONNECTION=sqlite`, but dev/prod are PostgreSQL + PostGIS. Copying it verbatim makes every spatial query fail confusingly. `phpunit.xml` also forces SQLite `:memory:`.

## Layout and boundaries

- `resources/js/lib/` — pure, framework-free, unit-tested decision logic: `routeEditing`, `guidedRouting`, `cruzeroRoute`, `lineDeletion`, `shortcuts`, `snapWire`/`snapTransport`, `undoStack`, `mapView`, `utils`.
- `resources/js/composables/` — Vue-aware shared state: `useRouteGeometry` (shared by create + edit), `useSnapPreset`, `useResampleSpacing`, `usePropagation`, `useAppearance`.
- `app/Geo/` — pure PHP: `GreatCircle` owns every distance, `Router` is the A*. `app/Concerns/` holds traits, not services. Domain logic lives in models, commands and `app/Geo/`; there is no service layer.
- If logic is worth testing, it belongs in `lib/`/`composables/` or `app/Geo/`, not in a `.vue` or a Command.
- Pages are auto-discovered under `resources/js/pages`; `app.ts` dispatches the layout by page name. `@` maps to `resources/js/` in both `tsconfig.json` and `vitest.config.ts`.
- `issue_reports` has a migration but no model or UI — it is intentionally incomplete.

## Lines domain

- One `lines` row is one DIRECTION (`OUTBOUND`/`RETURN`), not a route. The two rows of "Linea 1" share `code`; UNIQUE is `(code, sense)`. A factory line with a fixed code and random sense collides ~50% of the time — pin `->outbound()` / `->return()`.
- `code` is either a number plus optional suffix (`"22 rojo"`) or a lowercase slug for a bus with no number (`"la-guardia-nueva-terminal"`). `App\Rules\LineCode` accepts both shapes and rejects `2O rojo`.
- `code_number` is a sort key, not the number: `Line::sortNumber()` writes the numeric prefix, or `Line::SORT_LAST` (2147483647) for numberless codes. The sentinel, not NULL, keeps numberless rows last on both drivers and keeps `adjacent()`'s row comparison valid.
- `parent_line_id` links opposite directions bidirectionally; circular lines (72, 73) legitimately have no counterpart.
- `geo_json` (JSONB) is the source of truth: MultiLineString `[lng, lat]`. `geom` is derived, PostGIS-only, and written only by `Line::syncGeometry()`; it does not exist on SQLite.
- `geometry_adjusted` is a dirty flag meaning a human corrected the geometry after import — not state. When set, transfer point indices are stale: re-run `transfers:compute`. `lines:refresh-geometry` clears it.
- `average_rating` is cast `decimal:2`, so PDO returns a string while `resources/js/types/line.ts` declares `number | null`. The column is NULL everywhere today.

## Map editor

- Four modes: move / add / guide / delete (`RouteModePicker`, `LineMap.vue`, `pages/lines/{Create,Edit}.vue`).
- Geometry is a single-member `MultiLineString` everywhere. Wrap incoming `LineString` payloads in the converter — never loosen `GeoJsonMultiLineString`; `GreatCircle::forGeometry()` assumes two levels of nesting.
- Snap/relay/continue are `POST /roads/{snap,relay,continue}`; decisions are pure in `routeEditing` (`decideSnap`, `snapSample`, `propagateAlongStreet`). Presets are off/subtle/normal/aggressive = 30/50/100 m; `snapSearchRadius` doubles the threshold and `SnapRoadRequest` caps at 200 m. Resample presets are 100/150/200/300 m.
- Undo is a `History<T>` in `lib/undoStack`. Both the map and the page listen for `Ctrl+Z`/Escape and stand down on `defaultPrevented`; `isTextEntryTarget()` is checked first so a text field keeps its own keys.
- Shortcuts live in `lib/shortcuts.ts` (`resolveShortcut` is pure): `1`-`4` modes, `E` toggles the editor, `Enter` accepts a guided offer, `Delete`/`Backspace` removes the selection. Bindings are bare keys only; focus (including `BUTTON` and `role=listbox|option`) disables them; `Enter`/`Delete` only exist where their button is rendered. The help text is asserted against the table by tests — add a shortcut and its help together.

## Guided mode (`guide`)

- State machine: `lib/guidedRouting.ts`. The map owns placement and selection; the page owns waypoints.
- Waypoints are the persisted recipe (`line_waypoints`), admin-only, max 200. The form posts `waypoints` only when the visit actually touched guide mode (`waypointsTouched`); an absent field means "leave the stored recipe alone", while `'[]'` means "clear it" — do not collapse an empty list to `null`.
- `ordinal`/`role` are derived server-side from array order; client values are ignored. `WaypointsPayload::decode()` casts positions to float.
- Controls snap to the route; a control with no vertex within 25 m is detached (amber pill), not auto-repaired. `spliceTramo()` drops only the router answer's first point.
- Routing is simplified per leg by `simplifyRoutedChain()`: Douglas-Peucker with `ROUTED_SIMPLIFY_TOLERANCE_METERS = 5`, plus a span rule `ROUTED_MAX_SPAN_METERS` (= `Math.min(...RESAMPLE_SPACING_METERS)`, currently 100, pinned by a literal test). The preview always reports dropped vertex count and max deviation.
- Call `dismissPendingPreview()` before any mutation of the pending anchor batch. The batch has its own undo history; `Ctrl+Z` while it is pending steps the clicks, not the page.
- `renderMap()` repaints control markers (the watcher does not fire on mount). Guide mode draws no vertex markers; a selected control fills green. The toolbar must not wrap (`nowrap` + horizontal scroll) or the fixed-height map jumps mid-gesture.
- "Remove control" is always shown; it refuses only when nothing is selected. Removing an end control changes no geometry.

## Pasting a Cruzero route

- Parsed in `lib/cruzeroRoute.ts`. The payload is a GeoJSON `LineString`; the converter wraps it as one part of a MultiLineString.
- Direction comes from the `_i_`/`_v_` token inside `trip_id`, not from `CLOCKWISE`/`COUNTERCLOCKWISE` — a real pair is traced separately, not reversed.
- Use the dedicated paste field, not the `geo_json` textarea: their payload has no top-level `.coordinates`, so pasted there the route vanishes with no error.
- The converter refuses transposed lat/lng via the bounding box and refuses `intermediate[]` (stops) by name. Converting writes nothing, records an undo entry, and leaves the save-time consequences (stale transfers, stale recipe) to Save.

## Deleting a line

- `destroy()` deletes one DIRECTION; the counterpart survives with `parent_line_id` NULL. `counterpart()` resolves by code + sense, so that column is only a cache.
- No manual child cleanup: FKs cascade `line_waypoints`, `favorites`, `reviews` and `line_transfers`, and null `issue_reports.line_id`.
- The index filters ride the delete request's query string and are intersected in the controller (`request()->query->all()`, never `only()`); `_method` never leaks into the redirect.
- Dialog copy lives in `lib/lineDeletion.ts` because it is mounted from both the index and the edit page. Deleting does not reach riders until `lines:export-offline --data-version=N --upload` is re-run.

## Road graph and router

- `roads` serves two consumers: snapping refuses `_link` roads (`NOT LIKE '%\_link'` in every `RoadsController` query); the routing graph imports and uses them. Keep those clauses.
- `roads:build-graph` derives `road_nodes`/`road_edges` from `roads`; node identity is an exact coordinate (1e-7 key). Imports truncate with CASCADE, so rebuild the graph after every import; never hand-edit it.
- Turn restrictions are parsed by `App\Osm\TurnRestriction`: relations with `except=bus/psv/motor_vehicle/motorcar` are skipped (buses may turn), `via`-way restrictions are skipped and counted, and `via` travels as a coordinate.
- `App\Geo\Router` is edge-state A*: cost = length x class multiplier + turn penalties (free <=15 degrees, 20 m for a turn, 500 m for a U-turn). Keep the multiplier >= 1.0 or the heuristic stops being admissible. The 500 m U-turn was chosen against a failing fixture — do not lower it without a new failing case.
- The corridor loads only edges whose BOTH endpoints sit in the bbox (padded by max(300 m, 25%)). Refusals are HTTP 200 `status: none` with `origin-too-far`/`destination-too-far`/`no-path`/`budget`; 404 only when `road_edges` is empty.
- Origin snapping accepts a `bearing` and prefers the correctly-headed carriageway (1 m penalty per degree of disagreement).

## Offline bundle (`lines:export-offline`)

- Three files: `data.ndjson.gz` (intermediate / contract with the Dart CLI, not uploaded), `data.db.gz` (built only by the Flutter app's `tools/build_offline_db.dart`), and `meta.json` (published manifest). Version chain: `--data-version` -> NDJSON meta -> SQLite `offline_metadata` -> `meta.json`.
- Needs Dart 3.11+ from a Flutter checkout with `dart pub get` (`OFFLINE_FLUTTER_REPO`). Dart 3.12 needs `--enable-experiment=native-assets` (passed by default via `OFFLINE_DART_RUN_FLAGS`). On Windows set `OFFLINE_DART_BINARY` to the real `dart.bat`; PHP's executable lookup skips `.bat` wrappers.
- Record order must be total (lines by id, transfers by all four keys). Floats must stay floats (`JSON_PRESERVE_ZERO_FRACTION`, `serialize_precision` -1 or >=17), and PDO numeric strings need `(float)` casts — encode via `LinesExportOffline::writeRecord()`, not `json_encode`.
- `meta.json` sizes/hashes are of the gzipped `data.db.gz`; do not publish the Dart CLI's manifest directly (`gz_bytes`, string version).
- `--upload` deletes both R2 objects before uploading either, then uploads the bundle before the manifest. That order is deliberate; a failed upload leaves clients on their cached bundle.

## Artisan commands

| Command | Notes |
|---|---|
| `lines:export-offline` | `--data-version=N` (required), `--path=`, `--flutter-repo=`, `--dart=`, `--skip-dart-cli`, `--upload`. See bundle section. |
| `transfers:compute` | PostGIS `ST_DWithin` 300 m + KNN, deduped on a 100 m grid. **Truncates `line_transfers` unconditionally, even with `--limit`** — `--limit=20` still wipes all rows. Long-running. |
| `lines:import` | Imports `database/data/rutas_scz.geojson`; `sentido=1` -> OUTBOUND, else RETURN with reversed coordinates; links pairs by code. `--force` requires `--discard-everything` and destroys user data/manual corrections. |
| `lines:refresh-geometry` | `{code}` restores that line's geometry from the source GeoJSON, discarding manual corrections and clearing `geometry_adjusted`. Import never overwrites geometry on its own. |
| `lines:backfill-sort-keys` | Recomputes `code_number`; supports `--dry-run`. |
| `roads:import-overpass` | Drivable ways including `*_link`, plus turn restrictions. `--bbox=`, `--pad=0.02`, `--tile=0.1`, `--truncate`, `--dry-run`. Upserts by `osm_id`; rebuild the graph afterwards. |
| `roads:build-graph` | Truncate-and-rebuild `road_nodes`/`road_edges`, ~20 s. |
| `roads:self-test` | Exercises PostGIS snap/relay/continue paths against a real instance and rolls back; needs `--force` outside development. |

## Distance model

`App\Geo\GreatCircle` is the single source: `EARTH_RADIUS_M = 6371000.0` (mean radius, deliberately not WGS84's 6378137), `METRES_PER_DEGREE_LATITUDE`, and `metresPerDegreeLongitude()` (cosine, floored at 1%). Transit consumers assume the mean radius; changing it silently reorders transfers. `TransfersCompute`'s grid cell is deliberately a different, equator-derived quantity.

## Testing

- PHPUnit classes, not Pest. `RefreshDatabase`; `skipUnlessFortifyHas()` for conditional Fortify features.
- Vitest has its own config (`vitest.config.ts`, `environment: 'node'`) because `vite.config.ts` would spawn `php artisan pail`. No jsdom means component tests are impossible — anything worth asserting must be importable from `lib/`/`composables`.
- PostGIS paths (`roads` snap lookups, `transfers:compute`) cannot run on SQLite. Exception: `/roads/route` uses plain-column graph tables and is tested end to end by `RouteRoadTest`; the spatial corridor is covered by `roads:self-test`.
- Pin the vectors you assert against (hardcoded coordinate arrays beat recomputing from the database).
- When code stamps two artifacts, freeze the clock with `Carbon::setTestNow()`; two `now()` calls in a fast test land in the same second and the test cannot fail.
- Mutation-check new tests: reintroduce the bug and confirm they go red.

## Conventions

- Pint after every PHP change: `vendor/bin/pint --dirty --format agent`.
- Prettier: 4 spaces, single quotes, semicolons, print width 80; YAML 2 spaces. Ignores shadcn `ui/*` and mail views.
- ESLint: `curly: all`, `1tbs`, blank lines around control statements, sorted imports, top-level type imports.
- shadcn-vue components with `cn()` from `@/lib/utils` and lucide icons.
- Wayfinder: import controllers from `@/actions`, routes from `@/routes`; generated dirs are gitignored. `composer codegen` must keep `--with-form` — without it generation succeeds but 18 components fail `vue-tsc` on `Property 'form' does not exist`.
- Cookies excluded from encryption: `appearance`, `sidebar_state`. Passkeys use `PASSKEYS_USER_HANDLE_SECRET`, falling back to `APP_KEY`.
- Migrations: `timestamps()`, `softDeletes()` where needed, `string()` defaults to 255, `foreignId()->constrained()` by convention. `numeric` columns arrive from PDO as strings — cast at the boundary.

## MCP

`opencode.json` runs the laravel-boost MCP server (`php artisan boost:mcp`); use it for DB schema, application/browser logs, and version-specific docs. `boost.json` scopes it to opencode.
