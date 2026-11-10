import type { Locator, Page } from "@playwright/test";
import { withInsightsPermissionMissing } from "./fixtures";
import { expect, settled, test, volatile } from "./support";

// The organic pages (revamp Phase 8): Instagram and YouTube read top to bottom like the paid
// workspaces, post rows carry a type glyph (never media from the platform), and no page
// scrolls sideways on a phone.

async function top(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not visible");
  return box.y;
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("large screens", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Instagram reads title, account, filters, key metrics, chart, posts", async ({ page }) => {
    await page.goto("/social");
    await settled(page);
    const title = page.getByRole("heading", { level: 1, name: "Instagram (organic)" });
    const platforms = page.getByRole("navigation", { name: "Organic platform" });
    // The platform switch sits on the title's row, at the right.
    expect(Math.abs((await top(platforms)) - (await top(title)))).toBeLessThan(16);
    const order = [
      title,
      page.getByTestId("social-account-picker"),
      page.getByTestId("filter-bar"),
      page.getByTestId("organic-totals"),
      page.getByTestId("organic-series"),
      page.getByRole("heading", { name: "Posts — lifetime totals" }),
    ];
    const tops = [];
    for (const locator of order) tops.push(await top(locator));
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
  });

  test("post rows show a type glyph and no image", async ({ page }) => {
    await page.goto("/social");
    await settled(page);
    const row = page.locator("[data-post-id]").first();
    await expect(row).toBeVisible();
    await expect(row.locator('td:first-child [aria-hidden="true"] svg').first()).toBeVisible();
    await expect(page.locator("[data-post-id] img")).toHaveCount(0);
  });

  test("YouTube without a channel keeps the switch and one way to connect", async ({ page }) => {
    // The seeded organization has no YouTube channel (the channel tables are unit-tested).
    await page.goto("/social?platform=youtube");
    await settled(page);
    const title = page.getByRole("heading", { level: 1, name: "YouTube (organic)" });
    const platforms = page.getByRole("navigation", { name: "Organic platform" });
    expect(Math.abs((await top(platforms)) - (await top(title)))).toBeLessThan(16);
    await expect(platforms.getByRole("link", { name: "YouTube" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      page.getByRole("link", { name: "Connect YouTube on the Connections page" }),
    ).toHaveAttribute("href", "/connections");
  });
});

// O2: an Instagram account whose Unified Login connection lacks instagram_manage_insights
// (answered on the socket, fixtures.ts) explains why instead of showing empty metrics.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 375, height: 812 },
]) {
  test.describe(`missing insights permission at ${viewport.width} px`, () => {
    test.use({ viewport });

    test("says why and how, with no empty metrics, chart or posts", async ({ page }) => {
      await withInsightsPermissionMissing(page);
      await page.goto("/social");
      await settled(page);
      const notice = page.getByRole("status", {
        name: "Instagram analytics need one more permission",
      });
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(
        "Add instagram_manage_insights to the Meta login configuration, then reconnect Instagram on Connections. Direct messages keep working meanwhile.",
      );
      await expect(notice.getByRole("link", { name: "Open Connections" })).toHaveAttribute(
        "href",
        "/connections",
      );
      // The notice follows the account it is about.
      expect(await top(notice)).toBeGreaterThan(
        await top(page.getByTestId("social-account-picker")),
      );
      for (const testId of ["filter-bar", "organic-totals", "organic-series"]) {
        await expect(page.getByTestId(testId)).toHaveCount(0);
      }
      await expect(page.getByText(/History loading|Data not synced/)).toHaveCount(0);
      await noSidewaysScroll(page);
      await expect(page).toHaveScreenshot(`social-insights-permission-${viewport.width}.png`, {
        fullPage: true,
        mask: volatile(page),
      });
    });
  });
}

test.describe("phones", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("no organic page scrolls sideways", async ({ page }) => {
    for (const path of ["/social", "/social?platform=youtube"]) {
      await page.goto(path);
      await settled(page);
      await noSidewaysScroll(page);
    }
    await page.goto("/social");
    await settled(page);
    await page.locator('[data-post-id] td:first-child a[href^="/social/posts/"]').first().click();
    await settled(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("post");
    await noSidewaysScroll(page);
  });
});
