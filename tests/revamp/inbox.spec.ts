import type { Page } from "@playwright/test";
import { INSTAGRAM_CLOSED, THREADS, WHATSAPP_CLOSED, withConversations } from "./fixtures";
import { expect, settled, test, volatile } from "./support";

// The inbox and conversation pages (revamp Phase 9, Kinso K2-K4). The seeded organization has no
// conversation, so these tests answer the messaging queries on the Convex socket with made-up
// threads (fake names and 555 numbers). Nothing is written to the backend and nothing is sent.

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Phones, a tablet, small and large laptops (Kinso K4): the heights their screens usually have. */
const SCREENS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 375, height: 812 },
] as const;

/** The phone dock's height (below 1024 px it covers the bottom of the screen). */
const DOCK = 65;

for (const { width, height } of SCREENS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height } });

    test("the inbox lists one line per contact, without wrapping", async ({ page }) => {
      await withConversations(page);
      await page.goto("/inbox");
      await settled(page);
      const rows = page.getByRole("list", { name: "Conversations" }).getByRole("link");
      await expect(rows).toHaveCount(THREADS.length);
      // A long name is cut, not wrapped: every row has the same height.
      const heights = await rows.evaluateAll((links) =>
        links.map((link) => Math.round(link.getBoundingClientRect().height)),
      );
      expect(new Set(heights).size).toBe(1);
      await noSidewaysScroll(page);
      await expect(page).toHaveScreenshot(`inbox-threads-${width}.png`, {
        fullPage: true,
        mask: volatile(page),
      });
    });

    test("a WhatsApp conversation opens at its newest message", async ({ page }) => {
      await withConversations(page);
      await page.goto("/whatsapp/conversations/demo");
      await settled(page);
      await expect(page.getByRole("heading", { level: 1, name: "Meera Iyer" })).toBeVisible();
      // The header chip counts down the reply window.
      const header = page.locator("[data-conversation-pane] header");
      await expect(header.getByText("Reply window open")).toContainText("23h left");
      const history = page.getByRole("region", { name: "Conversation", exact: true });
      await expect(history.getByText("Thank you!")).toBeVisible();
      const gap = await history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      expect(gap).toBeLessThanOrEqual(2);
      // The reply box sits right under the history, and stays on screen: the pane fills the
      // screen (above the dock below 1024 px), the history scrolls, the page itself does not.
      const reply = page.getByRole("region", { name: "Reply" });
      const historyBox = (await history.boundingBox())!;
      const replyBox = (await reply.boundingBox())!;
      expect(replyBox.y).toBeGreaterThan(historyBox.y + historyBox.height - 1);
      expect(replyBox.y + replyBox.height).toBeLessThanOrEqual(height - (width < 1024 ? DOCK : 0));
      expect(historyBox.height).toBeGreaterThan(200);
      const pageScroll = await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      );
      expect(pageScroll).toBeLessThanOrEqual(0);
      // The back arrow only where the list is not beside the conversation.
      const back = page.getByRole("link", { name: "Back to WhatsApp" });
      if (width >= 1024) await expect(back).toBeHidden();
      else await expect(back).toBeVisible();
      // Below 1536 px the details open in a sheet instead of a column.
      await expect(page.getByRole("complementary", { name: "Conversation details" })).toBeHidden();
      await noSidewaysScroll(page);
      await expect(page).toHaveScreenshot(`whatsapp-conversation-${width}.png`, {
        mask: volatile(page),
      });
      await page.getByRole("button", { name: "Details" }).click();
      const sheet = page.getByRole("dialog", { name: "Details" });
      await expect(sheet.getByRole("link", { name: "WhatsApp templates" })).toBeVisible();
      // From the bottom on phones, from the right from 768 px.
      const sheetBox = (await sheet.boundingBox())!;
      if (width < 768) {
        expect(sheetBox.y).toBeGreaterThan(height / 4);
        expect(sheetBox.width).toBeGreaterThan(width - 2);
      } else {
        expect(sheetBox.x).toBeGreaterThan(width / 3);
      }
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    });
  });
}

