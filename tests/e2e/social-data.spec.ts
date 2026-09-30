import { expect, test, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations, localDevAuthConfigured } from "./support";

// Local-only organic Instagram flows over seeded MOCK data (Phase 10 Stage B, B3). No real
// Instagram account is involved. Prerequisites:
//   npm run dev:backend        (local Convex backend, PROVIDER_MODE unset = mock)
//   npm run dev:auth setup     (dashboard token for "dev-org")
//   npm run dev:seed           (also connects the mock Instagram users "1" and "small")
// then: E2E_DASHBOARD_DATA=1 npx playwright test social-data
// Skipped in CI and unless E2E_DASHBOARD_DATA=1 (the seed depends on a local backend).

test.skip(
  !localDevAuthConfigured() || process.env.E2E_DASHBOARD_DATA !== "1",
  "requires local backend + dev auth + npm run dev:seed, and E2E_DASHBOARD_DATA=1",
);

const DATA_TIMEOUT = 30_000;

async function choose(page: Page, label: string, option: string | RegExp) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
}

test("organic KPIs, UTC presets, single-day engagement rate and the series", async ({ page }) => {
  await page.goto("/social?preset=last_30_days");
  const totals = page.getByTestId("organic-totals");
  await expect(totals).toBeVisible({ timeout: DATA_TIMEOUT });
  await expect(page.getByTestId("day-basis")).toContainText("Account metrics use UTC days");
  await expect(totals.locator('[data-kpi="views"]')).toContainText(/\d/);
  // Unique-account metrics are not added across days: "—" with the reason, never 0.
  await expect(totals.locator('[data-kpi="reach"]')).toContainText("—");
  await expect(totals.locator('[data-kpi="engagementRate"]')).toContainText(
    "choose Today or Yesterday",
  );
  await expect(page.getByTestId("organic-freshness")).toContainText("(UTC)");

  await choose(page, "Date range", "Yesterday");
  await expect(page).toHaveURL(/preset=yesterday/);
  // One account x one UTC day: the API returns the rate (or explains why it cannot).
  await expect(totals.locator('[data-kpi="engagementRate"]')).toContainText(
    /%|Not reported|Reach not reported|Total interactions not reported|reach is 0/,
    { timeout: DATA_TIMEOUT },
  );

  const series = page.getByTestId("organic-series");
  await expect(series.getByRole("heading", { name: /over time \(UTC\)/ })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test("posts show lifetime totals, a safe Instagram link and a post page", async ({ page }) => {
  await page.goto("/social?preset=last_30_days");
  const rows = page.locator("[data-post-id]");
  await expect(rows.first()).toBeVisible({ timeout: DATA_TIMEOUT });
  await expect(page.getByRole("heading", { name: "Posts — lifetime totals" })).toBeVisible();
  const link = rows.first().getByRole("link", { name: /View on Instagram/ });
  await expect(link).toHaveAttribute("href", /^https:\/\/www\.instagram\.com\//);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  // Never a media or thumbnail image.
  await expect(rows.locator("img")).toHaveCount(0);

  await page
    .getByRole("columnheader", { name: /Post \(published\)/ })
    .getByRole("button")
    .click();
  await expect(page).toHaveURL(/pdir=asc/);

  await rows.first().locator("td").first().getByRole("link").first().click();
  // The first visit compiles the dynamic route in dev mode.
  await expect(page).toHaveURL(/\/social\/posts\/[^/?]+\?.*account=/, { timeout: DATA_TIMEOUT });
  await expect(page.getByRole("heading", { level: 1 })).toContainText("post", {
    timeout: DATA_TIMEOUT,
  });
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Organic");
  await expect(page.getByText(/Lifetime totals as of .* \(UTC capture day\)/)).toBeVisible({
    timeout: DATA_TIMEOUT,
  });
  await expect(page.getByTestId("post-snapshots")).toContainText("not daily performance");
  await expectNoSeriousA11yViolations(page);
});

test("switching to the under-100-followers account explains missing follower changes", async ({
  page,
}) => {
  // The API infers "under 100 followers" from follower captures INSIDE the range (B2), and the
  // sync captures followers on the UTC day it runs: use the last 30 UTC days up to today.
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  await page.goto(`/social?preset=custom&from=${from}&to=${today}`);
  await expect(page.getByTestId("organic-totals")).toBeVisible({ timeout: DATA_TIMEOUT });
  await choose(page, "Instagram account", /@mock_small/);
  await expect(page).toHaveURL(/account=/);
  const totals = page.getByTestId("organic-totals");
  await expect(totals.locator('[data-kpi="followerDelta"]')).toContainText(
    "does not report this for accounts under 100 followers",
    { timeout: DATA_TIMEOUT },
  );
  await expect(totals.locator('[data-kpi="followers"]')).toContainText("57");
});

test("an unknown post id renders Not found", async ({ page }) => {
  await page.goto("/social/posts/not-a-real-id");
  await expect(page.getByText("This item does not exist or is not available")).toBeVisible({
    timeout: DATA_TIMEOUT,
  });
});
