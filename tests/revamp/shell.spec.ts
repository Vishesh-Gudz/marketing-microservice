import type { Page } from "@playwright/test";
import { expect, settled, test, volatile } from "./support";

// The app shell (revamp Phase 4; widths widened in Phase 12): no sideways scrolling from a phone
// to a 1920 px screen, the content's reading width on wide screens, the ⌘K page search, the
// collapsible sidebar and the phone dock.

const WIDTHS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 375, height: 812 },
] as const;

const PAGES = [
  "/",
  "/campaigns",
  "/breakdowns?tab=placement",
  "/accounts",
  "/social",
  "/inbox",
  "/whatsapp/templates",
  "/connections",
  "/organization",
];

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

test.describe("wide screens", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("the content keeps its reading width, centred beside the sidebar", async ({ page }) => {
    await page.goto("/campaigns");
    await settled(page);
    const main = (await page.locator("#main-content").boundingBox())!;
    const column = (await page.locator("#main-content > div").first().boundingBox())!;
    expect(column.width).toBeLessThanOrEqual(1280);
    const left = column.x - main.x;
    const right = main.x + main.width - (column.x + column.width);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
    await expect(page).toHaveScreenshot("campaigns-1920.png", { mask: volatile(page) });
  });
});

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

test.describe("organization loader", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("shows the Gudz loader in the content area until the organization resolves", async ({
    page,
  }) => {
    // Hold the Convex sync socket open with no server behind it: auth never completes, so the
    // gate stays on its loader while the shell around it is already usable.
    await page.routeWebSocket(/\/api\/[^/]+\/sync/, () => {});
    await page.goto("/");
    const loader = page.getByRole("status", { name: "Loading organization" });
    await expect(loader).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(loader).toContainText("Connecting to your organization…", { timeout: 10_000 });
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot("org-loader-1440.png", {
      mask: [page.getByText(/Convex/).last()],
    });
  });
});