test.describe("phones", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("an Instagram conversation keeps its history in view above the larger composer", async ({
    page,
  }) => {
    await withConversations(page);
    await page.goto("/instagram/messages/conversations/demo");
    await settled(page);
    const history = page.getByRole("region", { name: "Conversation", exact: true });
    // The newest message (the customer tapped "Prices") is in view.
    await expect(history.getByText("Prices", { exact: true }).last()).toBeVisible();
    expect((await history.boundingBox())!.height).toBeGreaterThan(150);
    await noSidewaysScroll(page);
    await expect(page).toHaveScreenshot("instagram-conversation-375.png", {
      mask: volatile(page),
    });
  });

  test("a closed WhatsApp window keeps a locked message box above the dock (L1)", async ({
    page,
  }) => {
    await withConversations(page, WHATSAPP_CLOSED);
    await page.goto("/whatsapp/conversations/demo");
    await settled(page);
    const reply = page.getByRole("region", { name: "Reply" });
    await expect(reply.getByText("The 24-hour reply window is closed")).toBeVisible();
    await expect(reply.getByText(/You can type here again as soon as they write/)).toBeVisible();
    await expect(reply.getByRole("textbox")).toHaveCount(0);
    const template = reply.getByRole("button", { name: "Choose a template" });
    await expect(template).toBeVisible();
    const box = (await template.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(812 - DOCK);
    await noSidewaysScroll(page);
    await expect(page).toHaveScreenshot("whatsapp-conversation-closed-375.png", {
      mask: volatile(page),
    });
  });

  test("the back arrow returns to the unified inbox a conversation was opened from", async ({
    page,
  }) => {
    await withConversations(page);
    await page.goto("/inbox");
    await settled(page);
    await page.getByRole("list", { name: "Conversations" }).getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Meera Iyer" })).toBeVisible();
    await page.getByRole("link", { name: "Back to Inbox" }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("list", { name: "Conversations" })).toBeVisible();
  });
});

test.describe("large screens", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the channel lists use the same rows", async ({ page }) => {
    await withConversations(page);
    for (const [path, count] of [
      ["/whatsapp", 2],
      ["/instagram/messages", 1],
    ] as const) {
      await page.goto(path);
      await settled(page);
      await expect(page.getByRole("list", { name: "Conversations" }).getByRole("link")).toHaveCount(
        count,
      );
    }
    await expect(page).toHaveScreenshot("instagram-threads-1440.png", { mask: volatile(page) });
  });

  test("an Instagram conversation shows the quick replies it sent", async ({ page }) => {
    await withConversations(page);
    await page.goto("/instagram/messages/conversations/demo");
    await settled(page);
    await expect(page.getByRole("heading", { level: 1, name: "@vikram.designs" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Quick-reply buttons sent" })).toContainText(
      "Opening hours",
    );
    await expect(page).toHaveScreenshot("instagram-conversation-1440.png", {
      fullPage: true,
      mask: volatile(page),
    });
  });

  test("a closed WhatsApp window locks the message box and offers a template", async ({ page }) => {
    await withConversations(page, WHATSAPP_CLOSED);
    await page.goto("/whatsapp/conversations/demo");
    await settled(page);
    await expect(
      page.locator("[data-conversation-pane] header").getByText("Templates only"),
    ).toBeVisible();
    const reply = page.getByRole("region", { name: "Reply" });
    // L1: a locked box in place of the field says why, and that typing comes back by itself.
    await expect(reply.getByText("The 24-hour reply window is closed")).toBeVisible();
    await expect(
      reply.getByText(
        /^Meera Iyer last wrote yesterday at .+\. You can type here again as soon as they write\. Until then, WhatsApp allows only approved templates\.$/,
      ),
    ).toBeVisible();
    await expect(reply.getByRole("textbox", { name: "Message" })).toHaveCount(0);
    await expect(reply.getByRole("button", { name: "Choose a template" })).toBeVisible();
    await expect(page).toHaveScreenshot("whatsapp-conversation-closed-1440.png", {
      mask: volatile(page),
    });
  });

  test("a closed Instagram window locks the message box (L1)", async ({ page }) => {
    await withConversations(page, {}, INSTAGRAM_CLOSED);
    await page.goto("/instagram/messages/conversations/demo");
    await settled(page);
    await expect(
      page.locator("[data-conversation-pane] header").getByText("Reply window closed"),
    ).toBeVisible();
    const reply = page.getByRole("region", { name: "Reply" });
    await expect(reply.getByText("The 24-hour reply window is closed")).toBeVisible();
    await expect(
      reply.getByText(/^@vikram\.designs last wrote yesterday at .+ You can type here again/),
    ).toBeVisible();
    await expect(reply.getByRole("textbox")).toHaveCount(0);
    await expect(reply.getByRole("button")).toHaveCount(0);
    await expect(page).toHaveScreenshot("instagram-conversation-closed-1440.png", {
      mask: volatile(page),
    });
  });
});

test.describe("very large screens", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("the details sit beside the conversation and can be hidden", async ({ page }) => {
    await withConversations(page);
    await page.goto("/whatsapp/conversations/demo");
    await settled(page);
    const history = page.getByRole("region", { name: "Conversation", exact: true });
    const details = page.getByRole("complementary", { name: "Conversation details" });
    await expect(details).toBeVisible();
    const historyBox = (await history.boundingBox())!;
    const detailsBox = (await details.boundingBox())!;
    expect(detailsBox.x).toBeGreaterThanOrEqual(historyBox.x + historyBox.width - 1);
    await expect(page).toHaveScreenshot("whatsapp-conversation-1920.png", {
      mask: volatile(page),
    });
    const toggle = page.getByRole("button", { name: "Details" });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(details).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
