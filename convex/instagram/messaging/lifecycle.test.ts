import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  createFakeInstagram,
  FAKE_IG_TOKEN_MARKER,
  type FakeInstagram,
} from "../../providers/instagram/fakeInstagram.fixtures";
import {
  as,
  connectInstagramFake,
  expectMarketingError,
  ISSUER_CRM,
  linkSocial,
  newBackend,
  redirectParams,
  RETURN_URL,
  setupSyncOrg,
  stubLiveInstagram,
  type Backend,
} from "../../test.helpers";
import { MAX_PURGE_STEPS, PURGE_STEP_DELETES, RETENTION_GRACE_MS } from "./config";

// ADR 0017 (IM3): consent with the messaging permission, turning messaging on (with the webhook
// subscription against the fake Instagram API) and off, the lifecycle cascades and the D14
// grace-period purge. In-process only (convex-test); nothing reaches Meta.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-10-29T12:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;
const CRM = { issuer: ISSUER_CRM };
const MESSAGING_SCOPES =
  "instagram_business_basic,instagram_business_manage_insights,instagram_business_manage_messages";

let fake: FakeInstagram;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake = createFakeInstagram({
    users: {
      // The same account consenting again without the messaging permission.
      messaging_basic: {
        userId: "17841400000000105",
        username: "fake_inbox",
        accountType: "Business",
        permissions: "instagram_business_basic,instagram_business_manage_insights",
      },
      messaging_2: {
        userId: "17841400000000106",
        username: "fake_inbox_2",
        accountType: "Business",
        permissions: MESSAGING_SCOPES,
      },
      messaging_3: {
        userId: "17841400000000107",
        username: "fake_inbox_3",
        accountType: "Business",
        permissions: MESSAGING_SCOPES,
      },
    },
  });
  stubLiveInstagram(fake);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Who = { issuer?: string };

/** Connects (asking for direct messages) and links the fake user's account. */
async function connectAndLink(t: Backend, user = "messaging", who: Who = {}) {
  const params = await connectInstagramFake(t, fake, user, who, { instagramMessaging: true });
  const connectionId = params.get("connection")!;
  const [social] = await linkSocial(t, connectionId, [fake.users[user]!.userId], who);
  return { connectionId, socialAccountId: social!.id };
}

async function holder(t: Backend, user = "messaging", who: Who = {}) {
  const linked = await connectAndLink(t, user, who);
  const result = await as(t, who).action(api.v1.instagramMessaging.enable, {
    socialAccountId: linked.socialAccountId,
  });
  return { ...linked, accountId: result.accountId as Id<"instagramMessagingAccounts"> };
}

async function accountRow(t: Backend, accountId: Id<"instagramMessagingAccounts">) {
  return (await t.run((ctx) => ctx.db.get(accountId)))!;
}

async function instagramAudit(t: Backend) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("auditLog").collect())
      .filter((e) => e.action.startsWith("instagram."))
      .map((e) => ({ action: e.action, changes: e.changes })),
  );
}

function subscribeRequests() {
  return fake.requests.filter((r) => r.path.endsWith("/subscribed_apps"));
}

async function beginUrl(t: Backend, args: Record<string, unknown> = {}) {
  const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
    provider: "instagram",
    returnUrl: RETURN_URL,
    ...args,
  });
  return new URL(authorizeUrl);
}

