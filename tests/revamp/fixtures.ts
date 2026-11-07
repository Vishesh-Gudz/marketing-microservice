import type { Page } from "@playwright/test";
import { answerQueries } from "./socket";
import { NOW } from "./support";

// Made-up messaging data for the revamp specs: the seeded organization has no conversation,
// saved reply, Instagram template or messaging account, so the specs answer those queries on the
// Convex socket (socket.ts) with these. Fake names and 555 numbers; nothing is written to the
// backend and nothing is sent.

export const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
export const page1 = (items: unknown[]) => ({ page: items, isDone: true, continueCursor: "" });

export const THREADS = [
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

export const WHATSAPP_CONVERSATION = {
  id: "demo",
  phoneNumberId: "100000000000001",
  displayPhoneNumber: "+1 555 010 0001",
  contactWaId: "15550100002",
  contactName: "Meera Iyer",
  lastMessageAt: at(-2),
  lastInboundAt: at(-2),
  serviceWindowExpiresAt: at(24 * 60 - 2),
};

export const LINES = [
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
export const WHATSAPP_MESSAGES = [
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

export const INSTAGRAM_CONVERSATION = {
  id: "demo",
  messagingAccountId: "acct1",
  accountUsername: "gudz.store",
  contactUsername: "vikram.designs",
  contactName: "Vikram",
  lastMessageAt: at(-55),
  lastInboundAt: at(-55),
  replyWindowExpiresAt: at(24 * 60 - 55),
};

export const INSTAGRAM_MESSAGES = [
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
export async function withConversations(page: Page) {
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

export const DAY = 24 * 60;

export const SAVED_REPLIES = [
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

export const INSTAGRAM_TEMPLATES = [
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

export const WHATSAPP_ACCOUNTS = [
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

export const SOCIAL_ACCOUNTS = [
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

export const AVAILABILITY: Record<string, unknown> = {
  s1: { availability: "active", accountId: "m1" },
  s2: { availability: "ready" },
};

/**
 * Every messaging query of these fixtures at once: threads, both conversations, saved replies,
 * Instagram templates, WhatsApp accounts and Instagram DM availability. Only for messaging
 * pages: it also answers the social accounts list.
 */
export async function withMessagingData(page: Page) {
  await answerQueries(page, {
    "v1/inbox:listThreads": () => page1(THREADS),
    "v1/whatsapp:listConversations": () => page1([WHATSAPP_CONVERSATION]),
    "v1/instagramMessaging:listConversations": () => page1([INSTAGRAM_CONVERSATION]),
    "v1/whatsapp:getConversation": () => WHATSAPP_CONVERSATION,
    "v1/whatsapp:listMessages": () => page1(WHATSAPP_MESSAGES),
    "v1/instagramMessaging:getConversation": () => INSTAGRAM_CONVERSATION,
    "v1/instagramMessaging:listMessages": () => page1(INSTAGRAM_MESSAGES),
    "v1/savedReplies:list": () => SAVED_REPLIES,
    "v1/instagramTemplates:list": () => INSTAGRAM_TEMPLATES,
    "v1/whatsapp:listAccounts": () => WHATSAPP_ACCOUNTS,
    "v1/socialAccounts:list": () => page1(SOCIAL_ACCOUNTS),
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
}
