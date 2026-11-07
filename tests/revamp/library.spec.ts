import type { Page } from "@playwright/test";
import { answerQueries } from "./socket";
import {
  AVAILABILITY,
  INSTAGRAM_TEMPLATES,
  SAVED_REPLIES,
  SOCIAL_ACCOUNTS,
  WHATSAPP_ACCOUNTS,
} from "./fixtures";
import { expect, settled, test, volatile } from "./support";

// The library and settings pages (revamp Phase 10). The seeded organization has no saved reply,
// Instagram template or messaging account, so these tests answer those queries on the Convex
// socket with made-up ones (fake names and 555 numbers). Nothing is written to the backend, and
// no button that saves, deletes, sends or connects is confirmed.

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function top(page: Page, name: string): Promise<number> {
  const box = await page.getByRole("listitem", { name }).boundingBox();
  if (!box) throw new Error(`${name} is not visible`);
  return Math.round(box.y);
}

for (const width of [1440, 375] as const) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 1440 ? 900 : 812 } });

    test("saved replies read as cards with their channels and actions", async ({ page }) => {
      await answerQueries(page, { "v1/savedReplies:list": () => SAVED_REPLIES });
      await page.goto("/inbox/saved-replies");
      await settled(page);
      await expect(page.getByRole("listitem", { name: "Welcome" })).toContainText("Talk to us");
      // Two cards side by side on large screens, one per row on a phone.
      if (width === 1440) {
        expect(await top(page, "Welcome")).toBe(await top(page, "Opening hours"));
      } else {
        expect(await top(page, "Welcome")).toBeGreaterThan(await top(page, "Opening hours"));
      }
      await noSidewaysScroll(page);
      await expect(page).toHaveScreenshot(`saved-replies-${width}.png`, {
        fullPage: true,
        mask: volatile(page),
      });
    });

    test("Instagram templates show their previews", async ({ page }) => {
      await answerQueries(page, {
        "v1/instagramTemplates:list": () => INSTAGRAM_TEMPLATES,
      });
      await page.goto("/instagram/messages/templates");
      await settled(page);
      await expect(page.getByRole("figure", { name: "New arrivals preview" })).toBeVisible();
      await noSidewaysScroll(page);
      await expect(page).toHaveScreenshot(`instagram-templates-${width}.png`, {
        fullPage: true,
        mask: volatile(page),
      });
    });

    test("WhatsApp settings list each number on its own row", async ({ page }) => {
      await answerQueries(page, { "v1/whatsapp:listAccounts": () => WHATSAPP_ACCOUNTS });
      await page.goto("/whatsapp/settings");
      await settled(page);
      const numbers = page.getByRole("list", {
        name: "Phone numbers of WhatsApp Business account",
      });
      await expect(numbers.first().getByRole("listitem")).toHaveCount(2);
      await noSidewaysScroll(page);
      await expect(page).toHaveScreenshot(`whatsapp-settings-${width}.png`, {
        fullPage: true,
        mask: volatile(page),
      });
    });

    test("no library or settings page scrolls sideways", async ({ page }) => {
      for (const path of [
        "/connections",
        "/inbox/saved-replies",
        "/whatsapp/templates",
        "/whatsapp/settings",
        "/instagram/messages/templates",
        "/instagram/messages/settings",
      ]) {
        await page.goto(path);
        await settled(page);
        await noSidewaysScroll(page);
      }
    });
  });
}

test.describe("large screens", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a delete asks on the card, and Escape closes the question", async ({ page }) => {
    await answerQueries(page, { "v1/savedReplies:list": () => SAVED_REPLIES });
    await page.goto("/inbox/saved-replies");
    await settled(page);
    const card = page.getByRole("listitem", { name: "Opening hours" });
    await card.getByRole("button", { name: "Delete" }).click();
    const question = card.getByRole("group", { name: "Delete Opening hours?" });
    await expect(question).toBeVisible();
    await expect(card).toHaveScreenshot("saved-reply-delete-1440.png");
    await question.getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Escape");
    await expect(question).toHaveCount(0);
  });

  test("the ready-made replies open on a tinted well", async ({ page }) => {
    await answerQueries(page, { "v1/savedReplies:list": () => SAVED_REPLIES });
    await page.goto("/inbox/saved-replies");
    await settled(page);
    await page.getByRole("button", { name: "Ready-made replies" }).click();
    const gallery = page.getByRole("region", { name: "Ready-made replies" });
    await expect(gallery.getByRole("button", { name: "Use this reply" }).first()).toBeVisible();
    await expect(gallery).toHaveScreenshot("saved-reply-starters-1440.png");
  });

  test("Instagram DM settings show each account's state and ice breakers", async ({ page }) => {
    await answerQueries(page, {
      "v1/socialAccounts:list": () => ({
        page: SOCIAL_ACCOUNTS,
        isDone: true,
        continueCursor: "",
      }),
      "v1/instagramMessaging:getAvailability": (args) =>
        AVAILABILITY[String(args.socialAccountId)] ?? { availability: "not_found" },
      "v1/instagramMessaging:listAccounts": () => [
        {
          id: "m1",
          socialAccountId: "s1",
          status: "active",
          iceBreakers: ["What are your opening hours?", "Do you deliver?"],
        },
      ],
    });
    await page.goto("/instagram/messages/settings");
    await settled(page);
    await expect(page.getByRole("list", { name: "Current ice breakers" })).toContainText(
      "Do you deliver?",
    );
    await expect(page.getByRole("button", { name: "Turn on direct messages" })).toBeVisible();
    await expect(page).toHaveScreenshot("instagram-dm-settings-1440.png", {
      fullPage: true,
      mask: volatile(page),
    });
  });
});
