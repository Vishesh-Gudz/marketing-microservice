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

/**
 * A reply window that closed an hour ago, the customer having last written 25 hours ago (L1):
 * changes to the open WhatsApp and Instagram conversations.
 */
export const WHATSAPP_CLOSED = { lastInboundAt: at(-25 * 60), serviceWindowExpiresAt: at(-60) };
export const INSTAGRAM_CLOSED = { lastInboundAt: at(-25 * 60), replyWindowExpiresAt: at(-60) };

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

/**
 * The shown conversations, whatever id the page asks for; `whatsapp` and `instagram` change the
 * open conversation of that channel (e.g. a closed reply window).
 */
export async function withConversations(
  page: Page,
  whatsapp: Record<string, unknown> = {},
  instagram: Record<string, unknown> = {},
) {
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
    "v1/whatsapp:getConversation": () => ({ ...WHATSAPP_CONVERSATION, ...whatsapp }),
    "v1/whatsapp:listMessages": () => page1(WHATSAPP_MESSAGES),
    "v1/instagramMessaging:getConversation": () => ({ ...INSTAGRAM_CONVERSATION, ...instagram }),
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

/**
 * O2: an Instagram account connected through Meta's Unified Login without
 * instagram_manage_insights (`organicSync`), so /social explains the missing permission.
 */
export const INSIGHTS_PERMISSION_MISSING_ACCOUNT = {
  id: "s3",
  platform: "instagram",
  externalId: "17841400000000003",
  username: "gudz.unified",
  name: "gudz.unified",
  accountType: "business",
  status: "active",
  linked: true,
  connectionId: "c-s3",
  linkedAt: at(-2 * DAY),
  organicSync: "insights_permission_missing",
};

/** /social with only that account (the social account list and the account itself). */
export async function withInsightsPermissionMissing(page: Page) {
  await answerQueries(page, {
    "v1/socialAccounts:list": () => page1([INSIGHTS_PERMISSION_MISSING_ACCOUNT]),
    "v1/socialAccounts:get": () => INSIGHTS_PERMISSION_MISSING_ACCOUNT,
  });
}

/**
 * O4 (ADR 0016 Checkpoint 8): a made-up YouTube channel. The seeded organization has none, so
 * /social?platform=youtube and the video page answer the channel list, its days, its videos
 * and one video on the socket. NOW is Wednesday 4 Nov 2026 (Pacific Time): YouTube's days
 * through Sunday 1 Nov are reported, the newer ones are not yet (the 3-day reporting delay).
 */
export const YOUTUBE_CHANNEL = {
  id: "y1",
  platform: "youtube",
  externalId: "UCgudzkitchen0000000000a",
  username: "gudzkitchen",
  name: "Gudz Kitchen",
  accountType: "channel",
  status: "active",
  linked: true,
  connectionId: "c-y1",
  linkedAt: at(-60 * DAY),
  followersCount: 12_300,
  lastSyncedAt: at(-6 * 60),
  coverage: { from: "2026-08-01", through: "2026-11-01" },
};

const YOUTUBE_REPORTED_THROUGH = "2026-11-01";

/** Inclusive YYYY-MM-DD days. */
function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 864e5) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** One day's made-up values: steady, with busier weekends. */
function youtubeDayValues(date: string) {
  const n = Date.parse(`${date}T00:00:00Z`) / 864e5;
  const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
  const views = 1_150 + ((n * 37) % 11) * 70 + (weekend ? 520 : 0);
  const estimatedMinutesWatched = Math.round(views * (2.1 + ((n * 13) % 7) / 20));
  return {
    views,
    likes: Math.round(views * 0.046),
    comments: Math.round(views * 0.006),
    shares: Math.round(views * 0.004),
    estimatedMinutesWatched,
    averageViewDuration: Math.round((estimatedMinutesWatched * 60) / views),
    subscribersGained: 6 + ((n * 7) % 9),
    subscribersLost: (n * 5) % 4,
  };
}

