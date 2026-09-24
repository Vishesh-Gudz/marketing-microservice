import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Two isolated test projects:
// - convex: Convex functions run against convex-test's in-memory backend in the
//   edge-runtime environment (matches Convex's default V8 runtime).
// - unit:   pure TS + React components in jsdom.
// E2E lives in tests/e2e and is run by Playwright, not Vitest.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "convex",
          include: ["convex/**/*.test.ts"],
          environment: "edge-runtime",
          server: { deps: { inline: ["convex-test"] } },
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: "unit",
          include: [
            "app/**/*.test.{ts,tsx}",
            "components/**/*.test.{ts,tsx}",
            "lib/**/*.test.{ts,tsx}",
            "tests/unit/**/*.test.{ts,tsx}",
          ],
          environment: "jsdom",
          setupFiles: ["./tests/setup/unit.ts"],
        },
      },
    ],
  },
});