describe("consent", () => {
  it("asks for the messaging permission on top of the analytics scopes, and again on reconnect", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    expect((await beginUrl(t)).searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_insights",
    );
    expect((await beginUrl(t, { instagramMessaging: true })).searchParams.get("scope")).toBe(
      MESSAGING_SCOPES,
    );

    const { connectionId } = await connectAndLink(t);
    const connection = await t.run((ctx) => ctx.db.get(connectionId as Id<"connections">));
    expect(connection!.grantedScopes).toEqual(MESSAGING_SCOPES.split(","));
    // A plain reconnect of that connection keeps asking for it.
    expect(
      (await beginUrl(t, { reconnectConnectionId: connectionId })).searchParams.get("scope"),
    ).toBe(MESSAGING_SCOPES);
  });

  it("keeps asking for it closed on cloud deployments until the flag is set", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-otter-123.convex.cloud");
    vi.stubEnv("OAUTH_CONNECTIONS_ENABLED", "true");
    await expectMarketingError(beginUrl(t, { instagramMessaging: true }), "INVALID_ARGUMENT");
    expect((await beginUrl(t)).searchParams.get("scope")).not.toContain("manage_messages");
    vi.stubEnv("INSTAGRAM_MESSAGING_ENABLED", "true");
    expect((await beginUrl(t, { instagramMessaging: true })).searchParams.get("scope")).toBe(
      MESSAGING_SCOPES,
    );
  });

  it("changes nothing when the consent is cancelled", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const { connectionId, accountId } = await holder(t);
    const before = await t.run((ctx) => ctx.db.get(connectionId as Id<"connections">));
    const url = await beginUrl(t, { reconnectConnectionId: connectionId });
    const response = await t.fetch(
      `/oauth/callback?state=${encodeURIComponent(url.searchParams.get("state")!)}&error=access_denied`,
      { method: "GET", redirect: "manual" },
    );
    expect(redirectParams(response).get("error")).toBe("access_denied");
    expect(await t.run((ctx) => ctx.db.get(connectionId as Id<"connections">))).toEqual(before);
    expect((await accountRow(t, accountId)).status).toBe("active");
  });

  it("cannot turn messaging on without the permission", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const { socialAccountId } = await connectAndLink(t, "business");
    expect(
      await as(t).query(api.v1.instagramMessaging.getAvailability, { socialAccountId }),
    ).toEqual({ availability: "scope_missing" });
    await expectMarketingError(
      as(t).action(api.v1.instagramMessaging.enable, { socialAccountId }),
      "CONFLICT",
    );
    expect(subscribeRequests()).toEqual([]);
  });

  it("stops messaging when a reconnect leaves the permission out", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const { connectionId, accountId } = await holder(t);
    const params = await connectInstagramFake(
      t,
      fake,
      "messaging_basic",
      {},
      {
        reconnectConnectionId: connectionId,
      },
    );
    expect(params.get("status")).toBe("connected");
    expect(await accountRow(t, accountId)).toMatchObject({
      status: "disabled",
      purgeAfter: NOW + RETENTION_GRACE_MS,
    });
    expect((await instagramAudit(t)).at(-1)).toMatchObject({
      action: "instagram.messaging_disabled",
      changes: { reason: { from: null, to: "permission_removed" } },
    });
  });
});

describe("turning messaging on", () => {
  it("subscribes the account once, with the token only in the Authorization header", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const { socialAccountId } = await connectAndLink(t);
    expect(
      await as(t).query(api.v1.instagramMessaging.getAvailability, { socialAccountId }),
    ).toEqual({ availability: "ready" });
    const first = await as(t).action(api.v1.instagramMessaging.enable, { socialAccountId });
    const again = await as(t).action(api.v1.instagramMessaging.enable, { socialAccountId });
    expect(first).toEqual({ accountId: first.accountId, status: "active" });
    expect(again).toEqual(first);

    const requests = subscribeRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      bearer: true,
      params: ["subscribed_fields"],
    });
    expect(requests[0]!.url).not.toContain(FAKE_IG_TOKEN_MARKER);
    expect(await accountRow(t, first.accountId as Id<"instagramMessagingAccounts">)).toMatchObject({
      status: "active",
      subscribedAt: NOW,
      subscribedFields: ["messages", "messaging_seen", "message_edit"],
    });
    expect((await instagramAudit(t)).map((e) => e.action)).toEqual([
      "instagram.messaging_enabled",
      "instagram.messaging_setup_completed",
    ]);
    expect(
      await as(t, { role: "editor" }).query(api.v1.instagramMessaging.getAvailability, {
        socialAccountId,
      }),
    ).toMatchObject({ availability: "active" });
    await expectMarketingError(
      as(t, { role: "editor" }).action(api.v1.instagramMessaging.enable, { socialAccountId }),
      "FORBIDDEN",
    );
  });

  it("waits for action when the subscription fails, and a retry completes it", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const { socialAccountId } = await connectAndLink(t);
    fake.fail("subscribed_apps", { status: 500 });
    const failed = await as(t).action(api.v1.instagramMessaging.enable, { socialAccountId });
    expect(failed).toMatchObject({ status: "action_required", setupReason: "http_500" });

    const retried = await as(t).action(api.v1.instagramMessaging.retrySetup, {
      accountId: failed.accountId,
    });
    expect(retried).toEqual({ accountId: failed.accountId, status: "active" });
    expect((await instagramAudit(t)).map((e) => e.action)).toEqual([
      "instagram.messaging_enabled",
      "instagram.messaging_action_required",
      "instagram.messaging_setup_completed",
    ]);
  });

  it("moves the connection to needs_reauth when Meta refuses the token", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const { connectionId, socialAccountId } = await connectAndLink(t);
    fake.fail("subscribed_apps", {
      status: 400,
      body: { error: { code: 190, type: "OAuthException", message: "Fake error" } },
    });
    expect(await as(t).action(api.v1.instagramMessaging.enable, { socialAccountId })).toMatchObject(
      { status: "action_required", setupReason: "meta_190" },
    );
    const connection = await t.run((ctx) => ctx.db.get(connectionId as Id<"connections">));
    expect(connection!.status).toBe("needs_reauth");
    expect(JSON.stringify(await instagramAudit(t))).not.toContain("Fake error");
  });

  it("refuses an account another org holds, without naming it", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    await setupSyncOrg(t, CRM);
    await holder(t);
    const { socialAccountId } = await connectAndLink(t, "messaging", CRM);
    expect(
      await as(t, CRM).query(api.v1.instagramMessaging.getAvailability, { socialAccountId }),
    ).toEqual({ availability: "in_use" });
    await expectMarketingError(
      as(t, CRM).action(api.v1.instagramMessaging.enable, { socialAccountId }),
      "CONFLICT",
    );
    expect(subscribeRequests()).toHaveLength(1);
  });
});