/** v1/youtubeAnalytics:channelDays for any range, with the totals the server would compute. */
export function youtubeChannelDays(range: { from: string; to: string }) {
  const days = eachDay(range.from, range.to).map((date) =>
    date <= YOUTUBE_REPORTED_THROUGH
      ? { date, status: "reported", metrics: youtubeDayValues(date), unavailableMetrics: [] }
      : { date, status: "unknown", metrics: {}, unavailableMetrics: [] },
  );
  const reported = days
    .filter((day) => day.status === "reported")
    .map((day) => youtubeDayValues(day.date));
  const sum = (metric: keyof ReturnType<typeof youtubeDayValues>) =>
    reported.reduce((total, values) => total + values[metric], 0);
  const views = sum("views");
  const minutes = sum("estimatedMinutesWatched");
  const synced = reported.length;
  return {
    timezone: "America/Los_Angeles",
    accountId: YOUTUBE_CHANNEL.id,
    range,
    dataState: synced === 0 ? "unknown" : synced === days.length ? "reported" : "partial",
    reportingDelayDays: 3,
    totals: {
      reportedDays: synced,
      metrics: {
        views,
        estimatedMinutesWatched: minutes,
        likes: sum("likes"),
        comments: sum("comments"),
        shares: sum("shares"),
        subscribersGained: sum("subscribersGained"),
        subscribersLost: sum("subscribersLost"),
        subscribersNet: sum("subscribersGained") - sum("subscribersLost"),
        averageViewDuration: Math.round((minutes * 60) / views),
      },
      unavailableMetrics: [],
    },
    subscribers: { count: 12_300, capturedAt: at(-6 * 60) },
    analyticsAccess: "granted",
    coverage: {
      syncedDays: synced,
      unsyncedDays: days.length - synced,
      covered: { from: "2026-08-01", through: YOUTUBE_REPORTED_THROUGH },
      lastSyncedAt: at(-6 * 60),
    },
    days,
  };
}

const LAST_28 = { from: "2026-10-05", to: YOUTUBE_REPORTED_THROUGH };
const LIFETIME = { from: "2023-06-14", to: YOUTUBE_REPORTED_THROUGH };

function videoWindow(period: { from: string; to: string }, views: number, percent: number) {
  const estimatedMinutesWatched = Math.round(views * 2.6);
  return {
    status: "reported",
    ...period,
    syncedAt: at(-6 * 60),
    metrics: {
      views,
      estimatedMinutesWatched,
      averageViewDuration: Math.round((estimatedMinutesWatched * 60) / views),
      averageViewPercentage: percent,
      likes: Math.round(views * 0.05),
      comments: Math.round(views * 0.007),
      shares: Math.round(views * 0.004),
      subscribersGained: Math.round(views / 180),
      subscribersLost: Math.round(views / 2_400),
    },
  };
}

const notInTop = (period: { from: string; to: string }) => ({
  status: "not_in_top",
  ...period,
  syncedAt: at(-6 * 60),
  metrics: {},
});

/** Newest first, as the API lists them by default. */
export const YOUTUBE_VIDEOS = [
  {
    id: "yv7",
    title: "Live Q&A: your Diwali sweets questions",
    publishedAt: "2026-11-02T13:30:00.000Z",
    analytics: {},
  },
  {
    id: "yv6",
    title: "Monsoon menu: three soups for rainy evenings",
    publishedAt: "2026-10-29T12:00:00.000Z",
    analytics: { last28: videoWindow(LAST_28, 1_840, 52.4) },
    lifetime: "not_in_top",
  },
  {
    id: "yv5",
    title: "Filter coffee, the slow way",
    publishedAt: "2026-10-25T12:00:00.000Z",
    analytics: { last28: videoWindow(LAST_28, 6_215, 61.8) },
  },
  {
    id: "yv4",
    title: "Five chutneys, one blender",
    publishedAt: "2026-10-21T12:00:00.000Z",
    analytics: { last28: videoWindow(LAST_28, 4_902, 47.1) },
  },
  {
    id: "yv3",
    title: "Our kitchen tour: what changed this year",
    publishedAt: "2026-10-16T12:00:00.000Z",
    analytics: { last28: notInTop(LAST_28) },
    removedAt: "2026-10-30T08:00:00.000Z",
  },
  {
    id: "yv2",
    title: "Weeknight paneer tikka, no tandoor needed",
    publishedAt: "2026-10-12T12:00:00.000Z",
    analytics: { last28: videoWindow(LAST_28, 12_480, 44.6) },
  },
  {
    id: "yv1",
    title: "Masala dosa at home in 20 minutes",
    publishedAt: "2026-10-07T12:00:00.000Z",
    analytics: { last28: videoWindow(LAST_28, 21_305, 38.9) },
  },
].map(({ id, lifetime, ...video }, i) => {
  // Published inside the last 28 days, so the lifetime values are the same (or outside the
  // lifetime top 200, among the channel's older videos).
  const last28 = (video.analytics as { last28?: { status: string } }).last28;
  const analytics =
    last28 === undefined
      ? {}
      : {
          last28,
          lifetime:
            lifetime === "not_in_top" || last28.status === "not_in_top"
              ? notInTop(LIFETIME)
              : { ...last28, ...LIFETIME },
        };
  const videoId = `GudzVideo${String(i).padStart(2, "0")}`;
  return {
    ...video,
    id,
    socialAccountId: YOUTUBE_CHANNEL.id,
    videoId,
    permalink: `https://www.youtube.com/watch?v=${videoId}`,
    dataState: "reported",
    analytics,
  };
});

