import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import {
  CUSTOMER_1,
  CUSTOMER_2,
  customerMessage,
  delivery,
  echo,
  entry,
  postDelivery,
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
} from "../test.helpers";

// ADR 0017 (IM2): the read-only Instagram messaging API. Tenant from the verified JWT only;
// another org's conversation is NOT_FOUND. Data arrives through signed fake deliveries.

const ORG_A = { issuer: ISSUER_ERP, org: "42" };
const ORG_B = { issuer: ISSUER_CRM, org: "77" };
const VIEWER_A = { ...ORG_A, role: "viewer" };
const VIEWER_B = { ...ORG_B, role: "viewer" };
const page = (numItems = 50, cursor: string | null = null) => ({
  paginationOpts: { numItems, cursor },
});

beforeEach(() => {
  vi.useFakeTimers();
  stubInstagramWebhookEnv();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Org A holds the account and has two threads; org B exists without messaging. */
async function setup() {
  const t = newBackend();
  const orgA = await seedOrg(t, ORG_A.issuer, ORG_A.org);
  await seedOrg(t, ORG_B.issuer, ORG_B.org);
  const now = Date.now();
  vi.setSystemTime(now - 60_000);
  const holder = await seedHolder(t, { orgId: orgA, issuer: ORG_A.issuer });
  vi.setSystemTime(now);
  await postDelivery(
    t,
    delivery(
      entry([
        customerMessage("m.1", { text: "first", timestamp: now - 3_000 }),
        echo("m.2", { text: "reply", timestamp: now - 2_000 }),
        customerMessage("m.3", { customer: CUSTOMER_2, timestamp: now - 1_000 }),
      ]),
    ),
  );
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return { t, now, holder };
}

describe("v1/instagramMessaging", () => {
  it("lists the org's threads newest first, page by page, without platform ids", async () => {
    const { t, now } = await setup();
    const first = await as(t, VIEWER_A).query(api.v1.instagramMessaging.listConversations, page(1));
    expect(first.isDone).toBe(false);
    const second = await as(t, VIEWER_A).query(
      api.v1.instagramMessaging.listConversations,
      page(1, first.continueCursor),
    );
    const [newest, older] = [first.page[0]!, second.page[0]!];
    expect(newest.lastMessageAt).toBe(new Date(now - 1_000).toISOString());
    expect(older).toMatchObject({
      accountUsername: "shop",
      lastInboundAt: new Date(now - 3_000).toISOString(),
      replyWindowExpiresAt: new Date(now - 3_000 + SERVICE_WINDOW_MS).toISOString(),
    });
    const json = JSON.stringify([first, second]);
    for (const id of [CUSTOMER_1, CUSTOMER_2, "m.1"]) expect(json).not.toContain(id);
  });

  it("returns one thread and its messages, newest first", async () => {
    const { t } = await setup();
    const { page: threads } = await as(t, VIEWER_A).query(
      api.v1.instagramMessaging.listConversations,
      page(),
    );
    const thread = threads.find((c) => c.lastInboundAt !== c.lastMessageAt)!;
    expect(
      await as(t, VIEWER_A).query(api.v1.instagramMessaging.getConversation, {
        conversationId: thread.id,
      }),
    ).toEqual(thread);
    const messages = await as(t, VIEWER_A).query(api.v1.instagramMessaging.listMessages, {
      conversationId: thread.id,
      ...page(),
    });
    expect(messages.page.map((m) => [m.direction, m.origin, m.type, m.text, m.status])).toEqual([
      ["outbound", "instagram", "text", "reply", "sent"],
      ["inbound", "customer", "text", "first", "received"],
    ]);
  });

  it("lists the org's messaging accounts", async () => {
    const { t } = await setup();
    expect(await as(t, VIEWER_A).query(api.v1.instagramMessaging.listAccounts, {})).toEqual([
      expect.objectContaining({ username: "shop", status: "active" }),
    ]);
    expect(await as(t, VIEWER_B).query(api.v1.instagramMessaging.listAccounts, {})).toEqual([]);
  });

  it("shows another org nothing and refuses its ids as not found", async () => {
    const { t } = await setup();
    const { page: threads } = await as(t, VIEWER_A).query(
      api.v1.instagramMessaging.listConversations,
      page(),
    );
    const conversationId = threads[0]!.id;
    expect(
      (await as(t, VIEWER_B).query(api.v1.instagramMessaging.listConversations, page())).page,
    ).toEqual([]);
    await expectMarketingError(
      as(t, VIEWER_B).query(api.v1.instagramMessaging.getConversation, { conversationId }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      as(t, VIEWER_B).query(api.v1.instagramMessaging.listMessages, { conversationId, ...page() }),
      "NOT_FOUND",
    );
  });

  it("tells the dashboard when no reply can be sent, with sendText's own checks", async () => {
    const { t, holder } = await setup();
    const { page: threads } = await as(t, VIEWER_A).query(
      api.v1.instagramMessaging.listConversations,
      page(),
    );
    const blocker = async () =>
      (
        await as(t, VIEWER_A).query(api.v1.instagramMessaging.getConversation, {
          conversationId: threads[0]!.id,
        })
      ).replyBlocker;
    const listed = async () =>
      (await as(t, VIEWER_A).query(api.v1.instagramMessaging.listConversations, page())).page.map(
        (c) => c.replyBlocker,
      );

    expect(await blocker()).toBeUndefined();
    await t.run((ctx) =>
      ctx.db.patch(holder.connectionId, { grantedScopes: ["instagram_business_basic"] }),
    );
    expect(await blocker()).toBe("scope_missing");
    await t.run((ctx) => ctx.db.patch(holder.connectionId, { status: "needs_reauth" }));
    expect(await blocker()).toBe("reconnect_required");
    await t.run((ctx) => ctx.db.patch(holder.accountId, { status: "action_required" }));
    expect(await blocker()).toBe("setup_incomplete");
    expect(await listed()).toEqual(["setup_incomplete", "setup_incomplete"]);
    await t.run((ctx) => ctx.db.patch(holder.accountId, { status: "disabled" }));
    expect(await blocker()).toBe("messaging_unavailable");

    // Closed on a cloud deployment until the flag is set, whatever the account.
    await t.run(async (ctx) => {
      await ctx.db.patch(holder.accountId, { status: "active" });
      await ctx.db.patch(holder.connectionId, {
        status: "active",
        grantedScopes: ["instagram_business_basic", "instagram_business_manage_messages"],
      });
    });
    expect(await blocker()).toBeUndefined();
    vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-otter-123.convex.cloud");
    expect(await blocker()).toBe("messaging_unavailable");
  });

  it("requires a signed-in member with a role", async () => {
    const { t } = await setup();
    await expect(t.query(api.v1.instagramMessaging.listConversations, page())).rejects.toThrow();
    await expectMarketingError(
      as(t, { ...ORG_A, role: null }).query(api.v1.instagramMessaging.listAccounts, {}),
      "INVALID_TOKEN_CLAIMS",
    );
  });
});