describe("stopping messaging", () => {
  it.each(["disconnect", "unlink", "turn off"] as const)(
    "%s stops messaging, starts the grace period and frees the account for another org",
    async (how) => {
      const t = newBackend();
      await setupSyncOrg(t);
      await setupSyncOrg(t, CRM);
      const a = await holder(t);
      if (how === "disconnect") {
        await as(t).mutation(api.v1.connections.disconnect, { connectionId: a.connectionId });
      } else if (how === "unlink") {
        await as(t).mutation(api.v1.connections.unlinkSocialAccount, {
          socialAccountId: a.socialAccountId,
        });
      } else {
        await as(t).mutation(api.v1.instagramMessaging.disable, { accountId: a.accountId });
      }
      expect(await accountRow(t, a.accountId)).toMatchObject({
        status: "disabled",
        purgeAfter: NOW + RETENTION_GRACE_MS,
      });
      const reason = { disconnect: "disconnected", unlink: "unlinked", "turn off": "turned_off" }[
        how
      ];
      expect((await instagramAudit(t)).at(-1)?.changes).toMatchObject({
        reason: { from: null, to: reason },
      });

      const b = await connectAndLink(t, "messaging", CRM);
      expect(
        await as(t, CRM).action(api.v1.instagramMessaging.enable, {
          socialAccountId: b.socialAccountId,
        }),
      ).toMatchObject({ status: "active" });
    },
  );
});

