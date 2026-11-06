import type { Page } from "@playwright/test";
import { answerQueries } from "./socket";
import { expect, NOW, settled, test, volatile } from "./support";

// The inbox and conversation pages (revamp Phase 9). The seeded organization has no
// conversation, so these tests answer the messaging queries on the Convex socket with made-up
// threads (fake names and 555 numbers). Nothing is written to the backend and nothing is sent.

const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const page1 = (items: unknown[]) => ({ page: items, isDone: true, continueCursor: "" });

const THREADS = [
  {
    id: "t1",
    channel: "whatsapp",
    conversationId: "demo",
    accountLabel: "+1 555 010 0001",
    contactLabel: "Meera Iyer",
    lastMessageAt: at(-2),
    lastInboundAt: at(-2),
    replyState: "open",
    replyWindowExpiresAt: at(24 * 60 - 2),
  },
  {
    id: "t2",
    channel: "instagram",
    conversationId: "demo",
    accountLabel: "@gudz.store",
    contactLabel: "@vikram.designs",
    lastMessageAt: at(-55),
    lastInboundAt: at(-55),
    replyState: "unavailable",
    replyWindowExpiresAt: at(24 * 60 - 55),
  },
  {
    id: "t3",
    channel: "whatsapp",
    conversationId: "demo2",
    accountLabel: "+1 555 010 0001",
    contactLabel: "Priya Raghunathan-Venkataraman (catering orders for the Diwali weekend)",
    lastMessageAt: at(-3 * 60),
    lastInboundAt: at(-3 * 60),
    replyState: "open",
    replyWindowExpiresAt: at(21 * 60),
  },
  {
    id: "t4",
    channel: "whatsapp",
    conversationId: "demo3",
    accountLabel: "+1 555 010 0001",
    contactLabel: "+15550100044",
    lastMessageAt: at(-2 * 24 * 60),
    lastInboundAt: at(-2 * 24 * 60),
    replyState: "closed",
  },
];

const WHATSAPP_CONVERSATION = {
  id: "demo",
  phoneNumberId: "100000000000001",
  displayPhoneNumber: "+1 555 010 0001",
  contactWaId: "15550100002",
  contactName: "Meera Iyer",
  lastMessageAt: at(-2),
  lastInboundAt: at(-2),
  serviceWindowExpiresAt: at(24 * 60 - 2),
};

const LINES = [
  "Hi! Do you still have the linen tote in sand?",
  "Hello Meera, yes we do. Would you like one or two?",
  "Two please. Can you deliver to Bandra?",
  "We can. Delivery is free above $40.",
  "Great. What are your opening hours on Sunday?",
  "10 am to 6 pm. I can keep the totes for you until then.",
  "Perfect, I will pick them up at noon.",
  "See you then!",
  "Actually, can I change one to olive?",
  "Of course, one sand and one olive.",
];

/** Oldest first here; the API lists newest first. */
const WHATSAPP_MESSAGES = [
  ...LINES.map((text, i) => ({
    id: `w${i + 1}`,
    conversationId: "demo",
    direction: i % 2 === 0 ? "inbound" : "outbound",
    type: "text",
    text,
    status: i % 2 === 0 ? "received" : "read",
    at: at(-100 + i * 7),
  })),
  {
    id: "w11",
    conversationId: "demo",
    direction: "outbound",
    type: "text",
    text: "Hi Meera, your order 1042 is ready for pickup.",
    status: "read",
    template: { name: "order_update", language: "en_US" },
    at: at(-20),
  },
  {
    id: "w12",
    conversationId: "demo",
    direction: "inbound",
    type: "text",
    text: "Thank you!",
    status: "received",
    at: at(-2),
  },
].reverse();

const INSTAGRAM_CONVERSATION = {
  id: "demo",
  messagingAccountId: "acct1",
  accountUsername: "gudz.store",
  contactUsername: "vikram.designs",
  contactName: "Vikram",
  lastMessageAt: at(-55),
  lastInboundAt: at(-55),
  replyWindowExpiresAt: at(24 * 60 - 55),
};

const INSTAGRAM_MESSAGES = [
  {
    id: "i3",
    conversationId: "demo",
    direction: "inbound",
    origin: "customer",
    type: "text",
    text: "Prices",
    status: "received",
    at: at(-55),
  },
  {
    id: "i2",
    conversationId: "demo",
    direction: "outbound",
    origin: "app",
    type: "text",
    text: "Hi Vikram! What would you like to know?",
    status: "read",
    quickReplies: ["Prices", "Opening hours", "Delivery"],
    at: at(-60),
  },
  {
    id: "i1",
    conversationId: "demo",
    direction: "inbound",
    origin: "customer",
    type: "text",
    text: "Hello, I saw your new collection.",
    status: "received",
    at: at(-62),
  },
];

/** The shown conversations, whatever id the page asks for. */
async function withConversations(page: Page) {
  await answerQueries(page, {
    "v1/inbox:listThreads": () => page1(THREADS),
    "v1/whatsapp:listConversations": () =>
      page1([
        WHATSAPP_CONVERSATION,
        {
          ...WHATSAPP_CONVERSATION,
          id: "demo3",
          contactName: undefined,
          contactWaId: "15550100044",
          lastMessageAt: at(-2 * 24 * 60),
          serviceWindowExpiresAt: at(-24 * 60),
        },
      ]),
    "v1/instagramMessaging:listConversations": () => page1([INSTAGRAM_CONVERSATION]),
    "v1/whatsapp:getConversation": () => WHATSAPP_CONVERSATION,
    "v1/whatsapp:listMessages": () => page1(WHATSAPP_MESSAGES),
    "v1/instagramMessaging:getConversation": () => INSTAGRAM_CONVERSATION,
    "v1/instagramMessaging:listMessages": () => page1(INSTAGRAM_MESSAGES),
  });
}

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
      const history = page.getByRole("region", { name: "Conversation" });
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
      if (width === 1440) expect(detailsBox.x).toBeGreaterThan(historyBox.x + historyBox.width);
      else expect(detailsBox.y).toBeGreaterThan(replyBox.y);
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
