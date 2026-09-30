import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations, localDevAuthConfigured } from "./support";

// CI-safe (Phase 10 Stage B, B3): needs only the Next.js dev server. Without a backend or
// token the organic pages still render the shell, navigation and the org gate.

test("navigates to the organic page and keeps the global filters", async ({ page }) => {
  await page.goto("/?preset=last_7_days");
  const nav = page.getByRole("navigation", { name: "Main" }).first();
  await nav.getByRole("link", { name: "Organic" }).click();
  await expect(page).toHaveURL(/\/social\?preset=last_7_days$/);
  await expect(nav.getByRole("link", { name: "Organic" })).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveTitle("Organic · Marketing Microservice");
});

test("the organic page shows the sign-in gate without a token", async ({ page }) => {
  test.skip(localDevAuthConfigured(), "a local dev token is configured");
  await page.goto("/social");
  await expect(page.getByText("Not signed in")).toBeVisible();
});

test("a post page renders inside the dashboard shell", async ({ page }) => {
  await page.goto("/social/posts/not-a-real-id");
  await expect(page.getByRole("navigation", { name: "Main" }).first()).toBeVisible();
  await expect(
    page
      .getByText("Not signed in")
      .or(page.getByText("This item does not exist or is not available"))
      .first(),
  ).toBeVisible({ timeout: 30_000 });
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("reaches the organic page through the menu sheet", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open menu" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("link", { name: "Organic" }).click();
    await expect(page).toHaveURL(/\/social$/);
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("main")).toBeVisible();
  });
});

test("the post page has no serious accessibility violations", async ({ page }) => {
  await page.goto("/social/posts/not-a-real-id");
  await expect(
    page
      .getByText("Not signed in")
      .or(page.getByText("This item does not exist or is not available"))
      .first(),
  ).toBeVisible({ timeout: 30_000 });
  await expectNoSeriousA11yViolations(page);
});
