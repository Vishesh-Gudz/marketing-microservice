import type { Page } from "@playwright/test";
import { at, THREADS, withConversations } from "./fixtures";
import { expect, settled, test, volatile } from "./support";

// The inbox and conversation pages (revamp Phase 9, Kinso K2-K3). The seeded organization has no
// conversation, so these tests answer the messaging queries on the Convex socket with made-up
// threads (fake names and 555 numbers). Nothing is written to the backend and nothing is sent.

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const width of [1440, 375] as const) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 1440 ? 900 : 812 } });

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
      // The reply box sits right under the history.
      const reply = page.getByRole("region", { name: "Reply" });
      const historyBox = (await history.boundingBox())!;
      const replyBox = (await reply.boundingBox())!;
      expect(replyBox.y).toBeGreaterThan(historyBox.y + historyBox.height - 1);
      if (width === 1440) {
        // The pane fills the screen: the composer is pinned at its bottom and the page itself
        // does not scroll; the list is beside it, so there is no back arrow.
        expect(replyBox.y + replyBox.height).toBeLessThanOrEqual(900);
        const pageScroll = await page.evaluate(
          () => document.documentElement.scrollHeight - window.innerHeight,
        );
        expect(pageScroll).toBeLessThanOrEqual(0);
        await expect(page.getByRole("link", { name: "Back to WhatsApp" })).toBeHidden();
      } else {
        await expect(page.getByRole("link", { name: "Back to WhatsApp" })).toBeVisible();
      }
      // Below 1536 px the details open in a sheet instead of a column.
      await expect(page.getByRole("complementary", { name: "Conversation details" })).toBeHidden();
      await noSidewaysScroll(page);
      await expect(page).toHaveScreenshot(`whatsapp-conversation-${width}.png`, {
        fullPage: true,
        mask: volatile(page),
      });
      await page.getByRole("button", { name: "Details" }).click();
      const sheet = page.getByRole("dialog", { name: "Details" });
      await expect(sheet.getByRole("link", { name: "WhatsApp templates" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    });
  });
}

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

  test("a closed WhatsApp window offers a template first", async ({ page }) => {
    await withConversations(page, { serviceWindowExpiresAt: at(-30) });
    await page.goto("/whatsapp/conversations/demo");
    await settled(page);
    await expect(
      page.locator("[data-conversation-pane] header").getByText("Templates only"),
    ).toBeVisible();
    const reply = page.getByRole("region", { name: "Reply" });
    await expect(reply.getByText("The 24-hour reply window is closed")).toBeVisible();
    await expect(reply.getByRole("textbox", { name: "Message" })).toHaveCount(0);
    await expect(reply.getByRole("button", { name: "Choose a template" })).toBeVisible();
    await expect(page).toHaveScreenshot("whatsapp-conversation-closed-1440.png", {
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