/** A video's daily public-count captures (UTC days) after publishing: lifetime counts. */
function youtubeCaptures(video: (typeof YOUTUBE_VIDEOS)[number]) {
  const reported = (video.analytics as { last28?: { metrics: { views?: number } } }).last28;
  const target = (reported?.metrics.views ?? 900) * 1.08;
  const days = eachDay(video.publishedAt.slice(0, 10), "2026-11-03").slice(1);
  return days.map((capturedDate, i) => {
    const views = Math.round(target * Math.sqrt((i + 1) / days.length));
    return {
      capturedDate,
      capturedAt: `${capturedDate}T06:00:00.000Z`,
      dataState: "reported",
      metrics: { views, likes: Math.round(views * 0.05), comments: Math.round(views * 0.007) },
      unavailableMetrics: [],
    };
  });
}

/** v1/youtubeAnalytics:video: the video, its latest capture and every capture. */
export function youtubeVideoDetail(video: (typeof YOUTUBE_VIDEOS)[number]) {
  const captures = youtubeCaptures(video);
  const latest = captures.at(-1);
  return { ...video, ...(latest ? { latest } : { dataState: "unknown" }), captures };
}

/** /social?platform=youtube and /social/youtube/videos/[videoId] over the made-up channel. */
export async function withYouTubeData(page: Page) {
  await answerQueries(page, {
    "v1/socialAccounts:list": () => page1([...SOCIAL_ACCOUNTS, YOUTUBE_CHANNEL]),
    "v1/youtubeAnalytics:channelDays": (args) =>
      youtubeChannelDays(args.range as { from: string; to: string }),
    "v1/youtubeAnalytics:videos": () =>
      page1(
        YOUTUBE_VIDEOS.map((video) => {
          const latest = youtubeCaptures(video).at(-1);
          return latest ? { ...video, latest } : { ...video, dataState: "unknown" };
        }),
      ),
    "v1/youtubeAnalytics:video": (args) =>
      youtubeVideoDetail(YOUTUBE_VIDEOS.find((v) => v.id === args.videoId) ?? YOUTUBE_VIDEOS[0]!),
  });
}

export const AVAILABILITY: Record<string, unknown> = {
  s1: { availability: "active", accountId: "m1" },
  s2: { availability: "ready" },
};

/**
 * Every messaging query of these fixtures at once: threads, both conversations, saved replies,
 * Instagram templates, WhatsApp accounts and Instagram DM availability. Only for messaging
 * pages: it also answers the social accounts list. `whatsapp` and `instagram` change the open
 * conversation of that channel (a closed window, a number that cannot send).
 */
export async function withMessagingData(
  page: Page,
  whatsapp: Record<string, unknown> = {},
  instagram: Record<string, unknown> = {},
) {
  await answerQueries(page, {
    "v1/inbox:listThreads": () => page1(THREADS),
    "v1/whatsapp:listConversations": () => page1([WHATSAPP_CONVERSATION]),
    "v1/instagramMessaging:listConversations": () => page1([INSTAGRAM_CONVERSATION]),
    "v1/whatsapp:getConversation": () => ({ ...WHATSAPP_CONVERSATION, ...whatsapp }),
    "v1/whatsapp:listMessages": () => page1(WHATSAPP_MESSAGES),
    "v1/instagramMessaging:getConversation": () => ({ ...INSTAGRAM_CONVERSATION, ...instagram }),
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