describe("delayed subscription results", () => {
  const SUBSCRIBED = { kind: "subscribed" } as const;
  const FAILED = { kind: "failed", reason: "timeout", tokenRefused: false } as const;

  /** A holder whose first subscription failed, so a new attempt can start. */
  async function unsubscribedHolder(t: Backend) {
    await setupSyncOrg(t);
    fake.fail("subscribed_apps", { status: 500 });
    return await holder(t);
  }

  /** Starts an attempt the way an enable or retry does (before calling Meta). */
  async function begin(t: Backend, accountId: Id<"instagramMessagingAccounts">) {
    const row = await accountRow(t, accountId);
    const begun = await t.mutation(internal.instagram.messaging.lifecycle.beginSetupAttempt, {
      orgId: row.orgId,
      accountId,
    });
    if (begun === null || begun.subscribed) throw new Error("expected a new attempt");
    return begun;
  }

  type Attempt = Awaited<ReturnType<typeof begin>>;

  /** The answer of that attempt arriving now. */
  async function answer(
    t: Backend,
    attempt: Attempt,
    outcome:
      | { kind: "subscribed" }
      | { kind: "failed"; reason: string; tokenRefused: boolean; credentialVersion?: number },
  ) {
    const row = await accountRow(t, attempt.accountId);
    const org = await t.run((ctx) => ctx.db.get(row.orgId));
    return await t.mutation(internal.instagram.messaging.lifecycle.recordSubscriptionResult, {
      orgId: row.orgId,
      issuer: org!.issuer,
      subject: "user_1",
      accountId: attempt.accountId,
      connectionId: attempt.connectionId,
      activatedAt: attempt.activatedAt,
      attempt: attempt.attempt,
      outcome,
    });
  }

  it("ignores an answer that arrives after messaging was turned off", async () => {
    const t = newBackend();
    const a = await unsubscribedHolder(t);
    const pending = await begin(t, a.accountId);
    await as(t).mutation(api.v1.instagramMessaging.disable, { accountId: a.accountId });

    expect(await answer(t, pending, SUBSCRIBED)).toBe("stale");
    expect(await answer(t, pending, FAILED)).toBe("stale");
    expect(await accountRow(t, a.accountId)).toMatchObject({ status: "disabled" });
    expect((await instagramAudit(t)).at(-1)?.action).toBe("instagram.messaging_disabled");
    await expectMarketingError(
      as(t).action(api.v1.instagramMessaging.retrySetup, { accountId: a.accountId }),
      "NOT_FOUND",
    );
  });

  it("ignores an answer from before a turn-off and re-enable (a newer hold)", async () => {
    const t = newBackend();
    const a = await unsubscribedHolder(t);
    const pending = await begin(t, a.accountId);
    await as(t).mutation(api.v1.instagramMessaging.disable, { accountId: a.accountId });
    vi.setSystemTime(NOW + 60_000);
    // The database step of a re-enable only: the new hold has not started its own attempt.
    const row = await accountRow(t, a.accountId);
    const org = await t.run((ctx) => ctx.db.get(row.orgId));
    await t.mutation(internal.instagram.messaging.lifecycle.enable, {
      orgId: row.orgId,
      issuer: org!.issuer,
      subject: "user_1",
      socialAccountId: a.socialAccountId,
    });

    expect(await answer(t, pending, FAILED)).toBe("stale");
    expect(await answer(t, pending, SUBSCRIBED)).toBe("stale");
    const after = await accountRow(t, a.accountId);
    expect(after).toMatchObject({ status: "active", activatedAt: NOW + 60_000 });
    expect(after.subscribedAt).toBeUndefined(); // the new hold subscribes for itself
  });

  it("lets only the newest attempt decide, whichever answer comes first", async () => {
    const t = newBackend();
    const a = await unsubscribedHolder(t);
    const older = await begin(t, a.accountId);
    const newer = await begin(t, a.accountId);

    // The older attempt's answer can neither complete nor fail the newer one.
    expect(await answer(t, older, SUBSCRIBED)).toBe("stale");
    expect(await answer(t, newer, FAILED)).toBe("applied");
    expect(await accountRow(t, a.accountId)).toMatchObject({ status: "action_required" });

    const latest = await begin(t, a.accountId);
    expect(await answer(t, latest, SUBSCRIBED)).toBe("applied");
    expect(await answer(t, newer, FAILED)).toBe("stale");
    expect(await accountRow(t, a.accountId)).toMatchObject({ status: "active" });
  });

  it("never marks a reconnected connection for reauthorization with an older token's refusal", async () => {
    const t = newBackend();
    const a = await unsubscribedHolder(t);
    const pending = await begin(t, a.accountId);
    const before = await t.run((ctx) => ctx.db.get(a.connectionId as Id<"connections">));
    // Meanwhile a reconnect replaced the credential (version + 1).
    await t.run((ctx) =>
      ctx.db.patch(a.connectionId as Id<"connections">, {
        credentialVersion: before!.credentialVersion + 1,
      }),
    );
    const refused = {
      kind: "failed",
      reason: "meta_190",
      tokenRefused: true,
      credentialVersion: before!.credentialVersion,
    } as const;
    expect(await answer(t, pending, refused)).toBe("applied");
    const connection = await t.run((ctx) => ctx.db.get(a.connectionId as Id<"connections">));
    expect(connection!.status).toBe("active");
  });
});

