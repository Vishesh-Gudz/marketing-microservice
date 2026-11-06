import type { Page } from "@playwright/test";
import { expect, settled, test } from "./support";

// The app shell (revamp Phase 4): no sideways scrolling at any width, the ⌘K page search,
// the collapsible sidebar and the phone dock.

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 375, height: 812 },
] as const;

const PAGES = ["/", "/campaigns", "/inbox", "/whatsapp/templates", "/connections"];

/** How far the page scrolls sideways (0 when everything fits). */
function sidewaysScroll(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

for (const viewport of WIDTHS) {
  test.describe(`${viewport.width} px`, () => {
    test.use({ viewport });
    test("no page scrolls sideways", async ({ page }) => {
      for (const path of PAGES) {
        await page.goto(path);
        await settled(page);
        expect(await sidewaysScroll(page), path).toBeLessThanOrEqual(0);
      }
    });
  });
}

test.describe("large screens", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("⌘K finds a page and goes there with the global filters", async ({ page }) => {
    await page.goto("/campaigns?preset=last_7_days&sort=name");
    await settled(page);
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Go to a page" });
    await expect(dialog).toBeVisible();
    await page.keyboard.type("saved");
    await expect(dialog.getByRole("option")).toHaveText(["Saved replies"]);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/inbox\/saved-replies\?preset=last_7_days$/);
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Saved replies" }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("the sidebar collapses to a rail and stays collapsed after a reload", async ({ page }) => {
    await page.goto("/");
    await settled(page);
    const sidebar = page.getByTestId("sidebar");
    await expect(sidebar).toHaveCSS("width", "240px");
    await sidebar.getByRole("button", { name: "Collapse" }).click();
    await expect(sidebar).toHaveCSS("width", "64px");
    await page.reload();
    await settled(page);
    await expect(sidebar).toHaveCSS("width", "64px");
    // Rail groups open as menus.
    await sidebar.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("menuitem", { name: "WhatsApp settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    // The keyboard, not a click: in `next dev` the dev-tools badge sits over the bottom of the
    // 64 px rail and takes the pointer (production builds have no badge).
    await sidebar.getByRole("button", { name: "Expand sidebar" }).press("Enter");
    await expect(sidebar).toHaveCSS("width", "240px");
  });

  test("the phone dock is hidden", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Shortcuts" })).toBeHidden();
  });
});

test.describe("phones", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the dock reaches the main pages and opens the full menu", async ({ page }) => {
    await page.goto("/");
    await settled(page);
    const dock = page.getByRole("navigation", { name: "Shortcuts" });
    await dock.getByRole("link", { name: "Inbox" }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(dock.getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
    await dock.getByRole("button", { name: "Open menu" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Templates" }).click();
    await sheet.getByRole("link", { name: "Instagram templates" }).click();
    await expect(page).toHaveURL(/\/instagram\/messages\/templates$/);
    await expect(sheet).toBeHidden();
  });
});
