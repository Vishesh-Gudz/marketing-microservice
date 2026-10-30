import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import crons from "../../crons";
import { AUDIT_ACTIONS, SYSTEM_INSTAGRAM_DATA_DELETION_SUBJECT } from "../../lib/audit";
import {
  createFakeInstagram,
  FAKE_IG_TOKEN_MARKER,
  type FakeInstagram,
} from "../../providers/instagram/fakeInstagram.fixtures";
import {
  as,
  connectInstagramFake,
  drainScheduler,
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
import { RETENTION_GRACE_MS } from "../messaging/config";
import {
  CUSTOMER_1,
  customerMessage,
  delivery,
  entry,
  postDelivery,
  stubInstagramWebhookEnv,
} from "../messaging/fakeWebhook.fixtures";
import {
  CONFIRMATION_CODE,
  CREDENTIAL_GRACE_MS,
  INSTAGRAM_CALLBACK_SECRET_ENV,
  INSTAGRAM_DATA_DELETION_PATH,
  INSTAGRAM_DATA_DELETION_STATUS_PATH,
  INSTAGRAM_DEAUTHORIZE_PATH,
  STALLED_AFTER_MS,
} from "./config";
import {
  payloadFor,
  postCallback,
  signRequest,
  stubCallbackSecret,
} from "./signedRequest.fixtures";

// ADR 0017 (IM6): Meta's deauthorize and data-deletion callbacks for the Instagram Login app,
// over HTTP with signed requests, against accounts connected through the real connect flow
// (fake Instagram API). In-process only (convex-test); nothing reaches Meta.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-10-30T12:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;
const SITE = "https://marketing-tests.convex.site"; // vitest.config.mts
const ORG_B = { issuer: ISSUER_CRM };
const MESSAGING_SCOPES =
  "instagram_business_basic,instagram_business_manage_insights,instagram_business_manage_messages";
// The code exchange's user id differs from the professional account id (IR2).
const USERS = {
  deleter: {
    userId: "17841400000000301",
    scopedUserId: "9000000000000301",
    username: "fake_deleter",
    accountType: "Business",
    permissions: MESSAGING_SCOPES,
  },
  bystander: {
    userId: "17841400000000302",
    scopedUserId: "9000000000000302",
    username: "fake_bystander",
    accountType: "Business",
    permissions: MESSAGING_SCOPES,
  },
};
const DELETER = USERS.deleter;
/** Values that must never appear in a response or an audit entry. */
const PLATFORM_DATA = [
  DELETER.userId,
  DELETER.scopedUserId,
  DELETER.username,
  CUSTOMER_1,
  FAKE_IG_TOKEN_MARKER,
];

let fake: FakeInstagram;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake = createFakeInstagram({ users: USERS });
  stubLiveInstagram(fake);
  stubInstagramWebhookEnv();
  stubCallbackSecret();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Who = { issuer?: string };
type User = keyof typeof USERS;

async function connectAndLink(t: Backend, user: User, who: Who = {}) {
  const params = await connectInstagramFake(t, fake, user, who, { instagramMessaging: true });
  const connectionId = params.get("connection")! as Id<"connections">;
  const [social] = await linkSocial(t, connectionId, [USERS[user].userId], who);
  const socialAccountId = social!.id as Id<"socialAccounts">;
  // Stored analytics, as a sync leaves them: a post, its snapshot, a day of account metrics.
  await t.run(async (ctx) => {
    const { orgId } = (await ctx.db.get(socialAccountId))!;
    const life = { createdAt: NOW, updatedAt: NOW, lastSeenAt: NOW };
    const postId = await ctx.db.insert("socialPosts", {
      orgId,
      socialAccountId,
      platform: "instagram",
      externalId: `18000000000${USERS[user].userId.slice(-6)}`,
      type: "image",
      publishedAt: NOW - 10 * DAY,
      ...life,
    });
    await ctx.db.insert("socialPostMetricSnapshots", {
      orgId,
      socialAccountId,
      postId,
      platform: "instagram",
      capturedDate: "2026-10-20",
      capturedAt: NOW - 10 * DAY,
      views: 5,
    });
    await ctx.db.insert("socialAccountMetricsDaily", {
      orgId,
      socialAccountId,
      platform: "instagram",
      date: "2026-10-20",
      views: 7,
      syncedAt: NOW - 10 * DAY,
    });
  });
  return { connectionId, socialAccountId };
}

/** Connected, linked, direct messages on, and one customer conversation stored. */
async function withMessages(t: Backend, user: User, who: Who = {}) {
  const linked = await connectAndLink(t, user, who);
  const { accountId } = await as(t, who).action(api.v1.instagramMessaging.enable, {
    socialAccountId: linked.socialAccountId,
  });
  const account = USERS[user].userId;
  const response = await postDelivery(
    t,
    delivery(entry([customerMessage(`mid.${user}`, { account })], account)),
  );
  expect(response.status).toBe(200);
  await drainScheduler(t);
  return { ...linked, accountId: accountId as Id<"instagramMessagingAccounts"> };
}

async function rows(t: Backend) {
  return await t.run(async (ctx) => ({
    connections: await ctx.db.query("connections").collect(),
    credentials: await ctx.db.query("credentials").collect(),
    socialAccounts: await ctx.db.query("socialAccounts").collect(),
    posts: await ctx.db.query("socialPosts").collect(),
    snapshots: await ctx.db.query("socialPostMetricSnapshots").collect(),
    daily: await ctx.db.query("socialAccountMetricsDaily").collect(),
    messagingAccounts: await ctx.db.query("instagramMessagingAccounts").collect(),
    conversations: await ctx.db.query("instagramConversations").collect(),
    messages: await ctx.db.query("instagramMessages").collect(),
    events: await ctx.db.query("instagramWebhookEvents").collect(),
    requests: await ctx.db.query("instagramDataDeletionRequests").collect(),
    audit: await ctx.db.query("auditLog").collect(),
  }));
}
type Rows = Awaited<ReturnType<typeof rows>>;

/** Everything stored for one connection's org and Instagram account. */
function dataOf(db: Rows, orgId: Id<"organizations">, socialAccountId: Id<"socialAccounts">) {
  const accounts = new Set(
    db.messagingAccounts.filter((r) => r.socialAccountId === socialAccountId).map((r) => r._id),
  );
  return {
    socialAccounts: db.socialAccounts.filter((r) => r._id === socialAccountId).length,
    posts: db.posts.filter((r) => r.socialAccountId === socialAccountId).length,
    snapshots: db.snapshots.filter((r) => r.socialAccountId === socialAccountId).length,
    daily: db.daily.filter((r) => r.socialAccountId === socialAccountId).length,
    messagingAccounts: accounts.size,
    conversations: db.conversations.filter(
      (r) => r.orgId === orgId && accounts.has(r.messagingAccountId),
    ).length,
    messages: db.messages.filter((r) => r.orgId === orgId && accounts.has(r.messagingAccountId))
      .length,
    events: db.events.filter((r) => r.orgId === orgId && accounts.has(r.messagingAccountId)).length,
  };
}

const connectionOf = (db: Rows, id: Id<"connections">) => db.connections.find((r) => r._id === id)!;
const TARGET = internal.instagram.dataDeletion.requests.advanceDeletionTarget;
const FAN_OUT = internal.instagram.dataDeletion.requests.advanceDeletionRequest;

async function deletionResponse(t: Backend, userId: string) {
  const response = await postCallback(
    t,
    INSTAGRAM_DATA_DELETION_PATH,
    await signRequest(payloadFor(userId)),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  const text = await response.text();
  for (const value of PLATFORM_DATA) expect(text).not.toContain(value);
  return JSON.parse(text) as { url: string; confirmation_code: string };
}

async function statusPage(t: Backend, code: string) {
  const response = await t.fetch(`${INSTAGRAM_DATA_DELETION_STATUS_PATH}?code=${code}`, {
    method: "GET",
  });
  return { status: response.status, text: await response.text() };
}

describe("data-deletion callback", () => {
  it("deletes every org's Instagram data of the user, and nothing else", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    await setupSyncOrg(t, ORG_B);
    const a = await withMessages(t, "deleter");
    const b = await connectAndLink(t, "deleter", ORG_B);
    const c = await withMessages(t, "bystander", ORG_B);

    const before = await rows(t);
    const orgA = connectionOf(before, a.connectionId).orgId;
    const orgB = connectionOf(before, b.connectionId).orgId;
    // Every connect records the code exchange's id beside the professional account id.
    expect(connectionOf(before, a.connectionId)).toMatchObject({
      externalUserId: DELETER.userId,
      scopedUserId: DELETER.scopedUserId,
    });
    expect(dataOf(before, orgA, a.socialAccountId)).toMatchObject({
      socialAccounts: 1,
      posts: 1,
      messagingAccounts: 1,
      conversations: 1,
      messages: 1,
    });
    const untouched = dataOf(before, orgB, c.socialAccountId);

    const answer = await deletionResponse(t, DELETER.scopedUserId);
    expect(answer.confirmation_code).toMatch(CONFIRMATION_CODE);
    expect(answer.url).toBe(
      `${SITE}${INSTAGRAM_DATA_DELETION_STATUS_PATH}?code=${answer.confirmation_code}`,
    );

    // The callback only records the request; each org's part runs in its own mutations.
    const recorded = (await rows(t)).requests[0]!;
    expect(recorded).toMatchObject({ status: "pending", origin: "meta" });
    expect(recorded.targets.map((target) => target.begun)).toEqual([false, false]);
    expect((await statusPage(t, answer.confirmation_code)).text).toContain("In progress");

    await drainScheduler(t);

    const after = await rows(t);
    const nothing = {
      socialAccounts: 0,
      posts: 0,
      snapshots: 0,
      daily: 0,
      messagingAccounts: 0,
      conversations: 0,
      messages: 0,
      events: 0,
    };
    expect(dataOf(after, orgA, a.socialAccountId)).toEqual(nothing);
    expect(dataOf(after, orgB, b.socialAccountId)).toEqual(nothing);
    for (const id of [a.connectionId, b.connectionId]) {
      const connection = connectionOf(after, id);
      expect(connection).toMatchObject({ status: "revoked", externalUserId: `erased:${id}` });
      expect(connection.displayName).toBeUndefined();
      expect(connection.scopedUserId).toBeUndefined();
      expect(after.credentials.some((r) => r.connectionId === id)).toBe(false);
    }
    // The other Instagram account (same org B) is untouched.
    expect(dataOf(after, orgB, c.socialAccountId)).toEqual(untouched);
    expect(connectionOf(after, c.connectionId).status).toBe("active");
    expect(after.credentials.some((r) => r.connectionId === c.connectionId)).toBe(true);

    expect(after.requests).toHaveLength(1);
    expect(after.requests[0]).toMatchObject({
      status: "completed",
      completedAt: expect.any(Number),
    });
    const deletionAudit = after.audit.filter(
      (e) => e.subject === SYSTEM_INSTAGRAM_DATA_DELETION_SUBJECT,
    );
    for (const orgId of [orgA, orgB]) {
      const actions = deletionAudit.filter((e) => e.orgId === orgId).map((e) => e.action);
      expect(actions).toContain(AUDIT_ACTIONS.instagramDataDeletionRequested);
      expect(actions).toContain(AUDIT_ACTIONS.instagramDataDeletionCompleted);
      expect(actions).toContain(AUDIT_ACTIONS.socialAccountPurged);
    }
    const auditText = JSON.stringify(after.audit.slice(before.audit.length));
    for (const value of PLATFORM_DATA) expect(auditText).not.toContain(value);

    const page = await statusPage(t, answer.confirmation_code);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`Confirmation code: ${answer.confirmation_code}`);
    expect(page.text).toContain("Status: Completed on 2026-10-30");
    for (const value of [...PLATFORM_DATA, orgA, orgB, a.connectionId]) {
      expect(page.text).not.toContain(value);
    }
  });

  it("answers a repeated delivery with the same code, and a new request with a new one", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    await connectAndLink(t, "deleter");
    const signed = await signRequest(payloadFor(DELETER.scopedUserId));
    const first = await (await postCallback(t, INSTAGRAM_DATA_DELETION_PATH, signed)).json();
    const again = await (await postCallback(t, INSTAGRAM_DATA_DELETION_PATH, signed)).json();
    expect(again).toEqual(first);
    // Another request of the same user (another issued_at) is a request of its own.
    const other = await (
      await postCallback(
        t,
        INSTAGRAM_DATA_DELETION_PATH,
        await signRequest(payloadFor(DELETER.scopedUserId, NOW / 1000 + 60)),
      )
    ).json();
    expect(other.confirmation_code).not.toBe(first.confirmation_code);
    await drainScheduler(t);
    expect((await rows(t)).requests.map((r) => r.status)).toEqual(["completed", "completed"]);
  });

  it("also finds the user by the professional account id (RI14), e.g. before IM6", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const a = await connectAndLink(t, "deleter");
    // A connection made before IM6 has no scoped id.
    await t.run((ctx) => ctx.db.patch(a.connectionId, { scopedUserId: undefined }));

    // The scoped id finds nothing then. That older connection may be the requester's and
    // cannot be matched: the request is NOT completed (IM7.0), it waits in review.
    const none = await deletionResponse(t, DELETER.scopedUserId);
    await drainScheduler(t);
    const review = await statusPage(t, none.confirmation_code);
    expect(review.text).toContain("Some older connections still have to be checked");
    expect(review.text).not.toContain("Completed");
    expect(connectionOf(await rows(t), a.connectionId).status).toBe("active");

    // Matched by the professional account id: deleted, and no older connection remains, so
    // both requests are verified complete.
    const matched = await deletionResponse(t, DELETER.userId);
    await drainScheduler(t);
    const after = await rows(t);
    expect(connectionOf(after, a.connectionId).externalUserId).toBe(`erased:${a.connectionId}`);
    expect(after.socialAccounts).toEqual([]);
    expect(after.requests.map((r) => r.status)).toEqual(["completed", "completed"]);
    for (const code of [none.confirmation_code, matched.confirmation_code]) {
      expect((await statusPage(t, code)).text).toContain("Completed on");
    }
  });

  it("refuses to relink the account while it is deleted, and keeps a reconnect made since", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const a = await withMessages(t, "deleter");
    await deletionResponse(t, DELETER.scopedUserId);
    const requestId = (await rows(t)).requests[0]!._id;
    // The org's part starts; it then waits for the direct-message purge (not run yet).
    expect(await t.mutation(TARGET, { requestId, index: 0 })).toBe("waiting");
    expect(connectionOf(await rows(t), a.connectionId).status).toBe("revoked");

    // A minute later the user connects again: a new authorization.
    vi.setSystemTime(NOW + 60_000);
    const params = await connectInstagramFake(t, fake, "deleter");
    expect(params.get("connection")).toBe(a.connectionId);
    await expectMarketingError(linkSocial(t, a.connectionId, [DELETER.userId]), "CONFLICT");

    await drainScheduler(t);
    const after = await rows(t);
    expect(after.socialAccounts).toEqual([]);
    expect(after.messages).toEqual([]);
    // The new authorization keeps its identity AND its credential (the disconnect's own
    // credential cleanup never reaches a reconnect, IM7.0).
    expect(connectionOf(after, a.connectionId)).toMatchObject({
      status: "active",
      externalUserId: DELETER.userId,
      scopedUserId: DELETER.scopedUserId,
    });
    expect(after.credentials.some((r) => r.connectionId === a.connectionId)).toBe(true);
    expect(after.requests[0]!.status).toBe("completed");
    // Once deleted, the account is linked again as a new one.
    const [relinked] = await linkSocial(t, a.connectionId, [DELETER.userId]);
    expect(relinked!.id).not.toBe(a.socialAccountId);
  });
});