describe("retention (D14)", () => {
  /** One stored thread with a message and its webhook event, for the account. */
  async function seedThread(t: Backend, accountId: Id<"instagramMessagingAccounts">) {
    await t.run(async (ctx) => {
      const account = (await ctx.db.get(accountId))!;
      const now = Date.now();
      const base = { orgId: account.orgId, messagingAccountId: accountId };
      const conversationId = await ctx.db.insert("instagramConversations", {
        ...base,
        contactIgsid: "5550000000000001",
        lastInboundAt: now,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("instagramMessages", {
        ...base,
        conversationId,
        direction: "inbound",
        origin: "customer",
        mid: `m.${accountId}`,
        messageType: "text",
        text: "hello",
        status: "received",
        platformAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("instagramWebhookEvents", {
        ...base,
        dedupeKey: `message:m.${accountId}`,
        kind: "message",
        mid: `m.${accountId}`,
        status: "processed",
        receivedAt: now,
      });
    });
  }

  async function storedRows(t: Backend, accountId: Id<"instagramMessagingAccounts">) {
    return await t.run(async (ctx) => {
      const of = <T extends { messagingAccountId: Id<"instagramMessagingAccounts"> }>(rows: T[]) =>
        rows.filter((r) => r.messagingAccountId === accountId).length;
      return {
        conversations: of(await ctx.db.query("instagramConversations").collect()),
        messages: of(await ctx.db.query("instagramMessages").collect()),
        events: of(await ctx.db.query("instagramWebhookEvents").collect()),
      };
    });
  }

  async function sweepAt(t: Backend, at: number) {
    vi.setSystemTime(at);
    const result = await t.mutation(internal.instagram.messaging.purge.sweepMessagingPurges, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    return result;
  }

  const ALL = { conversations: 1, messages: 1, events: 1 };
  const NONE = { conversations: 0, messages: 0, events: 0 };

  it("purges a turned-off account's stored messages after 30 days, and nothing else", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    await setupSyncOrg(t, CRM);
    const a = await holder(t);
    const other = await holder(t, "messaging_2", CRM); // another org, another account
    await seedThread(t, a.accountId);
    await seedThread(t, other.accountId);
    await as(t).mutation(api.v1.instagramMessaging.disable, { accountId: a.accountId });

    expect(await sweepAt(t, NOW + RETENTION_GRACE_MS - DAY)).toEqual({ scheduled: 0 });
    expect(await storedRows(t, a.accountId)).toEqual(ALL);

    expect(await sweepAt(t, NOW + RETENTION_GRACE_MS + 60_000)).toEqual({ scheduled: 1 });
    expect(await storedRows(t, a.accountId)).toEqual(NONE);
    expect(await storedRows(t, other.accountId)).toEqual(ALL);
    const row = await accountRow(t, a.accountId);
    expect(row.status).toBe("disabled");
    expect(row.purgeAfter).toBeUndefined();
    expect(row.purgeStartedAt).toBeUndefined();
    expect((await instagramAudit(t)).slice(-2)).toEqual([
      { action: "instagram.messaging_purge_started", changes: undefined },
      {
        action: "instagram.messaging_purged",
        changes: {
          events: { from: null, to: 1 },
          messages: { from: null, to: 1 },
          conversations: { from: null, to: 1 },
        },
      },
    ]);
    // Purged and off: the next sweep has nothing to do.
    expect(await sweepAt(t, NOW + RETENTION_GRACE_MS + DAY)).toEqual({ scheduled: 0 });
  });

  it("keeps the history when messaging is turned on again within the grace period", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const a = await holder(t);
    await seedThread(t, a.accountId);
    await as(t).mutation(api.v1.instagramMessaging.disable, { accountId: a.accountId });
    expect(
      await as(t).query(api.v1.instagramMessaging.getAvailability, {
        socialAccountId: a.socialAccountId,
      }),
    ).toEqual({
      availability: "ready",
      accountId: a.accountId,
      purgeAfter: new Date(NOW + RETENTION_GRACE_MS).toISOString(),
    });

    vi.setSystemTime(NOW + 10 * DAY);
    await as(t).action(api.v1.instagramMessaging.enable, { socialAccountId: a.socialAccountId });
    const row = await accountRow(t, a.accountId);
    expect(row).toMatchObject({ status: "active", activatedAt: NOW + 10 * DAY });
    expect(row.purgeAfter).toBeUndefined();
    expect(await sweepAt(t, NOW + RETENTION_GRACE_MS + DAY)).toEqual({ scheduled: 0 });
    expect(await storedRows(t, a.accountId)).toEqual(ALL);
  });

  it("waits for a running purge before messaging can be turned on again", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const a = await holder(t);
    await as(t).mutation(api.v1.instagramMessaging.disable, { accountId: a.accountId });
    await t.run((ctx) => ctx.db.patch(a.accountId, { purgeAfter: NOW, purgeStartedAt: NOW }));
    await expectMarketingError(
      as(t).action(api.v1.instagramMessaging.enable, { socialAccountId: a.socialAccountId }),
      "CONFLICT",
    );
  });

  it("purges at once on a verified data-deletion request, for that org's account only", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    await setupSyncOrg(t, CRM);
    const a = await holder(t);
    const other = await holder(t, "messaging_2", CRM);
    await seedThread(t, a.accountId);
    await seedThread(t, other.accountId);

    const orgA = (await accountRow(t, a.accountId)).orgId;
    const orgB = (await accountRow(t, other.accountId)).orgId;

    // Another org's id never reaches this account.
    expect(
      await t.mutation(internal.instagram.messaging.purge.requestMessagingDataDeletion, {
        orgId: orgB,
        accountId: a.accountId,
      }),
    ).toBe(false);
    expect(
      await t.mutation(internal.instagram.messaging.purge.requestMessagingDataDeletion, {
        orgId: orgA,
        accountId: a.accountId,
      }),
    ).toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await storedRows(t, a.accountId)).toEqual(NONE);
    expect(await storedRows(t, other.accountId)).toEqual(ALL);
    expect((await accountRow(t, a.accountId)).status).toBe("disabled");
    expect(
      (await instagramAudit(t)).find((e) => e.action === "instagram.messaging_disabled"),
    ).toMatchObject({ changes: { reason: { from: null, to: "data_deletion_request" } } });
  });
});

