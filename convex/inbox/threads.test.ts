import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  customerMessage as igMessage,
  delivery as igDelivery,
  entry as igEntry,
  postDelivery as postIgDelivery,
  seedHolder,
  stubInstagramWebhookEnv,
} from "../instagram/messaging/fakeWebhook.fixtures";
import { as, ISSUER_CRM, ISSUER_ERP, newBackend, seedOrg, type Backend } from "../test.helpers";
import { installFakeWhatsAppGraph, type FakeWhatsAppGraph } from "../whatsapp/fakeGraph.fixtures";
import {
  CUSTOMER_1,
  CUSTOMER_2,
  delivery,
  entry,
  PHONE_A,
  postDelivery,
  WABA_A,
} from "../whatsapp/fakeWebhook.fixtures";

// ADR 0018 (IM7.2): the unified inbox's thread index follows every channel conversation (real
// WhatsApp and Instagram ingestion, sends and purge, against the existing fakes), and the
// operator backfill and check find and repair missing, stale, duplicated and orphaned rows.

vi.setConfig({ testTimeout: 120_000 });
const HOUR = 60 * 60 * 1000;
const BACKFILL = internal.inbox.threads.backfill;
const CHECK = internal.inbox.threads.check;

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
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const run = (t: Backend) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 1_000);

/** Org A with a connected WhatsApp number and an Instagram account holding messaging. */
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

async function whatsappInbound(t: Backend, wamid: string, from = CUSTOMER_1) {
  const response = await postDelivery(
    t,
    delivery(entry({ phoneNumberId: PHONE_A, messages: [{ id: wamid, from, text: "Hi" }] })),
  );
  expect(response.status).toBe(200);
  await run(t);
}

async function instagramInbound(t: Backend, mid: string, customer?: string) {
  const response = await postIgDelivery(
    t,
    igDelivery(igEntry([igMessage(mid, { ...(customer !== undefined ? { customer } : {}) })])),
  );
  expect(response.status).toBe(200);
  await run(t);
}

async function db(t: Backend) {
  return await t.run(async (ctx) => ({
    threads: await ctx.db.query("inboxThreads").collect(),
    whatsapp: await ctx.db.query("whatsappConversations").collect(),
    instagram: await ctx.db.query("instagramConversations").collect(),
  }));
}

/** The check over every page of every phase, two rows at a time. */
async function checkAll(t: Backend) {
  const report = { missing: [] as string[], stale: [] as string[], duplicated: [] as string[] };
  const orphaned: string[] = [];
  for (const phase of ["whatsapp", "instagram", "threads"] as const) {
    let cursor: string | undefined;
    for (;;) {
      const page = await t.query(CHECK, { phase, batch: 2, ...(cursor ? { cursor } : {}) });
      report.missing.push(...page.missing);
      report.stale.push(...page.stale);
      report.duplicated.push(...page.duplicated);
      orphaned.push(...page.orphaned);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }
  return { ...report, orphaned };
}
const CLEAN = { missing: [], stale: [], duplicated: [], orphaned: [] };

/** Every conversation has exactly one row of its org and channel with its lastMessageAt. */
async function expectConsistent(t: Backend) {
  const state = await db(t);
  expect(state.threads).toHaveLength(state.whatsapp.length + state.instagram.length);
  for (const conversation of state.whatsapp) {
    const rows = state.threads.filter((r) => r.whatsappConversationId === conversation._id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: conversation.orgId,
      channel: "whatsapp",
      lastMessageAt: conversation.lastMessageAt,
    });
    expect(rows[0]!.instagramConversationId).toBeUndefined();
  }
  for (const conversation of state.instagram) {
    const rows = state.threads.filter((r) => r.instagramConversationId === conversation._id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: conversation.orgId,
      channel: "instagram",
      lastMessageAt: conversation.lastMessageAt,
    });
    expect(rows[0]!.whatsappConversationId).toBeUndefined();
  }
  expect(await checkAll(t)).toEqual(CLEAN);
}

