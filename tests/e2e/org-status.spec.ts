import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// Local-only: needs a running Convex backend and `npm run dev:auth setup`
// (which writes NEXT_PUBLIC_DEV_AUTH_TOKEN for org "dev-org" / role "admin").
// Skipped automatically in CI, where neither exists.

function localDevAuthConfigured(): boolean {
  if (process.env.CI) return false;
  const envPath = join(process.cwd(), ".env.local");
  return (
    existsSync(envPath) && /^NEXT_PUBLIC_DEV_AUTH_TOKEN=.+$/m.test(readFileSync(envPath, "utf8"))
  );
}

test.skip(!localDevAuthConfigured(), "requires local Convex backend + npm run dev:auth setup");

test("resolves the organization from the dev JWT", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Convex: marketing-microservice")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Dev Organization")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("admin", { exact: true })).toBeVisible();
  await expect(page.getByText(/dev-org @ https:\/\/dev-issuer\.marketing\.local/)).toBeVisible();
});