describe("retention (D14): bounded, resumable purges", () => {
  type Size = { conversations: number; messagesEach: number; events: number };
  type Rows = { conversations: number; messages: number; events: number };

  /** Stores `size` rows for the account (more than one purge step can delete). */
  async function seedRows(t: Backend, accountId: Id<"instagramMessagingAccounts">, size: Size) {
    await t.run(async (ctx) => {
      const account = (await ctx.db.get(accountId))!;
      const now = Date.now();
      const base = { orgId: account.orgId, messagingAccountId: accountId };
      for (let c = 0; c < size.conversations; c++) {
        const conversationId = await ctx.db.insert("instagramConversations", {
          ...base,
          contactIgsid: `555000000000${String(c).padStart(4, "0")}`,
          lastMessageAt: now,
          createdAt: now,
          updatedAt: now,
        });
        for (let m = 0; m < size.messagesEach; m++) {
          await ctx.db.insert("instagramMessages", {
            ...base,
            conversationId,
            direction: "inbound",
            origin: "customer",
            mid: `m.${accountId}.${c}.${m}`,
            messageType: "text",
            text: "hello",
            status: "received",
            platformAt: now + m,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
      for (let e = 0; e < size.events; e++) {
        await ctx.db.insert("instagramWebhookEvents", {
          ...base,
          dedupeKey: `read:m.${accountId}.${e}`,
          kind: "read",
          mid: `m.${accountId}.${e}`,
          status: "unmatched",
          receivedAt: now,
        });
      }
    });
  }

  /** Every row of the account, by table. */
  async function rowsOf(t: Backend, accountId: Id<"instagramMessagingAccounts">): Promise<Rows> {
    return await t.run(async (ctx) => {
      const mine = (rows: { messagingAccountId: Id<"instagramMessagingAccounts"> }[]) =>
        rows.filter((r) => r.messagingAccountId === accountId).length;
      return {
        conversations: mine(await ctx.db.query("instagramConversations").collect()),
        messages: mine(await ctx.db.query("instagramMessages").collect()),
        events: mine(await ctx.db.query("instagramWebhookEvents").collect()),
      };
    });
  }

  const total = (rows: Rows) => rows.conversations + rows.messages + rows.events;

  async function purgeStep(t: Backend, accountId: Id<"instagramMessagingAccounts">, step: number) {
    const row = await accountRow(t, accountId);
    return await t.mutation(internal.instagram.messaging.purge.purgeMessagingAccount, {
      orgId: row.orgId,
      accountId,
      step,
    });
  }

  async function pendingPurgeJobs(t: Backend) {
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    return jobs.filter(
      (job) => job.state.kind === "pending" && job.name.includes("purgeMessagingAccount"),
    ).length;
  }

  /** Org A: the purged account and a second account; org B: a third account. */
  async function threeAccounts(t: Backend) {
    await setupSyncOrg(t);
    await setupSyncOrg(t, CRM);
    const a = await holder(t);
    const sameOrg = await holder(t, "messaging_2");
    const otherOrg = await holder(t, "messaging_3", CRM);
    return { a, sameOrg, otherOrg };
  }

  const SMALL: Size = { conversations: 1, messagesEach: 3, events: 2 };
  const SMALL_ROWS: Rows = { conversations: 1, messages: 3, events: 2 };
  const EMPTY: Rows = { conversations: 0, messages: 0, events: 0 };

  it("deletes at most one batch per step, over several steps, touching only that account", async () => {
    const t = newBackend();
    const { a, sameOrg, otherOrg } = await threeAccounts(t);
    await seedRows(t, a.accountId, { conversations: 2, messagesEach: 400, events: 300 });
    await seedRows(t, sameOrg.accountId, SMALL);
    await seedRows(t, otherOrg.accountId, SMALL);
    await as(t).mutation(api.v1.instagramMessaging.disable, { accountId: a.accountId });
    vi.setSystemTime(NOW + RETENTION_GRACE_MS + 60_000);

    // Each step is run by hand (its scheduled continuation stays queued) and checked.
    const results: string[] = [];
    const deletedPerStep: number[] = [];
    let left = total(await rowsOf(t, a.accountId));
    expect(left).toBe(1102);
    for (let step = 0; step < 10 && results.at(-1) !== "done"; step++) {
      results.push(await purgeStep(t, a.accountId, step));
      const now = total(await rowsOf(t, a.accountId));
      deletedPerStep.push(left - now);
      left = now;
      expect(await rowsOf(t, sameOrg.accountId)).toEqual(SMALL_ROWS);
      expect(await rowsOf(t, otherOrg.accountId)).toEqual(SMALL_ROWS);
      if (results.at(-1) === "continued") {
        // A purge is running: turning messaging on again waits for it.
        await expectMarketingError(
          as(t).action(api.v1.instagramMessaging.enable, { socialAccountId: a.socialAccountId }),
          "CONFLICT",
        );
      }
    }
    expect(results.at(-1)).toBe("done");
    expect(results.filter((r) => r === "continued").length).toBeGreaterThanOrEqual(2);
    expect(deletedPerStep[0]).toBe(PURGE_STEP_DELETES);
    expect(Math.max(...deletedPerStep)).toBeLessThanOrEqual(PURGE_STEP_DELETES);
    expect(left).toBe(0);

    // The continuations still queued find nothing to do; the other accounts are untouched.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await rowsOf(t, sameOrg.accountId)).toEqual(SMALL_ROWS);
    expect(await rowsOf(t, otherOrg.accountId)).toEqual(SMALL_ROWS);
    expect((await accountRow(t, a.accountId)).purgeAfter).toBeUndefined();
  });

  it("chains its own continuations to the end when the sweep starts it", async () => {
    const t = newBackend();
    const { a, sameOrg, otherOrg } = await threeAccounts(t);
    await seedRows(t, a.accountId, { conversations: 3, messagesEach: 350, events: 120 });
    await seedRows(t, sameOrg.accountId, SMALL);
    await seedRows(t, otherOrg.accountId, SMALL);
    await as(t).mutation(api.v1.instagramMessaging.disable, { accountId: a.accountId });
    vi.setSystemTime(NOW + RETENTION_GRACE_MS + 60_000);

    expect(await t.mutation(internal.instagram.messaging.purge.sweepMessagingPurges, {})).toEqual({
      scheduled: 1,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await rowsOf(t, a.accountId)).toEqual(EMPTY);
    expect(await rowsOf(t, sameOrg.accountId)).toEqual(SMALL_ROWS);
    expect(await rowsOf(t, otherOrg.accountId)).toEqual(SMALL_ROWS);
    expect((await instagramAudit(t)).at(-1)).toEqual({
      action: "instagram.messaging_purged",
      changes: {
        events: { from: null, to: 120 },
        messages: { from: null, to: 1050 },
        conversations: { from: null, to: 3 },
      },
    });
  });

  it("pauses at the step limit, and the hourly sweep resumes it", async () => {
    const t = newBackend();
    const { a, otherOrg } = await threeAccounts(t);
    await seedRows(t, a.accountId, { conversations: 1, messagesEach: 700, events: 0 });
    await seedRows(t, otherOrg.accountId, SMALL);
    await as(t).mutation(api.v1.instagramMessaging.disable, { accountId: a.accountId });
    const due = NOW + RETENTION_GRACE_MS + 60_000;
    vi.setSystemTime(due);

    // The last step a chain may take deletes one batch and schedules nothing more.
    expect(await purgeStep(t, a.accountId, MAX_PURGE_STEPS - 1)).toBe("paused");
    expect(await rowsOf(t, a.accountId)).toEqual({ conversations: 1, messages: 200, events: 0 });
    expect(await pendingPurgeJobs(t)).toBe(0);
    expect((await accountRow(t, a.accountId)).purgeStartedAt).toBe(due);
    await expectMarketingError(
      as(t).action(api.v1.instagramMessaging.enable, { socialAccountId: a.socialAccountId }),
      "CONFLICT",
    );

    vi.setSystemTime(due + 60 * 60 * 1000);
    expect(await t.mutation(internal.instagram.messaging.purge.sweepMessagingPurges, {})).toEqual({
      scheduled: 1,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await rowsOf(t, a.accountId)).toEqual(EMPTY);
    expect(await rowsOf(t, otherOrg.accountId)).toEqual(SMALL_ROWS);

    // Done: messaging may be turned on again, with no history.
    expect(
      await as(t).action(api.v1.instagramMessaging.enable, { socialAccountId: a.socialAccountId }),
    ).toMatchObject({ status: "active" });
  });

  it("refuses to turn messaging on once the grace period ended, until the purge is done", async () => {
    const t = newBackend();
    const { a, otherOrg } = await threeAccounts(t);
    const SEEDED: Rows = { conversations: 1, messages: 600, events: 10 };
    await seedRows(t, a.accountId, { conversations: 1, messagesEach: 600, events: 10 });
    await seedRows(t, otherOrg.accountId, SMALL);
    await as(t).mutation(api.v1.instagramMessaging.disable, { accountId: a.accountId });
    const deadline = NOW + RETENTION_GRACE_MS;
    const availability = async () =>
      (
        await as(t).query(api.v1.instagramMessaging.getAvailability, {
          socialAccountId: a.socialAccountId,
        })
      ).availability;

    // Up to the deadline the history may still be kept; from it on, it must be deleted first.
    vi.setSystemTime(deadline - 1);
    expect(await availability()).toBe("ready");
    vi.setSystemTime(deadline);
    expect(await availability()).toBe("purge_in_progress");

    // Due, but the hourly sweep has not run yet: refused, and the deadline stays.
    vi.setSystemTime(deadline + 60_000);
    await expectMarketingError(
      as(t).action(api.v1.instagramMessaging.enable, { socialAccountId: a.socialAccountId }),
      "CONFLICT",
    );
    expect(await accountRow(t, a.accountId)).toMatchObject({
      status: "disabled",
      purgeAfter: deadline,
    });
    expect(await rowsOf(t, a.accountId)).toEqual(SEEDED);

    // The purge runs to completion; the other org is untouched.
    expect(await t.mutation(internal.instagram.messaging.purge.sweepMessagingPurges, {})).toEqual({
      scheduled: 1,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await rowsOf(t, a.accountId)).toEqual(EMPTY);
    expect(await rowsOf(t, otherOrg.accountId)).toEqual(SMALL_ROWS);

    // Then messaging can be turned on again, without the old history.
    expect(await availability()).toBe("ready");
    expect(
      await as(t).action(api.v1.instagramMessaging.enable, { socialAccountId: a.socialAccountId }),
    ).toMatchObject({ status: "active" });
    expect(await rowsOf(t, a.accountId)).toEqual(EMPTY);
    expect((await accountRow(t, a.accountId)).purgeAfter).toBeUndefined();
  });
});