describe("thread rows follow the channels' conversations", () => {
  it("WhatsApp: created by the first message, moved by later ones and by a reply, once per delivery", async () => {
    const { t, orgA } = await setup();
    await whatsappInbound(t, "wamid.1");
    let state = await db(t);
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0]).toMatchObject({
      orgId: orgA,
      channel: "whatsapp",
      whatsappConversationId: state.whatsapp[0]!._id,
    });
    const first = state.threads[0]!;

    // The same delivery again changes nothing.
    await whatsappInbound(t, "wamid.1");
    expect((await db(t)).threads).toEqual([first]);

    vi.advanceTimersByTime(HOUR);
    await whatsappInbound(t, "wamid.2");
    state = await db(t);
    expect(state.threads[0]!.lastMessageAt).toBe(state.whatsapp[0]!.lastMessageAt);
    expect(state.threads[0]!.lastMessageAt).toBeGreaterThan(first.lastMessageAt);

    vi.advanceTimersByTime(60_000);
    await as(t, { role: "editor" }).mutation(api.v1.whatsapp.sendText, {
      conversationId: state.whatsapp[0]!._id,
      text: "On its way",
      clientMessageId: "client-msg-0001",
    });
    state = await db(t);
    expect(state.threads[0]!.lastMessageAt).toBe(Date.now());

    await whatsappInbound(t, "wamid.3", CUSTOMER_2);
    await expectConsistent(t);
    expect((await db(t)).threads).toHaveLength(2);
  });

  it("Instagram: created and moved the same way; the purge removes it with its conversation", async () => {
    const { t, orgA, instagram } = await setup();
    await instagramInbound(t, "mid.1");
    let state = await db(t);
    expect(state.threads).toEqual([
      expect.objectContaining({
        orgId: orgA,
        channel: "instagram",
        instagramConversationId: state.instagram[0]!._id,
        lastMessageAt: state.instagram[0]!.lastMessageAt,
      }),
    ]);
    const first = state.threads[0]!;
    await instagramInbound(t, "mid.1"); // repeated delivery
    expect((await db(t)).threads).toEqual([first]);

    vi.advanceTimersByTime(60_000);
    await as(t, { role: "editor" }).mutation(api.v1.instagramMessaging.sendText, {
      accountId: instagram.accountId,
      conversationId: state.instagram[0]!._id,
      text: "Thanks!",
      clientMessageId: "client-msg-0002",
    });
    await run(t);
    state = await db(t);
    expect(state.threads[0]!.lastMessageAt).toBe(state.instagram[0]!.lastMessageAt);
    expect(state.threads[0]!.lastMessageAt).toBeGreaterThan(first.lastMessageAt);
    await instagramInbound(t, "mid.2", "5550000000000099");
    await expectConsistent(t);

    // A data-deletion purge (D14) deletes the conversations: their rows go too.
    await whatsappInbound(t, "wamid.1");
    await t.mutation(internal.instagram.messaging.purge.requestMessagingDataDeletion, {
      orgId: orgA,
      accountId: instagram.accountId,
    });
    await run(t);
    state = await db(t);
    expect(state.instagram).toEqual([]);
    expect(state.threads.map((r) => r.channel)).toEqual(["whatsapp"]);
    await expectConsistent(t);
  });

  it("keeps every org's rows to its own conversations", async () => {
    const { t, orgA, orgB } = await setup();
    await whatsappInbound(t, "wamid.1");
    await seedHolder(t, { orgId: orgB, issuer: ISSUER_CRM }, { igAccountId: "17841400000000909" });
    const response = await postIgDelivery(
      t,
      igDelivery(
        igEntry([igMessage("mid.b", { account: "17841400000000909" })], "17841400000000909"),
      ),
    );
    expect(response.status).toBe(200);
    await run(t);

    const state = await db(t);
    expect(state.threads.map((r) => [r.channel, r.orgId]).sort()).toEqual(
      [
        ["instagram", orgB],
        ["whatsapp", orgA],
      ].sort(),
    );
    // A row claiming org A's conversation for org B is never matched: reported and removed.
    const intruder = await t.run((ctx) =>
      ctx.db.insert("inboxThreads", {
        orgId: orgB,
        channel: "whatsapp",
        whatsappConversationId: state.whatsapp[0]!._id,
        lastMessageAt: 1,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    expect(await checkAll(t)).toEqual({ ...CLEAN, orphaned: [intruder] });
    await whatsappInbound(t, "wamid.2"); // org A's write leaves org B's row alone
    expect((await db(t)).threads.find((r) => r._id === intruder)!.lastMessageAt).toBe(1);
    await t.mutation(BACKFILL, {});
    await run(t);
    await expectConsistent(t);
  });
});

describe("operator backfill and check", () => {
  /** Five WhatsApp and three Instagram conversations, then their rows removed (as before IM7.2). */
  async function conversationsWithoutThreads() {
    const context = await setup();
    const { t } = context;
    for (let i = 0; i < 5; i++) await whatsappInbound(t, `wamid.${i}`, `1555000100${i}`);
    for (let i = 0; i < 3; i++) await instagramInbound(t, `mid.${i}`, `555000000000010${i}`);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("inboxThreads").collect()) await ctx.db.delete(row._id);
    });
    return context;
  }

  it("creates the missing rows page by page, resumes from its cursor, and is repeatable", async () => {
    const { t } = await conversationsWithoutThreads();
    expect((await checkAll(t)).missing).toHaveLength(8);

    // One page per call, as an operator resuming an interrupted backfill would.
    const totals = { created: 0, updated: 0, removed: 0 };
    const steps: string[] = [];
    let args: { phase?: "whatsapp" | "instagram" | "threads"; cursor?: string } = {};
    for (;;) {
      const step = await t.mutation(BACKFILL, { ...args, batch: 2, chain: false });
      steps.push(step.phase);
      totals.created += step.created;
      totals.updated += step.updated;
      totals.removed += step.removed;
      if (!step.isDone) args = { phase: step.phase, cursor: step.continueCursor };
      else if (step.phase === "whatsapp") args = { phase: "instagram" };
      else if (step.phase === "instagram") args = { phase: "threads" };
      else break;
    }
    expect(totals).toEqual({ created: 8, updated: 0, removed: 0 });
    expect(new Set(steps)).toEqual(new Set(["whatsapp", "instagram", "threads"]));
    expect(steps.filter((p) => p === "whatsapp").length).toBeGreaterThan(1); // more than one page
    await expectConsistent(t);

    // Running it again (chained this time) changes nothing.
    const before = (await db(t)).threads;
    await t.mutation(BACKFILL, { batch: 2 });
    await run(t);
    expect((await db(t)).threads).toEqual(before);
  });

  it("reports missing, stale, duplicated and orphaned rows; the backfill repairs them all", async () => {
    const { t, orgA } = await conversationsWithoutThreads();
    await t.mutation(BACKFILL, {});
    await run(t);
    const state = await db(t);
    const [missing, stale, duplicated] = state.whatsapp.map((c) => c._id) as [
      Id<"whatsappConversations">,
      Id<"whatsappConversations">,
      Id<"whatsappConversations">,
    ];
    const threadOf = (id: Id<"whatsappConversations">) =>
      state.threads.find((r) => r.whatsappConversationId === id)!;
    const orphaned = await t.run(async (ctx) => {
      await ctx.db.delete(threadOf(missing)._id);
      await ctx.db.patch(threadOf(stale)._id, { lastMessageAt: 1 });
      const copy = threadOf(duplicated);
      await ctx.db.insert("inboxThreads", {
        orgId: copy.orgId,
        channel: "whatsapp",
        whatsappConversationId: duplicated,
        lastMessageAt: copy.lastMessageAt,
        createdAt: 1,
        updatedAt: 1,
      });
      // Gone conversation, and a row whose reference does not match its channel.
      const gone = await ctx.db.insert("inboxThreads", {
        orgId: orgA,
        channel: "instagram",
        instagramConversationId: state.instagram[0]!._id,
        lastMessageAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.delete(state.instagram[0]!._id);
      const mismatched = await ctx.db.insert("inboxThreads", {
        orgId: orgA,
        channel: "whatsapp",
        instagramConversationId: state.instagram[1]!._id,
        lastMessageAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      return [gone, mismatched];
    });

    const report = await checkAll(t);
    expect(report.missing).toEqual([missing]);
    expect(report.stale).toEqual([stale]);
    expect(report.duplicated).toEqual([duplicated]);
    // The deleted conversation's own row, and the two planted rows.
    const ownRow = state.threads.find(
      (r) => r.instagramConversationId === state.instagram[0]!._id,
    )!;
    expect([...report.orphaned].sort()).toEqual([ownRow._id, ...orphaned].sort());

    await t.mutation(BACKFILL, { batch: 2 });
    await run(t);
    await expectConsistent(t);
  });
});
