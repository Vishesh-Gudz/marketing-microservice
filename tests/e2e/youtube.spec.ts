import { expect, test, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations, localDevAuthConfigured } from "./support";

// ADR 0016, Checkpoint 5: the YouTube view on /social and the YouTube card on /connections.
// The first block is CI-safe (Next.js dev server only). The second needs the local backend and
// a dev token (E2E_DASHBOARD_DATA=1, like social-data.spec.ts); it adapts to whether the dev
// org has a YouTube channel (a live-mode local backend usually has none) and never connects,
// links or disconnects anything.

test("the YouTube view shows the sign-in gate without a token", async ({ page }) => {
  test.skip(localDevAuthConfigured(), "a local dev token is configured");
  await page.goto("/social?platform=youtube");
  await expect(page.getByText("Not signed in")).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test.describe("with the local backend", () => {
  test.skip(
    !localDevAuthConfigured() || process.env.E2E_DASHBOARD_DATA !== "1",
    "requires local backend + dev auth, and E2E_DASHBOARD_DATA=1",
  );

  const DATA_TIMEOUT = 30_000;

  async function youtubeView(page: Page) {
    await page.goto("/social?platform=youtube&preset=last_30_days");
    await expect(page.getByRole("heading", { level: 1, name: "YouTube (organic)" })).toBeVisible({
      timeout: DATA_TIMEOUT,
    });
  }

  test("switches between Instagram and YouTube, keeping the filters", async ({ page }) => {
    await page.goto("/social?preset=last_7_days");
    const platforms = page.getByRole("navigation", { name: "Organic platform" });
    await expect(platforms).toBeVisible({ timeout: DATA_TIMEOUT });
    await expect(platforms.getByRole("link", { name: "Instagram" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await platforms.getByRole("link", { name: "YouTube" }).click();
    await expect(page).toHaveURL(/\/social\?preset=last_7_days&platform=youtube$/);
    await expect(page.getByRole("heading", { level: 1, name: "YouTube (organic)" })).toBeVisible();
    await platforms.getByRole("link", { name: "Instagram" }).click();
    await expect(page).toHaveURL(/\/social\?preset=last_7_days$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Instagram (organic)" }),
    ).toBeVisible();
  });

  test("the YouTube view: Pacific Time days, YouTube as the source, or a clear empty state", async ({
    page,
  }) => {
    await youtubeView(page);
    const empty = page.getByText("No YouTube channel connected");
    const days = page.getByTestId("youtube-channel-days");
    await expect(empty.or(days)).toBeVisible({ timeout: DATA_TIMEOUT });
    if (await empty.isVisible()) {
      await expect(
        page.getByRole("link", { name: "Connect YouTube on the Connections page" }),
      ).toHaveAttribute("href", "/connections");
    } else {
      await expect(page.getByTestId("day-basis")).toContainText("Pacific Time");
      await expect(page.getByTestId("youtube-channel-summary")).toContainText("Source: YouTube");
      await expect(days.getByRole("heading", { name: /Pacific Time/ })).toBeVisible();
      // Never a total, rate or comparison.
      await expect(page.getByText(/Engagement rate|compared with/)).toHaveCount(0);
      for (const link of await page.getByRole("link", { name: /Watch on YouTube/ }).all()) {
        await expect(link).toHaveAttribute("href", /^https:\/\/www\.youtube\.com\/watch\?v=/);
        await expect(link).toHaveAttribute("rel", "noopener noreferrer");
      }
    }
    await expectNoSeriousA11yViolations(page);
  });

  test("the Connections page offers YouTube and says what disconnecting deletes", async ({
    page,
  }) => {
    await page.goto("/connections");
    const youtube = page.getByRole("region", { name: "YouTube" });
    await expect(youtube).toBeVisible({ timeout: DATA_TIMEOUT });
    await expect(
      youtube
        .getByRole("button", { name: /^(Connect|Reconnect) YouTube$/ })
        .or(youtube.getByText("Only organization admins can connect or disconnect YouTube.")),
    ).toBeVisible();
    const disconnect = youtube.getByRole("button", { name: "Disconnect YouTube" });
    if (await disconnect.isVisible()) {
      // Open and cancel the confirmation only: nothing is disconnected.
      await disconnect.click();
      const confirmation = youtube.getByRole("group", { name: "Disconnect YouTube?" });
      await expect(confirmation).toContainText("This cannot be undone.");
      await confirmation.getByRole("button", { name: "Cancel" }).click();
      await expect(confirmation).toHaveCount(0);
    }
    await expectNoSeriousA11yViolations(page);
  });

  test.describe("mobile", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test("the YouTube view and the YouTube card content fit a phone screen", async ({ page }) => {
      await youtubeView(page);
      await expect(page.getByRole("navigation", { name: "Organic platform" })).toBeVisible();
      const overflow = await page.evaluate(() => {
        // The page content; the header's org badge already overflows on every page at 375 px
        // (pre-existing, outside this view). Tables scroll inside their own containers.
        const main = document.querySelector("main")!;
        return main.scrollWidth - main.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(1);
      await page.goto("/connections");
      await expect(page.getByRole("region", { name: "YouTube" })).toBeVisible({
        timeout: DATA_TIMEOUT,
      });
      const connectionsOverflow = await page.evaluate(() => {
        // The page content; the header's org badge already overflows on every page at 375 px
        // (pre-existing, outside this view). Tables scroll inside their own containers.
        const main = document.querySelector("main")!;
        return main.scrollWidth - main.clientWidth;
      });
      expect(connectionsOverflow).toBeLessThanOrEqual(1);
    });
  });
});
