import type { Page } from "@playwright/test";
import { THREADS, withConversations } from "./fixtures";
import { expect, settled, test, volatile } from "./support";

// The inbox and conversation pages (revamp Phase 9). The seeded organization has no
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
      const history = page.getByRole("region", { name: "Conversation", exact: true });
      await expect(history.getByText("Thank you!")).toBeVisible();
      const gap = await history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      expect(gap).toBeLessThanOrEqual(2);
      // The reply box sits right under the history.
      const reply = page.getByRole("region", { name: "Reply" });
      const historyBox = (await history.boundingBox())!;
      const replyBox = (await reply.boundingBox())!;
      expect(replyBox.y).toBeGreaterThan(historyBox.y + historyBox.height - 1);
      const details = page.getByRole("complementary", { name: "Conversation details" });
      const detailsBox = (await details.boundingBox())!;
      // In the workspace the pane is narrower than the screen: the details sit beside the
      // history only when the pane itself is wide (a container query), so below it here.
      expect(detailsBox.y).toBeGreaterThan(replyBox.y);
      await noSidewaysScroll(page);
      await expect(page).toHaveScreenshot(`whatsapp-conversation-${width}.png`, {
        fullPage: true,
        mask: volatile(page),
      });
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
});
