import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_REVAMP_PORT ?? 3200);
const baseURL = `http://127.0.0.1:${PORT}`;

// Frontend revamp safety net (tests/revamp/README.md). Local only, like the dashboard data
// journeys: it needs the local Convex backend, `npm run dev:auth setup` and `npm run dev:seed`.
// It records how every page looks and who can do what before the redesign changes anything.
// Screenshots are stored per platform; re-record with `npm run test:revamp:update`.
export default defineConfig({
  testDir: "./tests/revamp",
  outputDir: "./test-results/revamp",
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{testFileName}/{arg}{ext}",
  globalSetup: "./tests/revamp/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Each page holds a live Convex subscription and the dev server compiles on demand (see
  // playwright.config.ts); more parallel pages than this time out on typical machines.
  workers: 2,
  timeout: 120_000,
  expect: {
    timeout: 30_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      maxDiffPixelRatio: 0.002,
      stylePath: "./tests/revamp/screenshot.css",
    },
  },
  reporter: "list",
  use: {
    baseURL,
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `npx next dev --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 300_000,
  },
});
