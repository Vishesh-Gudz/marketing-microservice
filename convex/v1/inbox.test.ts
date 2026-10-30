import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  CUSTOMER_1 as IG_CUSTOMER,
  customerMessage as igMessage,
  delivery as igDelivery,
  entry as igEntry,
  IG_ACCOUNT,
  postDelivery as postIgDelivery,
  seedHolder,
  stubInstagramWebhookEnv,
} from "../instagram/messaging/fakeWebhook.fixtures";
import { SERVICE_WINDOW_MS } from "../messaging/window";
import {
  as,
  expectMarketingError,
  ISSUER_CRM,
  ISSUER_ERP,
  newBackend,
  seedOrg,
  type Backend,
} from "../test.helpers";
import { installFakeWhatsAppGraph, type FakeWhatsAppGraph } from "../whatsapp/fakeGraph.fixtures";
import {
  CUSTOMER_1,
  delivery,
  entry,
  PHONE_A,
  postDelivery,
  WABA_A,
} from "../whatsapp/fakeWebhook.fixtures";

// ADR 0018 (IM7.3): `v1/inbox:listThreads`, the unified inbox read API, over conversations
// created by the real WhatsApp and Instagram paths (fakes only): org scoping, the channel
// filter, newest-first pagination, skipped rows, per-channel labels and privacy, reply states.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-10-30T12:00:00Z").getTime();
const ORG_B = { issuer: ISSUER_CRM, org: "77" };
const PAGE = { paginationOpts: { numItems: 50, cursor: null } };

