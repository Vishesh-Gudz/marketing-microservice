import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  createFakeUnified,
  FAKE_UNIFIED_APP_ID,
  FAKE_UNIFIED_APP_SECRET,
  FAKE_UNIFIED_CODE_MARKER,
  FAKE_UNIFIED_CONFIG_ID,
  FAKE_UNIFIED_TOKEN_MARKER,
  type FakeUnified,
} from "../../providers/instagram/fakeUnified.fixtures";
import { ensureSocialSyncAccount } from "../../sync/state";
import {
  as,
  claimResult,
  ISSUER_CRM,
  linkSocial,
  newBackend,
  redirectParams,
  RETURN_URL,
  setupSyncOrg,
  type Backend,
} from "../../test.helpers";
import {
  customerMessage,
  delivery,
  echo,
  entry,
  postDelivery,
  stubInstagramWebhookEnv,
} from "./fakeWebhook.fixtures";

// Instagram API with Unified Login end to end, in-process (convex-test) against a fake of the
// documented graph.facebook.com endpoints: connect through the Facebook Login for Business
// dialog, link without organic sync, turn messaging on (subscription), receive a signed webhook
// delivery, reply, and disconnect. Nothing reaches Meta.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-10-31T12:00:00Z").getTime();
const IG = "17841400000000301"; // the fake client's assigned account
const CUSTOMER = "5550000000000001";
const CRM = { issuer: ISSUER_CRM };

let fake: FakeUnified;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake = createFakeUnified();
  vi.stubEnv("PROVIDER_MODE", "live");
  vi.stubEnv("INSTAGRAM_APP_ID", FAKE_UNIFIED_APP_ID);
  vi.stubEnv("INSTAGRAM_APP_SECRET", FAKE_UNIFIED_APP_SECRET);
  vi.stubEnv("INSTAGRAM_LOGIN_CONFIG_ID", FAKE_UNIFIED_CONFIG_ID);
  vi.stubGlobal("fetch", fake.fetch);
  stubInstagramWebhookEnv();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Who = { issuer?: string };

async function drain(t: Backend) {
  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 1_000);
}

/** The real connect flow: beginConnect -> dialog -> /oauth/callback -> completeConnect. */
async function connect(t: Backend, who: Who = {}) {
  await setupSyncOrg(t, who);
  const { authorizeUrl } = await as(t, who).action(api.v1.connections.beginConnect, {
    provider: "instagram",
    returnUrl: RETURN_URL,
    instagramMessaging: true,
  });
  const dialog = new URL(authorizeUrl);
  const state = dialog.searchParams.get("state")!;
  const params = await claimResult(
    t,
    redirectParams(
      await t.fetch(
        `/oauth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(fake.issueCode())}`,
        { method: "GET", redirect: "manual" },
      ),
    ),
    who,
  );
  return { dialog, params, connectionId: params.get("connection") as Id<"connections"> };
}

/** Connect + link + messaging on + one customer message. */
async function thread(t: Backend, who: Who = {}) {
  const { connectionId } = await connect(t, who);
  const [social] = await linkSocial(t, connectionId, [IG], who);
  const { accountId } = await as(t, who).action(api.v1.instagramMessaging.enable, {
    socialAccountId: social!.id,
  });
  await postDelivery(
    t,
    delivery(entry([customerMessage("m.unified.in.1", { account: IG, customer: CUSTOMER })], IG)),
  );
  await drain(t);
  return { connectionId, socialAccountId: social!.id, accountId };
}

