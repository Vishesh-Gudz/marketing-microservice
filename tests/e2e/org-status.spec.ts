import { expect, test } from "@playwright/test";
import { localDevAuthConfigured } from "./support";

// Local-only: needs a running Convex backend and `npm run dev:auth setup`
// (which writes NEXT_PUBLIC_DEV_AUTH_TOKEN for org "dev-org" / role "admin").
// Skipped automatically in CI, where neither exists.

test.skip(!localDevAuthConfigured(), "requires local Convex backend + npm run dev:auth setup");

test("resolves the organization from the dev JWT", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Convex: marketing-microservice")).toBeVisible({ timeout: 20_000 });
  const badge = page.getByTestId("org-badge");
  await expect(badge).toContainText("Dev Organization", { timeout: 20_000 });
  await expect(badge).toContainText("admin");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
});
