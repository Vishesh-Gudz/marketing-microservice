import type { Page } from "@playwright/test";
import { expect, settled, test } from "./support";

// The system and legal pages (revamp Phase 11): the not-found message sits in the middle of the
// screen with its way back, and the public legal pages read in one column on any width. Their
// screenshots are in visual.spec.ts.

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const width of [1440, 375] as const) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 1440 ? 900 : 812 } });

    test("an unknown URL is answered in the middle of the screen", async ({ page }) => {
      const response = await page.goto("/this-page-does-not-exist");
      expect(response?.status()).toBe(404);
      const heading = page.getByRole("heading", { level: 1, name: "Page not found" });
      await expect(heading).toBeVisible();
      const box = (await heading.boundingBox())!;
      expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(2);
      await expect(page.getByRole("link", { name: "Go to the overview" })).toBeVisible();
      await noSidewaysScroll(page);
    });

    test("the legal pages read in one column and keep their links", async ({ page }) => {
      for (const [path, title] of [
        ["/privacy", "Privacy Policy"],
        ["/data-deletion", "Data Deletion"],
      ] as const) {
        await page.goto(path);
        await settled(page, { gate: false });
        await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
        const footer = page.getByRole("contentinfo");
        await expect(footer.getByRole("link", { name: "Privacy Policy" })).toBeVisible();
        await expect(footer.getByRole("link", { name: "Data Deletion" })).toBeVisible();
        const column = await page.getByRole("heading", { level: 2 }).first().boundingBox();
        expect(column!.width).toBeLessThanOrEqual(768);
        await noSidewaysScroll(page);
      }
    });
  });
}

test.describe("inside the dashboard", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a missing item keeps the shell and names the page", async ({ page }) => {
    await page.goto("/campaigns/not-a-real-campaign");
    await expect(page.getByRole("heading", { level: 1, name: "Not found" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to campaigns" })).toBeVisible();
  });
});
