import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { isMarketingError } from "../lib/errors";
import { as, ISSUER_ERP, newBackend, seedOrg, type Backend } from "../test.helpers";
import { COEXISTENCE_IMPORT_WINDOW_MS, INGEST_BATCH_SIZE } from "./config";
import {
  createFakeWhatsAppGraph,
  graphError,
  installFakeWhatsAppGraph,
  type FakeWhatsAppGraph,
} from "./fakeGraph.fixtures";
import {
  contactsEntry,
  CUSTOMER_1,
  CUSTOMER_2,
  delivery,
  echoEntry,
  entry,
  historyEntry,
  nowSeconds,
  partnerRemovedEntry,
  PHONE_A,
  PHONE_B,
  postDelivery,
  WABA_A,
  WABA_B,
} from "./fakeWebhook.fixtures";
import { ingestBatches } from "./webhook";

// ADR 0019: WhatsApp coexistence (a number kept in the WhatsApp Business app), against the fake
// Graph and signed fake webhooks in Meta's documented shapes (Meta "Onboarding WhatsApp Business
// app users", 2026-11-03). Nothing here calls Meta, and nothing here is evidence of real Meta
// behavior: the shapes stay PROVISIONAL until a real coexistence signup.

const TOKEN = "EAAG-test-business-token-coexistence";
const PHONE_A2 = "200000000000003";
const HOUR_MS = 60 * 60 * 1000;
const PAGE = { paginationOpts: { numItems: 100, cursor: null } };

let graph: FakeWhatsAppGraph;

beforeEach(() => {
  graph = installFakeWhatsAppGraph(createFakeWhatsAppGraph());
  graph.addWaba({
    id: WABA_A,
    name: "Coexistence Business",
    numbers: [{ id: PHONE_A, display_phone_number: "+91 98683 00000" }],
  });
  graph.addWaba({
    id: WABA_B,
    name: "Two numbers",
    numbers: [
      { id: PHONE_B, display_phone_number: "+1 555-000-0002" },
      { id: PHONE_A2, display_phone_number: "+1 555-000-0003" },
    ],
  });
  graph.setNumberPlatform(PHONE_A, { onBusinessApp: true, platformType: "CLOUD_API" });
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Input = { wabaId?: string; phoneNumberId?: string | null; onboarding?: "coexistence" | null };

async function complete(t: Backend, input: Input = {}) {
  const wabaId = input.wabaId ?? WABA_A;
  const phoneNumberId = input.phoneNumberId === undefined ? PHONE_A : input.phoneNumberId;
  return await as(t).action(api.v1.whatsapp.completeSignup, {
    code: graph.issueCode({ token: TOKEN, sharedWabas: [wabaId] }),
    wabaId,
    ...(phoneNumberId !== null ? { phoneNumberId } : {}),
    ...(input.onboarding !== null ? { onboarding: input.onboarding ?? "coexistence" } : {}),
  });
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isMarketingError(error)) throw error;
    return error.data;
  }
  throw new Error("expected the call to fail");
}

async function rows(t: Backend) {
  return await t.run(async (ctx) => ({
    connections: await ctx.db.query("connections").collect(),
    credentials: await ctx.db.query("credentials").collect(),
    accounts: await ctx.db.query("whatsappBusinessAccounts").collect(),
    numbers: await ctx.db.query("whatsappPhoneNumbers").collect(),
    conversations: await ctx.db.query("whatsappConversations").collect(),
    messages: await ctx.db.query("whatsappMessages").collect(),
    contacts: await ctx.db.query("whatsappContacts").collect(),
    threads: await ctx.db.query("inboxThreads").collect(),
  }));
}

function routes() {
  return graph.log.map((call) => call.route);
}

/** A connected coexistence number for org A, connected an hour before "now". */
async function connected() {
  vi.useFakeTimers();
  const t = newBackend();
  const orgId = await seedOrg(t, ISSUER_ERP, "42");
  const now = Date.now();
  vi.setSystemTime(now - HOUR_MS);
  const result = await complete(t);
  vi.setSystemTime(now);
  expect(result.status).toBe("connected");
  return { t, orgId };
}

async function processAll(t: Backend) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function conversationsDto(t: Backend) {
  return (await as(t).query(api.v1.whatsapp.listConversations, PAGE)).page;
}

async function messagesDto(t: Backend, conversationId: string) {
  return (await as(t).query(api.v1.whatsapp.listMessages, { conversationId, ...PAGE })).page;
}