let graph: FakeWhatsAppGraph;
beforeEach(() => {
  graph = installFakeWhatsAppGraph();
  graph.addWaba({
    id: WABA_A,
    name: "Org A Business",
    numbers: [{ id: PHONE_A, display_phone_number: "+1 555-000-0001" }],
  });
  stubInstagramWebhookEnv();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const run = (t: Backend) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 1_000);

async function setup() {
  const t = newBackend();
  const orgA = await seedOrg(t, ISSUER_ERP, "42");
  const orgB = await seedOrg(t, ISSUER_CRM, "77");
  await as(t).action(api.v1.whatsapp.completeSignup, {
    code: graph.issueCode({ token: "EAAG-test-token-a", sharedWabas: [WABA_A] }),
    wabaId: WABA_A,
    phoneNumberId: PHONE_A,
  });
  await run(t);
  const instagram = await seedHolder(t, { orgId: orgA, issuer: ISSUER_ERP });
  return { t, orgA, orgB, instagram };
}

async function whatsapp(t: Backend, wamid: string, from = CUSTOMER_1, name?: string) {
  const message = { id: wamid, from, text: "Hi", ...(name !== undefined ? { name } : {}) };
  const response = await postDelivery(
    t,
    delivery(entry({ phoneNumberId: PHONE_A, messages: [message] })),
  );
  expect(response.status).toBe(200);
  await run(t);
}

async function instagram(t: Backend, mid: string, customer = IG_CUSTOMER) {
  const response = await postIgDelivery(t, igDelivery(igEntry([igMessage(mid, { customer })])));
  expect(response.status).toBe(200);
  await run(t);
}

const list = (t: Backend, args: Record<string, unknown> = {}, who: Record<string, string> = {}) =>
  as(t, { role: "viewer", ...who }).query(api.v1.inbox.listThreads, { ...PAGE, ...args });

describe("v1/inbox:listThreads", () => {
  it("lists both channels newest first, with exactly the approved fields", async () => {
    const { t } = await setup();
    await whatsapp(t, "wamid.1", CUSTOMER_1, "Ana");
    vi.advanceTimersByTime(60_000);
    await instagram(t, "mid.1");

    const { page, isDone } = await list(t);
    expect(isDone).toBe(true);
    expect(page.map((row) => row.channel)).toEqual(["instagram", "whatsapp"]);
    for (const row of page) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "accountLabel",
          "channel",
          "contactLabel",
          "conversationId",
          "id",
          "lastInboundAt",
          "lastMessageAt",
          "replyState",
          "replyWindowExpiresAt",
        ].sort(),
      );
    }
    expect(page[1]).toMatchObject({
      channel: "whatsapp",
      accountLabel: "+1 555-000-0001",
      contactLabel: "Ana",
      replyState: "open",
    });
    // The window is the 24 hours after the customer's last message.
    expect(Date.parse(page[1]!.replyWindowExpiresAt!)).toBe(
      Date.parse(page[1]!.lastInboundAt!) + SERVICE_WINDOW_MS,
    );
    expect(page[0]).toMatchObject({
      channel: "instagram",
      accountLabel: "@shop",
      contactLabel: "Instagram user",
      replyState: "open",
    });
  });

  it("is viewer-level, needs a signed-in org, and is empty for an org without conversations", async () => {
    const { t } = await setup();
    await whatsapp(t, "wamid.1");
    for (const role of ["viewer", "editor", "admin"]) {
      expect((await list(t, {}, { role })).page).toHaveLength(1);
    }
    await expect(t.query(api.v1.inbox.listThreads, PAGE)).rejects.toThrow();
    expect(await list(t, {}, ORG_B)).toMatchObject({ page: [], isDone: true });
  });

  it("never shows another org's conversations; their ids are NOT_FOUND on the channel APIs", async () => {
    const { t, orgB } = await setup();
    await whatsapp(t, "wamid.1");
    await instagram(t, "mid.1");
    await seedHolder(t, { orgId: orgB, issuer: ISSUER_CRM }, { igAccountId: "17841400000000909" });
    const response = await postIgDelivery(
      t,
      igDelivery(
        igEntry([igMessage("mid.b", { account: "17841400000000909" })], "17841400000000909"),
      ),
    );
    expect(response.status).toBe(200);
    await run(t);

    const mine = (await list(t)).page;
    const theirs = (await list(t, {}, ORG_B)).page;
    expect(mine).toHaveLength(2);
    expect(theirs.map((row) => row.channel)).toEqual(["instagram"]);
    expect(mine.some((row) => theirs.some((other) => other.id === row.id))).toBe(false);

    const whatsappRow = mine.find((row) => row.channel === "whatsapp")!;
    const instagramRow = mine.find((row) => row.channel === "instagram")!;
    await expectMarketingError(
      as(t, ORG_B).query(api.v1.whatsapp.getConversation, {
        conversationId: whatsappRow.conversationId,
      }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      as(t, ORG_B).query(api.v1.instagramMessaging.getConversation, {
        conversationId: instagramRow.conversationId,
      }),
      "NOT_FOUND",
    );
    // Org A's own channel APIs answer for the ids it lists (unchanged contracts).
    expect(
      (
        await as(t, { role: "viewer" }).query(api.v1.whatsapp.getConversation, {
          conversationId: whatsappRow.conversationId,
        })
      ).id,
    ).toBe(whatsappRow.conversationId);
  });

  it("filters by channel", async () => {
    const { t } = await setup();
    await whatsapp(t, "wamid.1");
    await instagram(t, "mid.1");
    expect((await list(t, { channel: "whatsapp" })).page.map((r) => r.channel)).toEqual([
      "whatsapp",
    ]);
    expect((await list(t, { channel: "instagram" })).page.map((r) => r.channel)).toEqual([
      "instagram",
    ]);
    await expect(list(t, { channel: "messenger" })).rejects.toThrow(/Validator/);
  });

  it("pages newest first with stable cursors, also while new messages arrive", async () => {
    const { t } = await setup();
    for (let i = 0; i < 4; i++) {
      await whatsapp(t, `wamid.${i}`, `1555000100${i}`);
      vi.advanceTimersByTime(60_000);
      await instagram(t, `mid.${i}`, `555000000000010${i}`);
      vi.advanceTimersByTime(60_000);
    }
    const all = (await list(t)).page;
    expect(all).toHaveLength(8);
    const times = all.map((row) => row.lastMessageAt);
    expect([...times].sort().reverse()).toEqual(times);

    const first = await list(t, { paginationOpts: { numItems: 3, cursor: null } });
    expect(first.page.map((r) => r.id)).toEqual(all.slice(0, 3).map((r) => r.id));
    // A new conversation arrives between pages: the next pages still continue where the first
    // ended, with no row twice and none skipped.
    await whatsapp(t, "wamid.new", "15550009999");
    const seen = [...first.page.map((r) => r.id)];
    let cursor: string | null = first.continueCursor;
    for (;;) {
      const next = await list(t, { paginationOpts: { numItems: 3, cursor } });
      seen.push(...next.page.map((r) => r.id));
      if (next.isDone) break;
      cursor = next.continueCursor;
    }
    expect(seen).toEqual(all.map((r) => r.id));
  });

  it("skips rows whose conversation is gone, of another org or malformed", async () => {
    const { t, orgA, orgB } = await setup();
    await whatsapp(t, "wamid.1");
    await whatsapp(t, "wamid.2", "15550002222");
    await instagram(t, "mid.1");
    const rows = (await list(t)).page;
    const [gone] = rows.filter((r) => r.channel === "whatsapp");
    await t.run(async (ctx) => {
      await ctx.db.delete(gone!.conversationId as Id<"whatsappConversations">);
      const conversation = (await ctx.db.query("instagramConversations").first())!;
      // Planted rows: org B pointing at org A's conversation, and a malformed row of org A.
      await ctx.db.insert("inboxThreads", {
        orgId: orgB,
        channel: "instagram",
        instagramConversationId: conversation._id,
        lastMessageAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await ctx.db.insert("inboxThreads", {
        orgId: orgA,
        channel: "whatsapp",
        lastMessageAt: NOW + 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    const after = (await list(t)).page;
    expect(after.map((r) => r.conversationId).sort()).toEqual(
      rows
        .map((r) => r.conversationId)
        .filter((id) => id !== gone!.conversationId)
        .sort(),
    );
    expect((await list(t, {}, ORG_B)).page).toEqual([]);
  });
});

describe("labels and privacy", () => {
  it("labels a WhatsApp contact by name, else by phone number, and the account by its display number", async () => {
    const { t } = await setup();
    await whatsapp(t, "wamid.1", CUSTOMER_1);
    const [row] = (await list(t, { channel: "whatsapp" })).page;
    expect(row).toMatchObject({ contactLabel: `+${CUSTOMER_1}`, accountLabel: "+1 555-000-0001" });
    const text = JSON.stringify(await list(t));
    expect(text).not.toContain(PHONE_A); // Meta's phone number id
    expect(text).not.toContain("wamid.");
    expect(text).not.toContain("EAAG");
  });

  it("labels an Instagram contact by @username, else name, and never shows its Instagram id", async () => {
    const { t } = await setup();
    await instagram(t, "mid.1");
    const conversationId = (await list(t)).page[0]!.conversationId as Id<"instagramConversations">;
    const label = async () => (await list(t, { channel: "instagram" })).page[0]!.contactLabel;
    expect(await label()).toBe("Instagram user");
    await t.run((ctx) => ctx.db.patch(conversationId, { contactName: "Ana Lisboa" }));
    expect(await label()).toBe("Ana Lisboa");
    await t.run((ctx) => ctx.db.patch(conversationId, { contactUsername: "ana.lisboa" }));
    expect(await label()).toBe("@ana.lisboa");

    const text = JSON.stringify(await list(t));
    for (const value of [IG_CUSTOMER, IG_ACCOUNT, "mid.", "IGAA"]) {
      expect(text).not.toContain(value);
    }
  });
});

describe("reply state", () => {
  it("WhatsApp: open in the window, closed after it, unavailable when the number cannot send", async () => {
    const { t } = await setup();
    await whatsapp(t, "wamid.1");
    const state = async () => (await list(t, { channel: "whatsapp" })).page[0]!.replyState;
    expect(await state()).toBe("open");

    const row = async () => (await list(t)).page[0]!;
    vi.setSystemTime(Date.parse((await row()).replyWindowExpiresAt!) + 1);
    expect(await state()).toBe("closed");

    vi.setSystemTime(NOW);
    await t.run(async (ctx) => {
      const connection = (await ctx.db.query("connections").collect()).find(
        (c) => c.provider === "whatsapp",
      )!;
      await ctx.db.patch(connection._id, { status: "needs_reauth" });
    });
    expect(await state()).toBe("unavailable"); // even with the window open
  });

  it("Instagram: open, closed, and unavailable when sendText would refuse whatever the window", async () => {
    const { t, instagram: holder } = await setup();
    await instagram(t, "mid.1");
    const state = async () => (await list(t, { channel: "instagram" })).page[0]!.replyState;
    expect(await state()).toBe("open");

    const row = async () => (await list(t)).page[0]!;
    vi.setSystemTime(Date.parse((await row()).replyWindowExpiresAt!) + 1);
    expect(await state()).toBe("closed");

    vi.setSystemTime(NOW);
    await t.run((ctx) => ctx.db.patch(holder.accountId, { status: "action_required" }));
    expect(await state()).toBe("unavailable");

    await t.run((ctx) => ctx.db.patch(holder.accountId, { status: "active" }));
    vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-otter-123.convex.cloud"); // flag unset on cloud
    expect(await state()).toBe("unavailable");
  });

  it("a conversation the customer never wrote in is closed, not open", async () => {
    const { t } = await setup();
    await instagram(t, "mid.1");
    const conversationId = (await list(t)).page[0]!.conversationId as Id<"instagramConversations">;
    await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: undefined }));
    const [row] = (await list(t)).page;
    expect(row!.replyState).toBe("closed");
    expect(row!.replyWindowExpiresAt).toBeUndefined();
    expect(row!.lastInboundAt).toBeUndefined();
  });
});