describe("deletion steps", () => {
  async function recorded(t: Backend) {
    await t.mutation(internal.instagram.dataDeletion.requests.recordDeletionRequest, {
      userId: DELETER.scopedUserId,
      requestKey: "k".repeat(64),
      confirmationCode: "ABCDEFGHJKLMNPQRSTUV",
    });
    return (await rows(t)).requests[0]!._id;
  }

  it("waits for the credential the disconnect deletes, then deletes it itself", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const a = await connectAndLink(t, "deleter");
    const requestId = await recorded(t);

    // The disconnect's credential deletion has not run yet (scheduled, not drained).
    expect(await t.mutation(TARGET, { requestId, index: 0 })).toBe("waiting");
    expect((await rows(t)).credentials.some((r) => r.connectionId === a.connectionId)).toBe(true);

    vi.setSystemTime(NOW + CREDENTIAL_GRACE_MS);
    expect(await t.mutation(TARGET, { requestId, index: 0, attempt: 1 })).toBe("done");
    const after = await rows(t);
    expect(after.credentials.some((r) => r.connectionId === a.connectionId)).toBe(false);
    expect(
      after.audit.some(
        (e) =>
          e.action === AUDIT_ACTIONS.credentialDeleted &&
          e.subject === SYSTEM_INSTAGRAM_DATA_DELETION_SUBJECT,
      ),
    ).toBe(true);
    await drainScheduler(t);
    expect((await rows(t)).requests[0]!.status).toBe("completed");
  });

  it("purges direct messages again if they were turned back on meanwhile", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const a = await withMessages(t, "deleter");
    const requestId = await recorded(t);
    expect(await t.mutation(TARGET, { requestId, index: 0 })).toBe("waiting");
    await t.run((ctx) =>
      ctx.db.patch(a.accountId, {
        status: "active",
        purgeAfter: undefined,
        purgeStartedAt: undefined,
      }),
    );

    expect(await t.mutation(TARGET, { requestId, index: 0, attempt: 1 })).toBe("waiting");
    expect((await rows(t)).messagingAccounts[0]).toMatchObject({
      status: "disabled",
      purgeAfter: NOW,
    });
    await drainScheduler(t);
    const after = await rows(t);
    expect(after.messagingAccounts).toEqual([]);
    expect(after.messages).toEqual([]);
    expect(after.requests[0]!.status).toBe("completed");
  });

  it("is resumed by the hourly sweep, oldest attempt first; every resume moves it on", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    await connectAndLink(t, "deleter");
    const requestId = await recorded(t);
    const sweep = internal.instagram.dataDeletion.requests.sweepDeletionRequests;
    expect(await t.mutation(sweep, {})).toEqual({ resumed: 1 }); // due since it was recorded
    // A fan-out moves nextAttemptAt ahead whatever its parts then do.
    expect(await t.mutation(FAN_OUT, { requestId })).toBe("scheduled");
    expect((await rows(t)).requests[0]).toMatchObject({
      attempts: 1,
      nextAttemptAt: NOW + STALLED_AFTER_MS,
    });
    expect(await t.mutation(sweep, {})).toEqual({ resumed: 0 });
    vi.setSystemTime(NOW + STALLED_AFTER_MS + 1);
    expect(await t.mutation(sweep, {})).toEqual({ resumed: 1 });
    await drainScheduler(t);
    expect((await rows(t)).requests[0]!.status).toBe("completed");
    expect(crons.crons["instagram data deletion requests"]).toMatchObject({
      name: "instagram/dataDeletion/requests:sweepDeletionRequests",
      schedule: { type: "hourly", minuteUTC: 51 },
    });
  });
});

