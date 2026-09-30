import { expect, test, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations, localDevAuthConfigured } from "./support";

// Local-only end-to-end flows over seeded mock data. Prerequisites:
//   npm run dev:backend        (local Convex backend)
//   npm run dev:auth setup     (dashboard token for "dev-org")
//   npm run dev:seed           (mock Meta + Google Ads accounts, synced)
// then: E2E_DASHBOARD_DATA=1 npx playwright test dashboard-data
// Skipped in CI and unless E2E_DASHBOARD_DATA=1 (the seed depends on a local backend).

test.skip(
  !localDevAuthConfigured() || process.env.E2E_DASHBOARD_DATA !== "1",
  "requires local backend + dev auth + npm run dev:seed, and E2E_DASHBOARD_DATA=1",
);

const DATA_TIMEOUT = 30_000;

async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
}

test("overview shows KPIs, notices and reacts to the date preset", async ({ page }) => {
  await page.goto("/");
  const totals = page.getByTestId("overview-totals");
  await expect(totals).toBeVisible({ timeout: DATA_TIMEOUT });
  await expect(totals.getByRole("heading", { level: 3 })).toHaveCount(10);
  await expect(totals.locator('[data-kpi="impressions"]')).toContainText(/\d/);

  await choose(page, "Date range", "Last 7 days");
  await expect(page).toHaveURL(/preset=last_7_days/);
  await expect(page.getByTestId("resolved-range")).toContainText("compared with");
  // The previous 7 days are synced too, so comparison chips carry a percentage.
  await expect(totals.locator("[data-slot=delta]").filter({ hasText: "%" }).first()).toBeVisible({
    timeout: DATA_TIMEOUT,
  });
  await expect(page.getByRole("figure", { name: "Spend by platform" })).toBeVisible();
  await expect(page.getByTestId("freshness")).toContainText("Data through");

  // The seeded accounts use USD, IDR and JPY without exchange rates: spend cannot be charted
  // in one currency, impressions can.
  await choose(page, "Chart metric", "Impressions");
  await expect(page.getByRole("img", { name: /Impressions by day/ })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test("a too-long custom range is rejected before it reaches the API", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("overview-totals")).toBeVisible({ timeout: DATA_TIMEOUT });
  await choose(page, "Date range", "Custom range");
  const range = page.getByRole("group", { name: "Custom date range" });
  await range.getByLabel("From").fill("2024-01-01");
  await range.getByLabel("To").fill("2026-01-01");
  await expect(range.getByRole("alert")).toContainText("at most 400 days");
  await expect(range.getByRole("button", { name: "Apply" })).toBeDisabled();
});

test("campaigns sort on the server and drill down to ad groups and ads", async ({ page }) => {
  await page.goto("/campaigns?preset=last_7_days");
  const table = page.getByRole("table", { name: "Campaigns" });
  await expect(table.locator("tbody tr").first()).toBeVisible({ timeout: DATA_TIMEOUT });
  await expect(page.getByRole("columnheader", { name: /Spend/ })).toHaveAttribute(
    "aria-sort",
    "descending",
  );

  await page.getByRole("columnheader", { name: /Name/ }).getByRole("button").click();
  await expect(page).toHaveURL(/sort=name&dir=asc/);
  await expect(page.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  const names = await table.locator("tbody tr td:first-child a").allTextContents();
  expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

  await table.locator("tbody tr td:first-child a").first().click();
  // The first visit compiles the dynamic route in dev mode.
  await expect(page).toHaveURL(/\/campaigns\/[^/?]+\?preset=last_7_days$/, {
    timeout: DATA_TIMEOUT,
  });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: DATA_TIMEOUT });
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Campaigns");
  await expect(page.getByTestId("entity-totals")).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await expect(page.getByRole("tab", { name: "Ad groups" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const adGroups = page.getByRole("table", { name: "Ad groups" });
  const adGroupLink = adGroups.locator("tbody tr td:first-child a").first();
  await expect(adGroupLink).toBeVisible({ timeout: DATA_TIMEOUT });
  await adGroupLink.click();
  await expect(page).toHaveURL(/\/campaigns\/[^/]+\/ad-groups\/[^/?]+/, {
    timeout: DATA_TIMEOUT,
  });
  await expect(page.getByRole("tab", { name: "Ads" })).toHaveAttribute("aria-selected", "true", {
    timeout: DATA_TIMEOUT,
  });
  await expect(page.getByRole("table", { name: "Ads" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link")).toHaveCount(
    2,
  );
});

test("an unknown campaign id renders Not found", async ({ page }) => {
  await page.goto("/campaigns/not-a-real-id");
  await expect(page.getByText("This item does not exist or is not available")).toBeVisible({
    timeout: DATA_TIMEOUT,
  });
  // Rendered inside the dashboard shell.
  await expect(page.getByRole("navigation", { name: "Main" }).first()).toBeVisible();
});

test("breakdown tabs live in the URL", async ({ page }) => {
  await page.goto("/breakdowns");
  await expect(page.getByTestId("breakdown-platform")).toBeVisible({ timeout: DATA_TIMEOUT });
  await page.getByRole("tab", { name: "By placement" }).click();
  await expect(page).toHaveURL(/tab=placement/);
  await expect(page.getByTestId("breakdown-placement")).toBeVisible({ timeout: DATA_TIMEOUT });
  await expectNoSeriousA11yViolations(page);
});

test("conversions keep attribution windows separate", async ({ page }) => {
  await page.goto("/conversions");
  const table = page.getByTestId("actions-table");
  await expect(table).toBeVisible({ timeout: DATA_TIMEOUT });
  // Grouped by action type; every row is exactly one attribution window.
  await expect(table.locator("[data-action-type]").first()).toBeVisible();
  const rows = table.locator("tbody tr[data-window]");
  expect(await rows.count()).toBeGreaterThan(0);
  const windows = await rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-window")));
  expect(windows.every((w) => typeof w === "string" && w.length > 0)).toBe(true);
  await expect(
    page.getByText("Attribution windows and action types are never added together"),
  ).toBeVisible();

  // URL-driven state: the checkbox reflects the URL after navigation.
  const primaryOnly = page.getByLabel("Primary conversions only");
  await primaryOnly.click();
  await expect(page).toHaveURL(/primaryOnly=1/);
  await expect(primaryOnly).toBeChecked();
  await expectNoSeriousA11yViolations(page);
});

test("accounts list the seeded accounts with coverage", async ({ page }) => {
  await page.goto("/accounts");
  const rows = page.locator("[data-account-id]");
  await expect(rows.first()).toBeVisible({ timeout: DATA_TIMEOUT });
  expect(await rows.count()).toBeGreaterThanOrEqual(4);
  await expect(page.getByText("Acme Retail US")).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});