describe("Unified Login connect", () => {
  it("authorizes through the configuration and stores a system-user connection", async () => {
    const t = newBackend();
    const { dialog, params, connectionId } = await connect(t);

    expect(dialog.origin + dialog.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(dialog.searchParams.get("config_id")).toBe(FAKE_UNIFIED_CONFIG_ID);
    expect(dialog.searchParams.has("scope")).toBe(false);
    expect(params.get("status")).toBe("connected");

    const connection = (await t.run((ctx) => ctx.db.get(connectionId)))!;
    expect(connection).toMatchObject({
      provider: "instagram",
      status: "active",
      externalUserId: IG,
      grantedScopes: ["instagram_basic", "instagram_manage_messages"],
    });
    expect(connection.tokenExpiresAt).toBeUndefined();
    expect(connection.scopedUserId).toBeUndefined();

    const discovered = await t.run((ctx) => ctx.db.query("discoveredSocialAccounts").collect());
    expect(discovered.map((d) => [d.externalId, d.username, d.accountType])).toEqual([
      [IG, "fake_unified", "business"],
    ]);

    // Not reported as missing Instagram Login permissions.
    const [dto] = await as(t).query(api.v1.connections.list, {});
    expect(dto!.missingScopes).toEqual([]);
  });

  it("links the account without an organic sync schedule, and parks a leftover one", async () => {
    const t = newBackend();
    const { connectionId } = await connect(t);
    const [social] = await linkSocial(t, connectionId, [IG]);
    const socialAccountId = social!.id as Id<"socialAccounts">;
    expect(
      (await t.run((ctx) => ctx.db.query("syncAccounts").collect())).filter(
        (row) => row.socialAccountId === socialAccountId,
      ),
    ).toEqual([]);

    // A schedule left from an earlier Instagram Login link is parked, never run.
    const rowId = await t.run(async (ctx) =>
      ensureSocialSyncAccount(
        ctx.db,
        (await ctx.db.get(socialAccountId))!,
        { relinked: false, horizonDays: 30 },
        NOW,
      ),
    );
    await t.mutation(internal.sync.planner.tick, {});
    const row = (await t.run((ctx) => ctx.db.get(rowId)))!;
    expect(row.state).toBe("parked");
    expect(await t.run((ctx) => ctx.db.query("syncRuns").collect())).toEqual([]);
  });
});

describe("Unified Login messaging", () => {
  it("subscribes on graph.facebook.com/v26.0 with the Unified field list", async () => {
    const t = newBackend();
    const { accountId } = await thread(t);
    expect(fake.subscriptions).toEqual([{ account: IG, fields: "messages,messaging_seen" }]);
    const account = (await t.run((ctx) =>
      ctx.db.get(accountId as Id<"instagramMessagingAccounts">),
    ))!;
    expect(account.status).toBe("active");
    expect(account.subscribedFields).toEqual(["messages", "messaging_seen"]);
  });

  it("stores the customer's message for the holding org only and replies through Unified", async () => {
    const t = newBackend();
    const { accountId } = await thread(t);
    await setupSyncOrg(t, CRM); // another org: never sees the account's messages

    const conversations = await t.run((ctx) => ctx.db.query("instagramConversations").collect());
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      messagingAccountId: accountId,
      contactIgsid: CUSTOMER,
    });
    const otherOrg = await as(t, CRM).query(api.v1.instagramMessaging.listConversations, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(otherOrg.page).toEqual([]);

    fake.reset();
    await as(t).mutation(api.v1.instagramMessaging.sendText, {
      accountId,
      conversationId: conversations[0]!._id,
      text: "Thanks for writing!",
      clientMessageId: "client-unified-0001",
    });
    await drain(t);

    expect(fake.requests.map((r) => `${r.method} ${r.path} ${r.bearer}`)).toEqual([
      `POST /v26.0/${IG}/messages true`,
    ]);
    expect(fake.sent).toEqual([
      { account: IG, recipient: CUSTOMER, text: "Thanks for writing!", mid: expect.any(String) },
    ]);
    const outbound = async () =>
      (await t.run((ctx) => ctx.db.query("instagramMessages").collect())).filter(
        (m) => m.direction === "outbound",
      );
    expect(await outbound()).toHaveLength(1);
    // Accepted by Meta: submitted until the echo arrives ([assume] under `messages` with
    // is_echo for Unified Login too, as for Instagram Login).
    expect((await outbound())[0]!.status).toBe("submitted");
    await postDelivery(
      t,
      delivery(entry([echo(fake.sent[0]!.mid, { account: IG, customer: CUSTOMER })], IG)),
    );
    await drain(t);
    expect((await outbound())[0]!.status).toBe("sent");
  });

  it("stops messaging and deletes the credential on disconnect", async () => {
    const t = newBackend();
    const { connectionId, accountId } = await thread(t);
    await as(t).mutation(api.v1.connections.disconnect, { connectionId });
    await drain(t);
    const account = (await t.run((ctx) =>
      ctx.db.get(accountId as Id<"instagramMessagingAccounts">),
    ))!;
    expect(account.status).toBe("disabled");
    expect(await t.run((ctx) => ctx.db.query("credentials").collect())).toEqual([]);
  });

  it("keeps the token, secret and code out of every stored row except the encrypted credential", async () => {
    const t = newBackend();
    await thread(t);
    const dump = await t.run(async (ctx) => {
      const tables = [
        "connections",
        "oauthStates",
        "oauthGrants",
        "discoveredSocialAccounts",
        "socialAccounts",
        "instagramMessagingAccounts",
        "instagramConversations",
        "instagramMessages",
        "instagramWebhookEvents",
        "auditLog",
      ] as const;
      const rows: unknown[] = [];
      for (const table of tables) rows.push(...(await ctx.db.query(table).collect()));
      return JSON.stringify(rows);
    });
    for (const secret of [
      FAKE_UNIFIED_TOKEN_MARKER,
      FAKE_UNIFIED_APP_SECRET,
      FAKE_UNIFIED_CODE_MARKER,
    ]) {
      expect(dump).not.toContain(secret);
    }
  });
});