describe("coexistence signup", () => {
  it("connects a WhatsApp Business app number: confirmed with Meta, never registered, contacts then history imported once", async () => {
    const t = newBackend();
    const orgId = await seedOrg(t);
    const result = await complete(t);
    expect(result).toEqual({ accountId: expect.any(String), status: "connected" });

    expect(routes()).toEqual([
      "exchange",
      "debug_token",
      "waba",
      "phone_numbers",
      "number_platform",
      "subscribe",
      "app_data",
      "app_data",
    ]);
    expect(graph.registered.size).toBe(0);
    expect(graph.appDataRequests).toEqual([
      { phoneNumberId: PHONE_A, syncType: "smb_app_state_sync", requestId: "fake-request-1" },
      { phoneNumberId: PHONE_A, syncType: "history", requestId: "fake-request-2" },
    ]);

    const { accounts, numbers } = await rows(t);
    expect(accounts).toEqual([
      expect.objectContaining({ orgId, wabaId: WABA_A, onboardingType: "coexistence" }),
    ]);
    expect(numbers).toEqual([
      expect.objectContaining({
        orgId,
        phoneNumberId: PHONE_A,
        source: "embedded_signup",
        platformRegisteredAt: expect.any(Number),
        coexistence: {
          onboardedAt: expect.any(Number),
          contactsImportedAt: expect.any(Number),
          contactsRequestId: "fake-request-1",
          historyImportedAt: expect.any(Number),
          historyRequestId: "fake-request-2",
          importAttempts: 1,
        },
      }),
    ]);

    const [account] = await as(t, { role: "viewer" }).query(api.v1.whatsapp.listAccounts, {});
    expect(account).toMatchObject({ onboardingType: "coexistence", setupStatus: "connected" });
    expect(account!.numbers).toEqual([
      expect.objectContaining({ businessApp: true, imported: true, registered: true }),
    ]);
    expect(account!.numbers[0]!.importDeadline).toBeUndefined();

    // A retry never requests an accepted import again.
    await as(t).action(api.v1.whatsapp.retrySetup, { accountId: result.accountId });
    expect(graph.calls("app_data")).toBe(2);
  });

  it("keeps finished imports on a reconnect while the number stays connected, and starts over after a disconnect", async () => {
    const t = newBackend();
    await seedOrg(t);
    const first = await complete(t);
    expect(graph.calls("app_data")).toBe(2);

    // A new signup for the same connected number (e.g. after Meta refused the token).
    const again = await complete(t);
    expect(again).toEqual({ accountId: first.accountId, status: "connected" });
    expect(graph.calls("app_data")).toBe(2);

    // After a disconnect, a new signup is a new onboarding at Meta: a new import window.
    await as(t).action(api.v1.whatsapp.disconnectAccount, { accountId: first.accountId });
    graph.appDataRequests.length = 0;
    const later = await complete(t);
    expect(later.status).toBe("connected");
    expect(graph.appDataRequests.map((r) => r.syncType)).toEqual(["smb_app_state_sync", "history"]);
  });

  it("refuses a number Meta does not report on the WhatsApp Business app; nothing is stored or registered", async () => {
    const t = newBackend();
    await seedOrg(t);
    graph.setNumberPlatform(PHONE_A, { onBusinessApp: false, platformType: "CLOUD_API" });
    const data = await refusal(complete(t));
    expect(data).toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "not_business_app_number" },
    });
    const { connections, credentials, accounts, numbers } = await rows(t);
    expect([connections, credentials, accounts, numbers]).toEqual([[], [], [], []]);
    expect(routes()).not.toContain("subscribe");
    expect(routes()).not.toContain("register");
    expect(routes()).not.toContain("app_data");
  });

  it("refuses when Meta cannot be asked about the number (nothing stored)", async () => {
    const t = newBackend();
    await seedOrg(t);
    graph.failNext("number_platform", "network");
    const data = await refusal(complete(t));
    expect(data).toMatchObject({ code: "PROVIDER_ERROR", details: { stage: "phone_number" } });
    expect((await rows(t)).accounts).toEqual([]);
  });

  it("uses the WABA's only number when Meta's finish carries no number id, and refuses with several", async () => {
    const t = newBackend();
    await seedOrg(t);
    const single = await complete(t, { phoneNumberId: null });
    expect(single.status).toBe("connected");
    expect((await rows(t)).numbers.map((n) => n.phoneNumberId)).toEqual([PHONE_A]);

    const t2 = newBackend();
    await seedOrg(t2);
    graph.setNumberPlatform(PHONE_B, { onBusinessApp: true });
    const data = await refusal(complete(t2, { wabaId: WABA_B, phoneNumberId: null }));
    expect(data).toMatchObject({ details: { reason: "phone_number_missing" } });
  });

  it("still requires the number id for a Cloud API signup", async () => {
    const t = newBackend();
    await seedOrg(t);
    const data = await refusal(complete(t, { phoneNumberId: null, onboarding: null }));
    expect(data).toMatchObject({ details: { reason: "invalid_id" } });
    expect(graph.calls()).toBe(0);
  });

  it("leaves the setup unfinished when an import fails; retrySetup requests only what is missing", async () => {
    const t = newBackend();
    await seedOrg(t);
    graph.failNext("app_data", graphError(1, 500));
    const result = await complete(t);
    expect(result).toEqual({
      accountId: result.accountId,
      status: "action_required",
      nextStep: "import",
      reason: "meta_1",
    });
    // The history import waits for the contacts import (Meta's order).
    expect(graph.calls("app_data")).toBe(1);
    expect(graph.appDataRequests).toEqual([]);

    const [account] = await as(t).query(api.v1.whatsapp.listAccounts, {});
    expect(account).toMatchObject({ setupStatus: "action_required", nextStep: "import" });
    expect(account!.numbers[0]).toMatchObject({
      businessApp: true,
      imported: false,
      importDeadline: expect.any(String),
    });

    const retried = await as(t).action(api.v1.whatsapp.retrySetup, { accountId: result.accountId });
    expect(retried).toEqual({ accountId: result.accountId, status: "connected" });
    expect(graph.appDataRequests.map((r) => r.syncType)).toEqual(["smb_app_state_sync", "history"]);
  });

  it("requests nothing after Meta's 24 hours: the admin is told to sign up again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = newBackend();
    await seedOrg(t);
    graph.failNext("app_data", "network");
    const result = await complete(t);
    expect(result.nextStep).toBe("import");
    vi.setSystemTime(Date.now() + COEXISTENCE_IMPORT_WINDOW_MS + 1000);
    const calls = graph.calls("app_data");
    const retried = await as(t).action(api.v1.whatsapp.retrySetup, { accountId: result.accountId });
    expect(retried).toMatchObject({ status: "action_required", reason: "import_expired" });
    expect(graph.calls("app_data")).toBe(calls);
  });

  it("moves the connection to reauthorization when Meta refuses the token during an import", async () => {
    const t = newBackend();
    await seedOrg(t);
    graph.failNext("app_data", graphError(190, 401));
    const result = await complete(t);
    expect(result.status).toBe("reauthorization_required");
    const { connections } = await rows(t);
    expect(connections[0]!.status).toBe("needs_reauth");
  });

  it("sends replies from a coexistence number without any registration", async () => {
    const { t } = await connected();
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.in.1", text: "hello" }] })));
    await processAll(t);
    const [conversation] = await conversationsDto(t);
    await as(t).mutation(api.v1.whatsapp.sendText, {
      conversationId: conversation!.id,
      text: "Thanks!",
      clientMessageId: "client-message-0001",
    });
    // One second at a time: the send finishes long before its 5-minute watchdog.
    await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 1_000);
    expect(graph.sent.map((m) => m.phoneNumberId)).toEqual([PHONE_A]);
    expect(graph.registered.size).toBe(0);
  });
});

