import type { Locator, Page } from "@playwright/test";
import { expect, settled, test } from "./support";

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
