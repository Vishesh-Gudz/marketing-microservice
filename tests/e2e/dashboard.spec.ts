import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations, localDevAuthConfigured } from "./support";

// CI-safe: needs only the Next.js dev server. Without a backend or token the shell,
// navigation and the org gate still render; with local dev auth the pages render data.

const PAGES = [
  { path: "/", link: "Overview" },
  { path: "/campaigns", link: "Campaigns" },
  { path: "/breakdowns", link: "Breakdowns" },
  { path: "/conversions", link: "Conversions" },
  { path: "/accounts", link: "Accounts" },
];

test("navigates between dashboard pages and keeps the global filters", async ({ page }) => {
  await page.goto("/?preset=last_7_days");
  const nav = page.getByRole("navigation", { name: "Main" }).first();
  await expect(nav.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "Campaigns" }).click();
  await expect(page).toHaveURL(/\/campaigns\?preset=last_7_days$/);
  await expect(nav.getByRole("link", { name: "Campaigns" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page).toHaveTitle("Campaigns · Marketing Microservice");
});

test("shows the sign-in gate without a token", async ({ page }) => {
  test.skip(localDevAuthConfigured(), "a local dev token is configured");
  await page.goto("/");
  await expect(page.getByText("Not signed in")).toBeVisible();
});

test("offers a skip link to the main content", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await skip.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
});

test("renders a not-found page for unknown routes", async ({ page }) => {
  const response = await page.goto("/does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("uses a menu sheet instead of the sidebar", async ({ page }) => {
    await page.goto("/");
    const menu = page.getByRole("button", { name: "Open menu" });
    await expect(menu).toBeVisible();
    await menu.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("link", { name: "Breakdowns" }).click();
    await expect(page).toHaveURL(/\/breakdowns$/);
    await expect(dialog).toBeHidden();
  });
});

test.describe("accessibility (axe: no serious or critical violations)", () => {
  for (const { path } of PAGES) {
    test(path, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("main")).toBeVisible();
      // Settle: either the gate message or the page heading.
      await expect(
        page
          .getByText("Not signed in")
          .or(page.getByRole("heading", { level: 1 }))
          .first(),
      ).toBeVisible({ timeout: 20_000 });
      await expectNoSeriousA11yViolations(page);
    });
  }
});
