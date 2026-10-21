import { createServer } from "node:net";
import { defineConfig, devices } from "@playwright/test";
import { assertLocalSetup, E2E_PORT } from "./scripts/e2e-connections.mjs";

// The Connections journeys: Google Ads (tests/e2e/connections-journey.spec.mts, throwaway org
// "e2e-google-ads") and Meta Ads (tests/e2e/meta-ads-journey.spec.mts, throwaway org
// "e2e-meta-ads"). LOCAL ONLY and opt-in. They drive the real dashboard against the local
// Convex backend in mock provider mode (see docs/dashboard.md "Tests"):
//
//   E2E_CONNECTIONS_JOURNEY=1 npm run test:e2e:connections             # both journeys
//   E2E_CONNECTIONS_JOURNEY=1 npm run test:e2e:connections -- meta-ads-journey   # Meta only
//
// Port 3000 because only localhost:3000 / 127.0.0.1:3000 are allowlisted OAuth return URLs for
// the dev app. The journey starts its own Next dev server and never reuses a running one (the
// developer's dashboard acts as dev-org). Traces, screenshots and videos are off: they could
// capture tokens or OAuth state.

if (process.env.CI) throw new Error("The Connections journey is local-only; it never runs in CI.");
if (process.env.E2E_CONNECTIONS_JOURNEY !== "1") {
  throw new Error(
    "The Connections journey is opt-in: set E2E_CONNECTIONS_JOURNEY=1 (local development only).",
  );
}

function assertPortFree(port: number, host?: string) {
  return new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(
          `E2E guard: port ${port} is in use. Stop the dashboard dev server first; the journey never reuses a running server.`,
        ),
      ),
    );
    server.listen(port, host, () => server.close(() => resolve()));
  });
}

// Guards run once, in the runner process, before Playwright starts the web server (workers
// load this file too, while the journey's own server already holds the port): loopback URLs,
// a local mock deployment behind the Convex CLI, the dashboard pointing at that same
// deployment, and a free port.
if (process.env.TEST_WORKER_INDEX === undefined) {
  await assertLocalSetup();
  await assertPortFree(E2E_PORT, "127.0.0.1");
  await assertPortFree(E2E_PORT);
}

const baseURL = `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["connections-journey.spec.mts", "meta-ads-journey.spec.mts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: "list",
  timeout: 180_000,
  use: { baseURL, trace: "off", screenshot: "off", video: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Loopback only: the server is not reachable from other machines while the journey runs.
    command: `npx next dev --hostname 127.0.0.1 --port ${E2E_PORT}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
