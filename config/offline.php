<?php

return [
    /*
     * Absolute path to the Flutter app checkout that owns
     * `tools/build_offline_db.dart`. `lines:export-offline` needs it to build
     * the published SQLite bundle, and it must be a checkout where
     * `dart pub get` has run, because the CLI imports `package:tu_cromi_app/`.
     * `--flutter-repo` overrides it per invocation.
     */
    'flutter_repo' => env('OFFLINE_FLUTTER_REPO'),

    /*
     * Dart executable that runs the CLI. Plain Dart is enough: the CLI uses
     * `sqflite_common_ffi`, not `package:sqflite`, so no Flutter SDK is
     * involved. It must be Dart 3.11 or newer, and on Windows a bare `dart`
     * may resolve to an older SDK because PHP's executable lookup skips .bat
     * wrappers — point this at the real binary when that happens.
     */
    'dart_binary' => env('OFFLINE_DART_BINARY', 'dart'),

    /*
     * Extra VM options for `dart run`, inserted after `run` and before the
     * script path. The app's dependency graph reaches `objective_c` through
     * its Apple platform plugins, and on Dart 3.12 that package requires the
     * native-assets experiment; without it `dart run` aborts before the CLI
     * runs. Set this empty once your SDK graduates the feature.
     */
    'dart_run_flags' => env('OFFLINE_DART_RUN_FLAGS', '--enable-experiment=native-assets'),
];