describe("deauthorize callback", () => {
  it("asks every org to reconnect and stops direct messages; the data is kept", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    await setupSyncOrg(t, ORG_B);
    const a = await withMessages(t, "deleter");
    const b = await connectAndLink(t, "deleter", ORG_B);
    const c = await withMessages(t, "bystander", ORG_B);
    const before = await rows(t);

    const signed = await signRequest(payloadFor(DELETER.scopedUserId));
    const response = await postCallback(t, INSTAGRAM_DEAUTHORIZE_PATH, signed);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");

    const after = await rows(t);
    expect(connectionOf(after, a.connectionId).status).toBe("needs_reauth");
    expect(connectionOf(after, b.connectionId).status).toBe("needs_reauth");
    expect(connectionOf(after, c.connectionId).status).toBe("active");
    expect(after.messagingAccounts.find((r) => r._id === a.accountId)).toMatchObject({
      status: "disabled",
      purgeAfter: NOW + RETENTION_GRACE_MS,
    });
    expect(after.messagingAccounts.find((r) => r._id === c.accountId)!.status).toBe("active");
    const orgA = connectionOf(before, a.connectionId).orgId;
    expect(dataOf(after, orgA, a.socialAccountId)).toEqual(dataOf(before, orgA, a.socialAccountId));
    const newAudit = after.audit.slice(before.audit.length);
    expect(
      newAudit
        .filter((e) => e.action === AUDIT_ACTIONS.connectionNeedsReauth)
        .map((e) => e.changes?.reason?.to),
    ).toEqual(["instagram_deauthorized", "instagram_deauthorized"]);
    expect(
      newAudit.find((e) => e.action === AUDIT_ACTIONS.instagramMessagingDisabled)?.changes?.reason
        ?.to,
    ).toBe("deauthorized");

    // Repeated: nothing changes again.
    expect((await postCallback(t, INSTAGRAM_DEAUTHORIZE_PATH, signed)).status).toBe(200);
    expect((await rows(t)).audit).toHaveLength(after.audit.length);
  });

  it("accepts the signed request as multipart form data too", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const a = await connectAndLink(t, "deleter");
    const signed = await signRequest(payloadFor(DELETER.userId));
    const boundary = "----im6boundary";
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="signed_request"\r\n\r\n${signed}\r\n--${boundary}--\r\n`;
    const response = await postCallback(t, INSTAGRAM_DEAUTHORIZE_PATH, signed, {
      contentType: `multipart/form-data; boundary=${boundary}`,
      body,
    });
    expect(response.status).toBe(200);
    expect(connectionOf(await rows(t), a.connectionId).status).toBe("needs_reauth");
  });
});

describe("refusals", () => {
  const PATHS = [INSTAGRAM_DEAUTHORIZE_PATH, INSTAGRAM_DATA_DELETION_PATH];

  async function connected() {
    const t = newBackend();
    await setupSyncOrg(t);
    const a = await connectAndLink(t, "deleter");
    return { t, a };
  }

  async function expectUnchanged(t: Backend, connectionId: Id<"connections">) {
    const db = await rows(t);
    expect(connectionOf(db, connectionId).status).toBe("active");
    expect(db.requests).toEqual([]);
    expect(db.socialAccounts.map((r) => r.status)).toEqual(["active"]);
  }

  it.each(PATHS)("%s fails closed without its secret (503)", async (path) => {
    const { t, a } = await connected();
    vi.stubEnv(INSTAGRAM_CALLBACK_SECRET_ENV, "");
    const response = await postCallback(t, path, await signRequest(payloadFor(DELETER.userId)));
    expect(response.status).toBe(503);
    await expectUnchanged(t, a.connectionId);
  });

  it("answers a deletion only with a public https status page (or loopback locally)", async () => {
    const { t, a } = await connected();
    const signed = await signRequest(payloadFor(DELETER.userId));
    vi.stubEnv("CONVEX_SITE_URL", "http://marketing.example.com");
    expect((await postCallback(t, INSTAGRAM_DATA_DELETION_PATH, signed)).status).toBe(503);
    await expectUnchanged(t, a.connectionId);

    vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
    const local = await (await postCallback(t, INSTAGRAM_DATA_DELETION_PATH, signed)).json();
    expect(local.url).toMatch(
      /^http:\/\/127\.0\.0\.1:3211\/instagram\/data-deletion\/status\?code=/,
    );
  });

  it.each(PATHS)("%s refuses anything not signed or not well-formed", async (path) => {
    const { t, a } = await connected();
    const good = await signRequest(payloadFor(DELETER.userId));
    const cases: [number, Promise<Response>][] = [
      [401, postCallback(t, path, await signRequest(payloadFor(DELETER.userId), "wrong-secret-1"))],
      [400, postCallback(t, path, "not-a-signed-request")],
      [400, postCallback(t, path, await signRequest({ algorithm: "HMAC-SHA256" }))],
      [400, postCallback(t, path, good, { body: "other_field=1" })],
      [400, postCallback(t, path, good, { contentType: "application/json", body: "{}" })],
      [400, postCallback(t, path, good, { headers: { "content-length": "12a" } })],
      [413, postCallback(t, path, good, { headers: { "content-length": "9000" } })],
      [413, postCallback(t, path, good, { body: `signed_request=${"a".repeat(9000)}` })],
    ];
    for (const [status, response] of cases) {
      const result = await response;
      expect(result.status).toBe(status);
      const text = await result.text();
      for (const value of PLATFORM_DATA) expect(text).not.toContain(value);
    }
    await expectUnchanged(t, a.connectionId);
  });

  it("shows no status for an unknown or malformed code, and never echoes the input", async () => {
    const t = newBackend();
    for (const code of ["ABCDEFGHJKLMNPQRSTUV", "<script>alert(1)</script>", ""]) {
      const page = await statusPage(t, encodeURIComponent(code));
      expect(page.status).toBe(404);
      expect(page.text).not.toContain("script");
    }
  });
});

describe("IM7.0 hardening", () => {
  const firstOrg = (t: Backend) =>
    t.run(async (ctx) => (await ctx.db.query("organizations").first())!._id);

  it("does not apply a callback issued before the connection's current authorization", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const a = await connectAndLink(t, "deleter");
    const stale = Math.floor((NOW - 60 * 60_000) / 1000); // an hour before it was authorized
    const signed = await signRequest(payloadFor(DELETER.scopedUserId, stale));
    expect((await postCallback(t, INSTAGRAM_DEAUTHORIZE_PATH, signed)).status).toBe(200);
    expect(connectionOf(await rows(t), a.connectionId).status).toBe("active");

    await postCallback(t, INSTAGRAM_DATA_DELETION_PATH, signed);
    await drainScheduler(t);
    const after = await rows(t);
    expect(connectionOf(after, a.connectionId).status).toBe("active");
    expect(after.socialAccounts).toHaveLength(1);
    expect(after.requests[0]).toMatchObject({ targets: [], status: "completed" });
  });

  it("deletes the org's unclaimed grants of that Instagram account", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    await connectAndLink(t, "deleter");
    // The same account consents again, but the grant is never claimed.
    const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
      provider: "instagram",
      returnUrl: RETURN_URL,
    });
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const code = fake.issueCode("deleter");
    const callback = await t.fetch(
      `/oauth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
      { method: "GET", redirect: "manual" },
    );
    expect(redirectParams(callback).get("status")).toBe("pending");
    const grants = () => t.run(async (ctx) => (await ctx.db.query("oauthGrants").collect()).length);
    expect(await grants()).toBe(1);

    await deletionResponse(t, DELETER.scopedUserId);
    await drainScheduler(t);
    expect(await grants()).toBe(0);
  });

  it("never touches a messaging account created after the org's part started", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const a = await withMessages(t, "deleter");
    await deletionResponse(t, DELETER.scopedUserId);
    const requestId = (await rows(t)).requests[0]!._id;
    expect(await t.mutation(TARGET, { requestId, index: 0 })).toBe("waiting");

    const later = await t.run(async (ctx) => {
      const { orgId } = (await ctx.db.get(a.connectionId))!;
      return await ctx.db.insert("instagramMessagingAccounts", {
        orgId,
        socialAccountId: a.socialAccountId,
        connectionId: a.connectionId,
        igAccountId: DELETER.userId,
        status: "active",
        enabledBySubject: "user_admin",
        activatedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    await drainScheduler(t);
    const after = await rows(t);
    expect(after.messagingAccounts.find((r) => r._id === later)).toMatchObject({
      status: "active",
    });
    expect(after.messagingAccounts.some((r) => r._id === a.accountId)).toBe(false);
    expect(after.requests[0]!.status).toBe("completed");
  });

  it("answers 500 (Meta retries) rather than handle only some of more than 50 connections", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const orgId = await firstOrg(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 51; i++) {
        await ctx.db.insert("connections", {
          orgId,
          provider: "instagram",
          externalUserId: `1784140000${String(i).padStart(4, "0")}`,
          scopedUserId: DELETER.scopedUserId,
          status: "active",
          grantedScopes: [],
          credentialVersion: 1,
          connectedBySubject: "user_admin",
          connectedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    });
    const signed = await signRequest(payloadFor(DELETER.scopedUserId));
    for (const path of [INSTAGRAM_DEAUTHORIZE_PATH, INSTAGRAM_DATA_DELETION_PATH]) {
      const status = await postCallback(t, path, signed).then(
        (response) => response.status,
        () => 500,
      );
      expect(status).toBe(500);
    }
    const after = await rows(t);
    expect(after.requests).toEqual([]);
    expect(after.connections.every((c) => c.status === "active")).toBe(true);
  });
});

describe("verification: never Completed while an older connection remains", () => {
  const SWEEP = internal.instagram.dataDeletion.requests.sweepDeletionRequests;
  const CLOSE = internal.instagram.dataDeletion.requests.closeDeletionReview;
  const ERASE = internal.instagram.dataDeletion.requests.eraseLegacyInstagramConnection;

  it("waits in review for 150 older connections; closing is not completing; verified at last", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const orgId = await t.run(async (ctx) => (await ctx.db.query("organizations").first())!._id);
    // 250 connections recorded since IM6 and 150 older ones (no scoped id): the scan spans
    // pages, and the last older connection sorts last.
    const legacy = await t.run(async (ctx) => {
      const insert = (externalUserId: string, scopedUserId?: string) =>
        ctx.db.insert("connections", {
          orgId,
          provider: "instagram",
          externalUserId,
          ...(scopedUserId !== undefined ? { scopedUserId } : {}),
          status: "active",
          grantedScopes: [],
          credentialVersion: 1,
          connectedBySubject: "user_admin",
          connectedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        });
      for (let i = 0; i < 250; i++) await insert(`17840${String(i).padStart(11, "0")}`, `8${i}`);
      const ids: Id<"connections">[] = [];
      for (let i = 0; i < 150; i++) ids.push(await insert(`17841${String(i).padStart(11, "0")}`));
      return ids;
    });

    // A user with no stored data: with older connections around, never completed.
    const answer = await deletionResponse(t, "9000000000009999");
    await drainScheduler(t);
    const requestId = (await rows(t)).requests[0]!._id;
    expect((await rows(t)).requests[0]!.status).toBe("review");
    let page = await statusPage(t, answer.confirmation_code);
    expect(page.text).toContain("Some older connections still have to be checked");
    expect(page.text).not.toContain("Completed");

    // 149 of 150 resolved (reconnected: their scoped id is known now): still review.
    await t.run(async (ctx) => {
      for (const id of legacy.slice(0, 149)) await ctx.db.patch(id, { scopedUserId: `7${id}` });
    });
    await t.mutation(SWEEP, {});
    await drainScheduler(t);
    expect((await rows(t)).requests[0]!.status).toBe("review");

    // The operator closes the investigation: closed WITHOUT verification, never completed.
    const close = () =>
      t.mutation(CLOSE, { requestId, reasonCode: "requester_unreachable", operator: "ops" });
    expect(await close()).toBe("closed");
    const closed = (await rows(t)).requests[0]!;
    expect(closed).toMatchObject({
      status: "closed_unverified",
      closeReason: "requester_unreachable",
    });
    expect(closed.completedAt).toBeUndefined();
    page = await statusPage(t, answer.confirmation_code);
    expect(page.text).toContain("Closed without full verification");
    expect(page.text).not.toContain("Completed");
    expect(await close()).toBe("refused");

    // Erasing a connection recorded since IM6 is refused; the last older one is erased by the
    // operator (the org agreed), through the same deletion steps.
    const recordedSinceIm6 = (await rows(t)).connections.find((c) => c.scopedUserId === "80")!;
    expect(
      await t.mutation(ERASE, {
        connectionId: recordedSinceIm6._id,
        reasonCode: "org_consented",
        operator: "ops",
      }),
    ).toBeNull();
    const eraseId = await t.mutation(ERASE, {
      connectionId: legacy[149]!,
      reasonCode: "org_consented",
      operator: "ops",
    });
    expect(eraseId).not.toBeNull();
    await drainScheduler(t);

    const after = await rows(t);
    expect(connectionOf(after, legacy[149]!).externalUserId).toBe(`erased:${legacy[149]}`);
    expect(after.requests.map((r) => [r.origin, r.status])).toEqual([
      ["meta", "completed"],
      ["operator", "completed"],
    ]);
    page = await statusPage(t, answer.confirmation_code);
    expect(page.text).toContain("Completed on");
    // An operator erase has no public status page; a completed request cannot be closed.
    const operatorCode = after.requests.find((r) => r.origin === "operator")!.confirmationCode;
    expect((await statusPage(t, operatorCode)).status).toBe(404);
    expect(await close()).toBe("refused");
  });

  it("lists older connections page by page for the operator", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const a = await connectAndLink(t, "deleter");
    const LIST = internal.instagram.dataDeletion.requests.listLegacyInstagramConnections;
    const first = await t.query(LIST, { paginationOpts: { numItems: 50, cursor: null } });
    expect(first.page).toEqual([]);
    await t.run((ctx) => ctx.db.patch(a.connectionId, { scopedUserId: undefined }));
    const listed = await t.query(LIST, { paginationOpts: { numItems: 50, cursor: null } });
    expect(listed.page.map((c) => c.connectionId)).toEqual([a.connectionId]);
  });
});
