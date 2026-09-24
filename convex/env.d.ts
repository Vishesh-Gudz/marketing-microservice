// Convex exposes deployment environment variables on `process.env` in all
// runtimes. Declared here so Convex code typechecks without Node typings.
declare const process: { readonly env: Record<string, string | undefined> };