describe("coexistence webhooks", () => {
  it("stores a message sent from the WhatsApp Business app as sent, without opening the reply window", async () => {
    const { t, orgId } = await connected();
    const response = await postDelivery(
      t,
      delivery(echoEntry([{ id: "wamid.echo.1", text: "sent on the phone" }])),
    );
    expect(response.status).toBe(200);
    await processAll(t);

    const { conversations, messages, threads } = await rows(t);
    expect(conversations).toEqual([expect.objectContaining({ orgId, contactWaId: CUSTOMER_1 })]);
    expect(conversations[0]!.lastInboundAt).toBeUndefined();
    expect(messages).toEqual([
      expect.objectContaining({
        direction: "outbound",
        wamid: "wamid.echo.1",
        text: "sent on the phone",
        status: "sent",
        origin: "business_app",
        sentAt: expect.any(Number),
      }),
    ]);
    expect(threads).toHaveLength(1);

    const [conversation] = await conversationsDto(t);
    expect(conversation!.serviceWindowExpiresAt).toBeUndefined();
    const [dto] = await messagesDto(t, conversation!.id);
    expect(dto).toMatchObject({ direction: "outbound", origin: "business_app", status: "sent" });

    // Meta's later statuses move it forward like any outbound message.
    await postDelivery(t, delivery(entry({ statuses: [{ id: "wamid.echo.1", status: "read" }] })));
    await processAll(t);
    expect((await rows(t)).messages[0]!.status).toBe("read");
  });

  it("imports the chat history from before the signup, both sides, without opening the reply window", async () => {
    const { t } = await connected();
    const twoDaysAgo = nowSeconds() - 48 * 3600;
    await postDelivery(
      t,
      delivery(
        historyEntry([
          {
            contact: CUSTOMER_2,
            messages: [
              { id: "wamid.h.1", timestamp: twoDaysAgo, text: "do you deliver?" },
              { id: "wamid.h.2", timestamp: twoDaysAgo + 60, fromBusiness: true, text: "yes" },
            ],
          },
        ]),
      ),
    );
    await processAll(t);

    const { conversations, messages } = await rows(t);
    expect(conversations).toEqual([
      expect.objectContaining({
        contactWaId: CUSTOMER_2,
        lastMessageAt: (twoDaysAgo + 60) * 1000,
      }),
    ]);
    expect(conversations[0]!.lastInboundAt).toBeUndefined();
    expect(messages.map((m) => [m.wamid, m.direction, m.status, m.origin, m.platformAt])).toEqual([
      ["wamid.h.1", "inbound", "received", "history", twoDaysAgo * 1000],
      ["wamid.h.2", "outbound", "read", "history", (twoDaysAgo + 60) * 1000],
    ]);
    const [conversation] = await conversationsDto(t);
    expect(conversation!.serviceWindowExpiresAt).toBeUndefined();
  });

  it("stores a message seen live and again in the history once", async () => {
    const { t } = await connected();
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.live", text: "live" }] })));
    await processAll(t);
    await postDelivery(
      t,
      delivery(
        historyEntry([
          {
            contact: CUSTOMER_1,
            messages: [
              { id: "wamid.live", timestamp: nowSeconds(), text: "live" },
              { id: "wamid.older", timestamp: nowSeconds() - 3600, text: "older" },
            ],
          },
        ]),
      ),
    );
    await processAll(t);
    const { messages, conversations } = await rows(t);
    expect(messages.map((m) => [m.wamid, m.origin])).toEqual([
      ["wamid.live", undefined],
      ["wamid.older", "history"],
    ]);
    // The live message opened the window; the import changed nothing about it.
    expect(conversations[0]!.lastInboundAt).toBeDefined();
  });

  it("names conversations after the contacts saved in the app, and drops a removed contact's name", async () => {
    const { t } = await connected();
    const at = nowSeconds();
    await postDelivery(
      t,
      delivery(contactsEntry([{ phone: "+1 555-000-1111", name: "Asha Rao", timestamp: at }])),
    );
    await processAll(t);
    expect((await rows(t)).contacts).toEqual([
      expect.objectContaining({ waId: CUSTOMER_1, name: "Asha Rao", changedAt: at * 1000 }),
    ]);

    // A conversation created later (here by the customer, with their own profile name) shows
    // the saved name.
    await postDelivery(
      t,
      delivery(entry({ messages: [{ id: "wamid.named", text: "hi", name: "asha" }] })),
    );
    await processAll(t);
    expect((await conversationsDto(t))[0]!.contactName).toBe("Asha Rao");

    // An older change is ignored; a removal shows the profile name again.
    await postDelivery(
      t,
      delivery(contactsEntry([{ phone: "+15550001111", name: "Old", timestamp: at - 10 }])),
    );
    await postDelivery(
      t,
      delivery(contactsEntry([{ phone: "+15550001111", action: "remove", timestamp: at + 10 }])),
    );
    await processAll(t);
    expect((await rows(t)).contacts).toEqual([]);
    expect((await conversationsDto(t))[0]!.contactName).toBe("asha");
  });

  it("drops coexistence events for a number that is not a coexistence number", async () => {
    vi.useFakeTimers();
    const t = newBackend();
    await seedOrg(t);
    graph.addWaba({
      id: "100000000000009",
      name: "Cloud",
      numbers: [{ id: "200000000000009", display_phone_number: "+1 555-000-0009" }],
    });
    const now = Date.now();
    vi.setSystemTime(now - HOUR_MS);
    await as(t).action(api.v1.whatsapp.completeSignup, {
      code: graph.issueCode({ token: TOKEN, sharedWabas: ["100000000000009"] }),
      wabaId: "100000000000009",
      phoneNumberId: "200000000000009",
    });
    vi.setSystemTime(now);
    const target = { wabaId: "100000000000009", phoneNumberId: "200000000000009" };
    const response = await postDelivery(
      t,
      delivery(
        echoEntry([{ id: "wamid.echo.x" }], target),
        historyEntry(
          [{ contact: CUSTOMER_1, messages: [{ id: "wamid.h.x", timestamp: 1 }] }],
          target,
        ),
        contactsEntry([{ phone: "+15550001111", name: "X" }], target),
      ),
    );
    expect(response.status).toBe(200);
    await processAll(t);
    const { messages, contacts } = await rows(t);
    expect([messages, contacts]).toEqual([[], []]);
  });

  it("stores a history delivery larger than one ingest batch in full", async () => {
    const { t } = await connected();
    const base = nowSeconds() - 7 * 24 * 3600;
    const count = INGEST_BATCH_SIZE + 20;
    const response = await postDelivery(
      t,
      delivery(
        historyEntry([
          {
            contact: CUSTOMER_2,
            messages: Array.from({ length: count }, (_, i) => ({
              id: `wamid.bulk.${i}`,
              timestamp: base + i,
            })),
          },
        ]),
      ),
    );
    expect(response.status).toBe(200);
    await processAll(t);
    expect((await rows(t)).messages).toHaveLength(count);
  });
});

