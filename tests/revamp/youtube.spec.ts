import type { Locator, Page } from "@playwright/test";
import { withYouTubeData, YOUTUBE_CHANNEL } from "./fixtures";
import { expect, settled, test, volatile } from "./support";

// O4 (ADR 0016 Checkpoint 8): the YouTube page with a channel (key metrics, the daily chart,
// the day table, videos with a Last 28 days | Lifetime switch) and a video's page, over a
// made-up channel answered on the Convex socket (fixtures.ts; nothing is written). No page
// scrolls sideways; tables scroll inside their own surface.

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 375, height: 812 },
];

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

async function openYouTube(page: Page, query = "") {
  await withYouTubeData(page);
  await page.goto(`/social?platform=youtube${query}`);
  await settled(page);
}

for (const viewport of VIEWPORTS) {
  test.describe(`YouTube page at ${viewport.width} px`, () => {
    test.use({ viewport });

    test("reads key metrics, chart, days, then videos", async ({ page }) => {
      await openYouTube(page);
      const order = [
        page.getByTestId("youtube-channel-summary"),
        page.getByTestId("filter-bar"),
        page.getByTestId("youtube-totals"),
        page.getByTestId("youtube-series"),
        page.getByTestId("youtube-channel-days"),
        page.getByTestId("youtube-videos"),
      ];
      const tops = [];
      for (const locator of order) tops.push(await top(locator));
      expect(tops).toEqual([...tops].sort((a, b) => a - b));
      await expect(page.locator('[data-kpi="subscribers"]')).toContainText("12,300");
      await expect(page.locator("[data-video-id]")).toHaveCount(7);
      await noSidewaysScroll(page);
      await expect(page).toHaveScreenshot(`youtube-page-${viewport.width}.png`, {
        fullPage: true,
        mask: volatile(page),
      });
    });
  });
}

test.describe("YouTube videos", () => {
  test("switch between the last 28 days and the lifetime, kept in the URL", async ({ page }) => {
    await openYouTube(page);
    const period = page.getByRole("group", { name: "Video analytics period" });
    await expect(period.getByRole("button", { name: "Last 28 days" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const monsoon = page.locator('[data-video-id="yv6"]');
    await expect(monsoon).toHaveAttribute("data-window-state", "reported");
    await period.getByRole("button", { name: "Lifetime" }).click();
    await expect(page).toHaveURL(/vwin=lifetime/);
    await expect(monsoon).toHaveAttribute("data-window-state", "not_in_top");
    await expect(monsoon).toContainText("Not in YouTube's top 200");
    await expect(page.locator('[data-video-id="yv7"]')).toContainText("Not synced yet");
  });
});

for (const viewport of [VIEWPORTS[0]!, VIEWPORTS[3]!]) {
  test.describe(`YouTube video page at ${viewport.width} px`, () => {
    test.use({ viewport });

    test("opens from the list, shows both periods and leads back", async ({ page }) => {
      await openYouTube(page, "&preset=last_30_days&vwin=lifetime");
      await page.locator('[data-video-id="yv6"] td:first-child a').click();
      await expect(page).toHaveURL(
        new RegExp(
          `/social/youtube/videos/yv6\\?preset=last_30_days&vwin=lifetime&account=${YOUTUBE_CHANNEL.id}$`,
        ),
      );
      await settled(page);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Monsoon menu: three soups for rainy evenings",
      );
      const windows = page.getByTestId("youtube-video-windows");
      await expect(windows.getByRole("region", { name: "Last 28 days" })).toContainText(
        "Oct 5, 2026 – Nov 1, 2026 (Pacific Time)",
      );
      await expect(windows.getByRole("region", { name: "Lifetime" })).toContainText(
        "Not in YouTube's top 200",
      );
      await expect(page.getByTestId("youtube-captures")).toBeVisible();
      await expect(page.getByRole("link", { name: "YouTube", exact: true })).toHaveAttribute(
        "href",
        `/social?preset=last_30_days&platform=youtube&account=${YOUTUBE_CHANNEL.id}&vwin=lifetime`,
      );
      await noSidewaysScroll(page);
      await expect(page).toHaveScreenshot(`youtube-video-${viewport.width}.png`, {
        fullPage: true,
        mask: volatile(page),
      });
    });
  });
}
