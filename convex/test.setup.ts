/// <reference types="vite/client" />

// Module map handed to convex-test so it can load our Convex functions.
// Excludes files with more than one dot (e.g. *.test.ts, *.d.ts, test.setup.ts),
// which Convex itself also ignores when deploying.
export const modules = import.meta.glob(["./**/*.*s", "!./**/*.*.*s"]);