describe("ingestBatches", () => {
  const change = (n: number, phoneNumberId = PHONE_A) => ({
    wabaId: WABA_A,
    phoneNumberId,
    events: Array.from({ length: n }, (_, i) => ({
      kind: "message" as const,
      wamid: `w.${phoneNumberId}.${i}`,
      from: CUSTOMER_1,
      timestampMs: i,
      messageType: "text" as const,
    })),
  });

  it("keeps a usual delivery in one batch and splits larger ones in order", () => {
    expect(ingestBatches([change(3), change(2, PHONE_B)], 10)).toEqual([
      [change(3), change(2, PHONE_B)],
    ]);
    const batches = ingestBatches([change(5), change(4, PHONE_B)], 4);
    expect(batches.map((b) => b.map((c) => [c.phoneNumberId, c.events.length]))).toEqual([
      [[PHONE_A, 4]],
      [
        [PHONE_A, 1],
        [PHONE_B, 3],
      ],
      [[PHONE_B, 1]],
    ]);
    expect(
      batches.flat().flatMap((c) => c.events.map((e) => (e.kind === "contact" ? e.waId : e.wamid))),
    ).toEqual([
      ...change(5).events.map((e) => e.wamid),
      ...change(4, PHONE_B).events.map((e) => e.wamid),
    ]);
  });
});

