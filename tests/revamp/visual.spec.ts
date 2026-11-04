import type { Page } from "@playwright/test";
import { expect, settled, test, volatile } from "./support";

/**
 * Opening a form focuses a field and scrolls it into view; a full-page shot then draws the
 * sticky header mid-page. Blur and scroll to the top first.
 */
async function atTop(page: Page) {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
}

// Baseline screenshots of every route (and the main menus and forms) as they are before the
// frontend revamp. Each revamp phase changes them on purpose and reviews the diff. Full-page
// shots, animations frozen, clock frozen, sync-dependent text masked.

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1024", width: 1024, height: 768 },
  { name: "768", width: 768, height: 1024 },
  { name: "375", width: 375, height: 812 },
] as const;

type Shot = { name: string; path: string | ((page: Page) => Promise<string>); gate?: boolean };

/** Follow the first link matching `selector` on `from` (seeded ids are not known up front). */
function firstLink(from: string, selector: string) {
  return async (page: Page) => {
    await page.goto(from);
    await settled(page);
    const href = await page.locator(selector).first().getAttribute("href");
    if (!href) throw new Error(`No link ${selector} on ${from}; is the seed loaded?`);
    return href;
  };
}

const ROUTES: Shot[] = [
  { name: "overview", path: "/" },
  { name: "campaigns", path: "/campaigns" },
  { name: "campaign", path: firstLink("/campaigns", 'main a[href^="/campaigns/"]') },
  {
    name: "ad-group",
    path: async (page) => {
      const campaign = await firstLink("/campaigns", 'main a[href^="/campaigns/"]')(page);
      return firstLink(campaign, 'main a[href*="/ad-groups/"]')(page);
    },
  },
  { name: "breakdowns-platform", path: "/breakdowns" },
  { name: "breakdowns-account", path: "/breakdowns?tab=account" },
  { name: "breakdowns-placement", path: "/breakdowns?tab=placement" },
  { name: "conversions", path: "/conversions" },
  { name: "accounts", path: "/accounts" },
  { name: "social-instagram", path: "/social" },
  { name: "social-post", path: firstLink("/social", 'main a[href^="/social/posts/"]') },
  { name: "social-youtube", path: "/social?platform=youtube" },
  { name: "connections", path: "/connections" },
  { name: "organization", path: "/organization" },
  { name: "inbox", path: "/inbox" },
  { name: "saved-replies", path: "/inbox/saved-replies" },
  { name: "whatsapp", path: "/whatsapp" },
  { name: "whatsapp-settings", path: "/whatsapp/settings" },
  { name: "whatsapp-templates", path: "/whatsapp/templates" },
  { name: "instagram-dms", path: "/instagram/messages" },
  { name: "instagram-dm-settings", path: "/instagram/messages/settings" },
  { name: "instagram-templates", path: "/instagram/messages/templates" },
  { name: "dashboard-not-found", path: "/campaigns/not-a-real-campaign" },
  { name: "privacy", path: "/privacy", gate: false },
  { name: "data-deletion", path: "/data-deletion", gate: false },
  { name: "root-not-found", path: "/this-page-does-not-exist", gate: false },
];

async function capture(page: Page, shot: Shot, file: string, fullPage = true) {
  const path = typeof shot.path === "string" ? shot.path : await shot.path(page);
  await page.goto(path);
  if (shot.name.endsWith("not-found")) {
    await expect(page.getByText(/not found/i).first()).toBeVisible();
  } else {
    await settled(page, { gate: shot.gate !== false });
  }
  await expect(page).toHaveScreenshot(file, { fullPage, mask: volatile(page) });
}

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.name}px`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    for (const shot of ROUTES) {
      test(shot.name, async ({ page }) => {
        await capture(page, shot, `${shot.name}-${viewport.name}.png`);
      });
    }
  });
}

// Menus, popovers and forms, at desktop and phone width.
for (const viewport of [VIEWPORTS[0], VIEWPORTS[3]]) {
  test.describe(`interactive at ${viewport.name}px`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("accounts filter popover", async ({ page }) => {
      await page.goto("/");
      await settled(page);
      await page
        .getByRole("button", { name: /accounts/i })
        .first()
        .click();
      await expect(
        page.getByRole("dialog").or(page.locator("[data-slot=popover-content]")).first(),
      ).toBeVisible();
      await expect(page).toHaveScreenshot(`accounts-popover-${viewport.name}.png`, {
        mask: volatile(page),
      });
    });

    test("new saved reply form", async ({ page }) => {
      await page.goto("/inbox/saved-replies");
      await settled(page);
      await page.getByRole("button", { name: "New saved reply" }).first().click();
      await expect(page.getByLabel(/title/i).first()).toBeVisible();
      await atTop(page);
      await expect(page).toHaveScreenshot(`saved-reply-form-${viewport.name}.png`, {
        fullPage: true,
      });
    });

    test("new Instagram template", async ({ page }) => {
      await page.goto("/instagram/messages/templates");
      await settled(page);
      await page.getByRole("button", { name: "New template" }).first().click();
      await expect(page.getByRole("button", { name: "Save template" })).toBeVisible();
      await atTop(page);
      await expect(page).toHaveScreenshot(`instagram-template-builder-${viewport.name}.png`, {
        fullPage: true,
      });
    });
  });
}

test.describe("phone navigation", () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test("menu sheet", async ({ page }) => {
    await page.goto("/");
    await settled(page);
    await page
      .getByRole("button", { name: /menu|navigation/i })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page).toHaveScreenshot("menu-sheet-375.png", { mask: volatile(page) });
  });
});
