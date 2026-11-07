import type { Page } from "@playwright/test";
import { answerQueries } from "./socket";
import { expect, NOW, settled, test, volatile } from "./support";

// The library and settings pages (revamp Phase 10). The seeded organization has no saved reply,
// Instagram template or messaging account, so these tests answer those queries on the Convex
// socket with made-up ones (fake names and 555 numbers). Nothing is written to the backend, and
// no button that saves, deletes, sends or connects is confirmed.

const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const DAY = 24 * 60;

const SAVED_REPLIES = [
  {
    id: "r1",
    title: "Opening hours",
    text: "We're open 10 am to 8 pm, Monday to Saturday. On Sundays we open at noon.",
    channels: ["whatsapp", "instagram"],
    updatedAt: at(-3 * DAY),
  },
  {
    id: "r2",
    title: "Welcome",
    text: "Hi {{customer_name}}, thanks for reaching out! How can we help you today?",
    channels: ["instagram"],
    quickReplies: ["Prices", "Order status", "Talk to us"],
    updatedAt: at(-2 * DAY),
  },
  {
    id: "r3",
    title: "Delivery areas",
    text: "We deliver across the city within 2 days. Delivery is free above $40.",
    channels: ["whatsapp"],
    updatedAt: at(-DAY),
  },
];

const INSTAGRAM_TEMPLATES = [
  {
    id: "t1",
    name: "Welcome menu",
    content: {
      kind: "buttons",
      text: "Hi {{customer_name}}, what can we do for you?",
      buttons: [
        { type: "reply", title: "Prices" },
        { type: "url", title: "Shop", url: "https://shop.example.com" },
      ],
    },
    updatedAt: at(-2 * DAY),
  },
  {
    id: "t2",
    name: "New arrivals",
    content: {
      kind: "cards",
      cards: [
        {
          title: "Linen tote",
          subtitle: "Sand and olive",
          imageUrl: "https://shop.example.com/tote.jpg",
          buttons: [{ type: "url", title: "View", url: "https://shop.example.com/tote" }],
        },
        { title: "Canvas cap", subtitle: "One size", buttons: [] },
      ],
    },
    updatedAt: at(-DAY),
  },
];

const WHATSAPP_ACCOUNTS = [
  {
    id: "acc1",
    connectionId: "conn1",
    wabaId: "100000000000010",
    onboardingType: "cloud_api",
    status: "active",
    setupStatus: "connected",
    connectedAt: at(-10 * DAY),
    numbers: [
      {
        id: "num1",
        phoneNumberId: "100000000000011",
        displayPhoneNumber: "+1 555 010 0001",
        status: "active",
        registered: true,
        businessApp: false,
      },
      {
        id: "num2",
        phoneNumberId: "100000000000012",
        displayPhoneNumber: "+1 555 010 0002",
        status: "active",
        registered: false,
        businessApp: false,
      },
    ],
  },
  {
    id: "acc2",
    connectionId: "conn2",
    wabaId: "100000000000020",
    onboardingType: "coexistence",
    status: "active",
    setupStatus: "action_required",
    nextStep: "register",
    connectedAt: at(-2 * DAY),
    numbers: [
      {
        id: "num3",
        phoneNumberId: "100000000000021",
        displayPhoneNumber: "+1 555 010 0003",
        status: "active",
        registered: false,
        businessApp: true,
        imported: true,
      },
    ],
  },
];

const SOCIAL_ACCOUNTS = [
  { id: "s1", username: "gudz.store" },
  { id: "s2", username: "gudz.outlet" },
].map((account, i) => ({
  ...account,
  platform: "instagram",
  externalId: `1784140000000000${i}`,
  name: account.username,
  accountType: "business",
  status: "active",
  linked: true,
  connectionId: `c-${account.id}`,
}));

const AVAILABILITY: Record<string, unknown> = {
  s1: { availability: "active", accountId: "m1" },
  s2: { availability: "ready" },
};

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