describe("coexistence partner removal", () => {
  async function accountStatus(t: Backend) {
    return (await rows(t)).accounts.map((a) => a.status);
  }

  it("disconnects the account when Meta no longer serves the number from the Cloud API", async () => {
    const { t } = await connected();
    graph.setNumberPlatform(PHONE_A, { onBusinessApp: true, platformType: "NOT_APPLICABLE" });
    const response = await postDelivery(
      t,
      delivery(
        partnerRemovedEntry(WABA_A, {
          disconnection_info: { reason: "ACCOUNT_DISCONNECTED", initiated_by: "USER" },
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(await accountStatus(t)).toEqual(["disconnected"]);
    const { numbers, credentials } = await rows(t);
    expect(numbers.map((n) => n.status)).toEqual(["disconnected"]);
    expect(credentials).toEqual([]);
  });

  it("reads ACCOUNT_OFFBOARDED the same way", async () => {
    const { t } = await connected();
    graph.setNumberPlatform(PHONE_A, { onBusinessApp: true, platformType: "ON_PREMISE" });
    await postDelivery(t, delivery(partnerRemovedEntry(WABA_A, { event: "ACCOUNT_OFFBOARDED" })));
    expect(await accountStatus(t)).toEqual(["disconnected"]);
  });

  it("changes nothing while Meta still serves the number from the Cloud API", async () => {
    const { t } = await connected();
    await postDelivery(t, delivery(partnerRemovedEntry(WABA_A)));
    expect(await accountStatus(t)).toEqual(["active"]);
  });

  it("asks Meta to retry (500) when the number cannot be read", async () => {
    const { t } = await connected();
    graph.failNext("number_platform", "network");
    const response = await postDelivery(t, delivery(partnerRemovedEntry(WABA_A)));
    expect(response.status).toBe(500);
    expect(await accountStatus(t)).toEqual(["active"]);
  });
});
