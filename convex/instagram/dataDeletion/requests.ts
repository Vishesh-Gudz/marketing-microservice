import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type DatabaseReader,
  type MutationCtx,
} from "../../_generated/server";
import {
  deleteCredential,
  deletePendingGrantsForIdentity,
  hasCredential,
} from "../../connections/credentialStore";
import { disconnectConnection, markConnectionNeedsReauth } from "../../connections/lifecycle";
import { deleteChannelRows, NO_COUNTS } from "../../connections/youtubeRetention";
import { literalUnion } from "../../domain/validators";
import { AUDIT_ACTIONS, SYSTEM_INSTAGRAM_DATA_DELETION_SUBJECT, writeAudit } from "../../lib/audit";
import type { Tenant } from "../../lib/tenancy";
import { stopMessagingForConnection } from "../messaging/accounts";
import { requestAccountDataDeletion } from "../messaging/purge";
import {
  ADVANCE_RETRY_MS,
  AUTHORIZATION_SKEW_MS,
  CLOSE_REASONS,
  COMPLETE_BATCH,
  CREDENTIAL_GRACE_MS,
  DELETION_STEP_DELETES,
  ERASE_REASONS,
  ERASED_IDENTITY_PREFIX,
  MAX_ADVANCE_RETRIES,
  MAX_CONNECTIONS_PER_USER,
  STALLED_AFTER_MS,
  SWEEP_BATCH,
  VERIFY_PAGE,
} from "./config";
import { newConfirmationCode } from "./signedRequest";

/**
 * What Meta's verified Instagram callbacks do (ADR 0017, IM6 and IM7.0). The HTTP handlers
 * (callbacks.ts) verify the signed request; nothing here is reachable without that, except the
 * internal operator functions at the end.
 *
 * Meta names an Instagram user, not a tenant: every org's Instagram connection of that user is
 * found through the two approved global indexes (the Instagram-scoped user id recorded at
 * connect, or the professional account id, RI14). From there, every read and write is under
 * that connection's own orgId, as a system actor of that org. A callback issued before a
 * connection's current authorization (`authorizedAt`) does not apply to it.
 *
 * DEAUTHORIZE (the user removed the app): each active connection -> `needs_reauth`
 * (`instagram_deauthorized`) and its direct messages stop (30-day grace, D14). Data is kept.
 *
 * DATA DELETION (Meta: "any data your app has ... about the user"): the callback only records
 * the request. Each org's part then runs in its own mutations (`advanceDeletionTarget`), so one
 * org's failure never blocks another's:
 * 1. start: the connection is disconnected (its credential deleted by the disconnect flow;
 *    Instagram has no revoke call), its unclaimed grants deleted, the Instagram account unlinked
 *    and marked for deletion (status "disconnected": no relink until done), and its messaging
 *    accounts' direct messages purged now (D14). The messaging accounts are RECORDED here: only
 *    they are deleted later, never one created afterwards;
 * 2. bounded steps: each recorded messaging account's row once its purge is done; then the
 *    account's stored analytics (YouTube's platform-neutral `deleteChannelRows`) and the account
 *    row; finally the connection's Instagram identity is erased (the row stays). A connection
 *    authorized again since the request is left as it is.
 * Then verification (`verifyDeletionRequests`): `completed` ONLY when every part is done AND a
 * full scan finds no older (pre-IM6) Instagram connection anywhere (no scoped id, not erased):
 * such a connection may be the requester's and cannot be matched. Otherwise `review`.
 */

type Request = Doc<"instagramDataDeletionRequests">;
type Target = Request["targets"][number];

/** Every org's Instagram connection of the user Meta named (either id). Too many: refused. */
async function connectionsOfUser(
  db: DatabaseReader,
  userId: string,
): Promise<Doc<"connections">[]> {
  const byScopedId = await db
    .query("connections")
    .withIndex("by_provider_scoped_user", (q) =>
      q.eq("provider", "instagram").eq("scopedUserId", userId),
    )
    .take(MAX_CONNECTIONS_PER_USER + 1);
  const byAccountId = await db
    .query("connections")
    .withIndex("by_provider_identity", (q) =>
      q.eq("provider", "instagram").eq("externalUserId", userId),
    )
    .take(MAX_CONNECTIONS_PER_USER + 1);
  if (
    byScopedId.length > MAX_CONNECTIONS_PER_USER ||
    byAccountId.length > MAX_CONNECTIONS_PER_USER
  ) {
    // Never handle some and report the rest as done: the callback answers 500 and Meta retries.
    throw new Error("Too many Instagram connections for one user");
  }
  const found = new Map<Id<"connections">, Doc<"connections">>();
  for (const connection of [...byScopedId, ...byAccountId]) found.set(connection._id, connection);
  return [...found.values()];
}

/** True when the connection was authorized after the callback was issued (it does not apply). */
function authorizedAfter(connection: Doc<"connections">, issuedAtMs: number | undefined): boolean {
  return (
    issuedAtMs !== undefined &&
    connection.authorizedAt !== undefined &&
    connection.authorizedAt > issuedAtMs + AUTHORIZATION_SKEW_MS
  );
}

/** An older (pre-IM6) Instagram connection: no scoped id recorded, identity not erased. */
function isLegacyInstagram(connection: Doc<"connections">): boolean {
  return (
    connection.provider === "instagram" &&
    connection.scopedUserId === undefined &&
    !connection.externalUserId.startsWith(ERASED_IDENTITY_PREFIX)
  );
}

/** A system actor of the org (null when the org no longer exists). */
async function systemTenant(
  db: DatabaseReader,
  orgId: Id<"organizations">,
  subject = SYSTEM_INSTAGRAM_DATA_DELETION_SUBJECT,
): Promise<Tenant | null> {
  const org = await db.get(orgId);
  if (org === null) return null;
  return {
    orgId,
    appId: org.appId,
    issuer: org.issuer,
    externalOrgId: org.externalOrgId,
    subject,
    role: "admin",
  };
}

/** The org's Instagram account of a connection (one connection is one professional account). */
async function instagramAccountOf(
  db: DatabaseReader,
  connection: Doc<"connections">,
): Promise<Doc<"socialAccounts"> | null> {
  return await db
    .query("socialAccounts")
    .withIndex("by_org_platform_external", (q) =>
      q
        .eq("orgId", connection.orgId)
        .eq("platform", "instagram")
        .eq("externalId", connection.externalUserId),
    )
    .first();
}

/** The org's messaging accounts reached through the connection or the Instagram account. */
async function messagingAccountsOf(
  db: DatabaseReader,
  orgId: Id<"organizations">,
  connectionId: Id<"connections">,
  socialAccountId: Id<"socialAccounts"> | undefined,
): Promise<Doc<"instagramMessagingAccounts">[]> {
  const found = new Map<Id<"instagramMessagingAccounts">, Doc<"instagramMessagingAccounts">>();
  const byConnection = await db
    .query("instagramMessagingAccounts")
    .withIndex("by_org_connection", (q) => q.eq("orgId", orgId).eq("connectionId", connectionId))
    .take(50);
  for (const account of byConnection) found.set(account._id, account);
  if (socialAccountId !== undefined) {
    const bySocialAccount = await db
      .query("instagramMessagingAccounts")
      .withIndex("by_org_social_account", (q) =>
        q.eq("orgId", orgId).eq("socialAccountId", socialAccountId),
      )
      .take(50);
    for (const account of bySocialAccount) found.set(account._id, account);
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Deauthorize
// ---------------------------------------------------------------------------

/** Meta's deauthorize callback, verified: reconnect needed, direct messages stop. */
export const deauthorize = internalMutation({
  args: { userId: v.string(), issuedAtMs: v.optional(v.number()) },
  returns: v.object({ connections: v.number() }),
  handler: async (ctx, { userId, issuedAtMs }) => {
    let handled = 0;
    for (const connection of await connectionsOfUser(ctx.db, userId)) {
      if (connection.status === "revoked" || authorizedAfter(connection, issuedAtMs)) continue;
      const tenant = await systemTenant(ctx.db, connection.orgId);
      if (tenant === null) continue;
      if (connection.status === "active") {
        await markConnectionNeedsReauth(
          ctx.db,
          connection._id,
          "instagram_deauthorized",
          tenant.subject,
        );
      }
      await stopMessagingForConnection(ctx.db, tenant, connection._id, "deauthorized");
      handled++;
    }
    return { connections: handled };
  },
});

// ---------------------------------------------------------------------------
// Data deletion: recording, then one org's part at a time
// ---------------------------------------------------------------------------

/**
 * Meta's data-deletion callback, verified: records the request (or returns the code of the same
 * delivery seen before) and starts it. `confirmationCode` is fresh from the caller.
 */
export const recordDeletionRequest = internalMutation({
  args: {
    userId: v.string(),
    issuedAtMs: v.optional(v.number()),
    requestKey: v.string(),
    confirmationCode: v.string(),
  },
  returns: v.object({ confirmationCode: v.string() }),
  handler: async (ctx, { userId, issuedAtMs, requestKey, confirmationCode }) => {
    const existing = await ctx.db
      .query("instagramDataDeletionRequests")
      .withIndex("by_request_key", (q) => q.eq("requestKey", requestKey))
      .first();
    if (existing !== null) return { confirmationCode: existing.confirmationCode };

    const now = Date.now();
    const targets: Target[] = (await connectionsOfUser(ctx.db, userId))
      .filter((connection) => !authorizedAfter(connection, issuedAtMs))
      .map((connection) => ({
        orgId: connection.orgId,
        connectionId: connection._id,
        begun: false,
        messagingAccountIds: [],
        done: false,
      }));
    const requestId = await ctx.db.insert("instagramDataDeletionRequests", {
      confirmationCode,
      requestKey,
      origin: "meta",
      status: "pending",
      targets,
      receivedAt: now,
      nextAttemptAt: now,
      attempts: 0,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.instagram.dataDeletion.requests.advanceDeletionRequest,
      { requestId },
    );
    return { confirmationCode };
  },
});

/** Step 1 of one org's part (see the module comment); returns the started target. */
async function beginTarget(
  ctx: MutationCtx,
  tenant: Tenant,
  target: Target,
  now: number,
): Promise<Target> {
  const connection = await ctx.db.get(target.connectionId);
  if (connection === null || connection.orgId !== tenant.orgId) return { ...target, begun: true };
  if (connection.status !== "revoked") {
    await disconnectConnection({ ...ctx, tenant }, connection._id);
  }
  await deletePendingGrantsForIdentity(
    ctx.db,
    tenant.orgId,
    "instagram",
    connection.externalUserId,
    tenant.subject,
  );
  const account = await instagramAccountOf(ctx.db, connection);
  if (account !== null && account.status !== "disconnected") {
    await ctx.db.patch(account._id, {
      status: "disconnected",
      connectionId: undefined,
      linkedAt: undefined,
      updatedAt: now,
    });
  }
  const messaging = await messagingAccountsOf(ctx.db, tenant.orgId, connection._id, account?._id);
  for (const row of messaging) await requestAccountDataDeletion(ctx, tenant.orgId, row._id);
  await writeAudit(ctx.db, tenant, {
    action: AUDIT_ACTIONS.instagramDataDeletionRequested,
    targetType: "connection",
    targetId: connection._id,
    changes: {
      socialAccounts: { from: null, to: account === null ? 0 : 1 },
      messagingAccounts: { from: null, to: messaging.length },
    },
  });
  return {
    ...target,
    begun: true,
    ...(account !== null ? { socialAccountId: account._id } : {}),
    messagingAccountIds: messaging.map((row) => row._id),
  };
}

/** Step 2 of one org's part; true when nothing of it is left. Budgeted. */
async function advanceTarget(
  ctx: MutationCtx,
  tenant: Tenant,
  target: Target,
  budget: { left: number },
  receivedAt: number,
  now: number,
): Promise<boolean> {
  const { orgId } = tenant;

  // a. The RECORDED messaging accounts: each one's purge first, then its row.
  let waiting = false;
  for (const accountId of target.messagingAccountIds) {
    const account = await ctx.db.get(accountId);
    if (account === null || account.orgId !== orgId) continue; // already deleted
    const disabled = account.status === "disabled";
    if (disabled && account.purgeAfter === undefined && account.purgeStartedAt === undefined) {
      await ctx.db.delete(account._id); // its purge is done (or it never held data)
      budget.left--;
      continue;
    }
    // Turned on again, or back in a grace period, since the request: purge it now again.
    if (!disabled || account.purgeAfter === undefined || account.purgeAfter > now) {
      await requestAccountDataDeletion(ctx, orgId, account._id);
    }
    waiting = true; // its purge is scheduled or running (the D14 sweep resumes it)
  }
  if (waiting) return false;

  // b. The Instagram account's stored analytics, then the account row.
  if (target.socialAccountId !== undefined) {
    const account = await ctx.db.get(target.socialAccountId);
    if (account !== null && account.orgId === orgId && account.platform === "instagram") {
      if (account.status !== "disconnected") {
        await ctx.db.patch(account._id, {
          status: "disconnected",
          connectionId: undefined,
          linkedAt: undefined,
          updatedAt: now,
        });
      }
      if (!(await deleteChannelRows(ctx, account, budget, { ...NO_COUNTS }, now))) return false;
      if (budget.left <= 0) return false;
      await ctx.db.delete(account._id);
      budget.left--;
      await writeAudit(ctx.db, tenant, {
        action: AUDIT_ACTIONS.socialAccountPurged,
        targetType: "socialAccount",
        targetId: account._id,
      });
    }
  }

  // c. The connection: credential gone, then its Instagram identity erased. A connection
  //    authorized again since the request (a new consent) is left as it is.
  const connection = await ctx.db.get(target.connectionId);
  if (
    connection !== null &&
    connection.orgId === orgId &&
    connection.provider === "instagram" &&
    connection.status === "revoked" &&
    !((connection.authorizedAt ?? 0) > receivedAt)
  ) {
    if (await hasCredential(ctx.db, orgId, connection._id)) {
      // The disconnect's scheduled action deletes it; after the grace period, this step does.
      if (now - receivedAt < CREDENTIAL_GRACE_MS) return false;
      await deleteCredential(ctx.db, orgId, connection._id);
      await writeAudit(ctx.db, tenant, {
        action: AUDIT_ACTIONS.credentialDeleted,
        targetType: "connection",
        targetId: connection._id,
      });
    }
    if (!connection.externalUserId.startsWith(ERASED_IDENTITY_PREFIX)) {
      await ctx.db.patch(connection._id, {
        externalUserId: `${ERASED_IDENTITY_PREFIX}${connection._id}`,
        displayName: undefined,
        scopedUserId: undefined,
        updatedAt: now,
      });
    }
  }

  await writeAudit(ctx.db, tenant, {
    action: AUDIT_ACTIONS.instagramDataDeletionCompleted,
    targetType: "connection",
    targetId: target.connectionId,
  });
  return true;
}

/**
 * Fans a pending request out to one mutation per org part. Moves `nextAttemptAt` ahead first
 * (whatever the parts then do), so the hourly sweep rotates through stalled requests.
 */
export const advanceDeletionRequest = internalMutation({
  args: { requestId: v.id("instagramDataDeletionRequests") },
  returns: v.union(v.literal("skipped"), v.literal("scheduled"), v.literal("verifying")),
  handler: async (ctx, { requestId }) => {
    const request = await ctx.db.get(requestId);
    if (request === null || request.status !== "pending") return "skipped" as const;
    if (request.targets.every((target) => target.done)) {
      await ctx.scheduler.runAfter(
        0,
        internal.instagram.dataDeletion.requests.verifyDeletionRequests,
        {},
      );
      return "verifying" as const;
    }
    const now = Date.now();
    await ctx.db.patch(requestId, {
      nextAttemptAt: now + STALLED_AFTER_MS,
      attempts: request.attempts + 1,
      updatedAt: now,
    });
    for (let index = 0; index < request.targets.length; index++) {
      if (!request.targets[index]!.done) {
        await ctx.scheduler.runAfter(
          0,
          internal.instagram.dataDeletion.requests.advanceDeletionTarget,
          { requestId, index },
        );
      }
    }
    return "scheduled" as const;
  },
});

/** One org's part of a request (bounded); continues itself while it makes progress or waits. */
export const advanceDeletionTarget = internalMutation({
  args: {
    requestId: v.id("instagramDataDeletionRequests"),
    index: v.number(),
    attempt: v.optional(v.number()),
  },
  returns: v.union(
    v.literal("skipped"),
    v.literal("continued"),
    v.literal("waiting"),
    v.literal("paused"),
    v.literal("done"),
  ),
  handler: async (ctx, { requestId, index, attempt }) => {
    const request = await ctx.db.get(requestId);
    const target = request?.targets[index];
    if (request === null || target === undefined || target.done) return "skipped" as const;
    const now = Date.now();
    const tenant = await systemTenant(ctx.db, target.orgId);
    let current: Target = target;
    if (tenant === null) {
      current = { ...current, begun: true, done: true }; // the org and its rows are gone
    } else {
      const budget = { left: DELETION_STEP_DELETES };
      if (!current.begun) current = await beginTarget(ctx, tenant, current, now);
      if (!current.done) {
        current = {
          ...current,
          done: await advanceTarget(ctx, tenant, current, budget, request.receivedAt, now),
        };
      }
      if (!current.done && budget.left <= 0) {
        await save(ctx, request, index, current, now);
        await ctx.scheduler.runAfter(
          0,
          internal.instagram.dataDeletion.requests.advanceDeletionTarget,
          { requestId, index, ...(attempt !== undefined ? { attempt } : {}) },
        );
        return "continued" as const;
      }
    }

    const targets = await save(ctx, request, index, current, now);
    if (current.done) {
      if (targets.every((t) => t.done)) {
        await ctx.scheduler.runAfter(
          0,
          internal.instagram.dataDeletion.requests.verifyDeletionRequests,
          {},
        );
      }
      return "done" as const;
    }
    const next = (attempt ?? 0) + 1;
    if (next >= MAX_ADVANCE_RETRIES) return "paused" as const; // the hourly sweep resumes it
    await ctx.scheduler.runAfter(
      ADVANCE_RETRY_MS,
      internal.instagram.dataDeletion.requests.advanceDeletionTarget,
      { requestId, index, attempt: next },
    );
    return "waiting" as const;
  },
});

async function save(
  ctx: MutationCtx,
  request: Request,
  index: number,
  target: Target,
  now: number,
): Promise<Target[]> {
  const targets = request.targets.map((t, i) => (i === index ? target : t));
  await ctx.db.patch(request._id, { targets, updatedAt: now });
  return targets;
}

/**
 * Hourly (convex/crons.ts): resumes pending requests whose `nextAttemptAt` passed (oldest
 * first; every resume moves it ahead), and re-verifies requests in review.
 */
export const sweepDeletionRequests = internalMutation({
  args: {},
  returns: v.object({ resumed: v.number() }),
  handler: async (ctx) => {
    const due = await ctx.db
      .query("instagramDataDeletionRequests")
      .withIndex("by_status_next_attempt", (q) =>
        q.eq("status", "pending").lte("nextAttemptAt", Date.now()),
      )
      .take(SWEEP_BATCH);
    for (const request of due) {
      await ctx.scheduler.runAfter(
        0,
        internal.instagram.dataDeletion.requests.advanceDeletionRequest,
        { requestId: request._id },
      );
    }
    await ctx.scheduler.runAfter(
      0,
      internal.instagram.dataDeletion.requests.verifyDeletionRequests,
      {},
    );
    return { resumed: due.length };
  },
});

// ---------------------------------------------------------------------------
// Verification: no request completes while an older connection remains anywhere
// ---------------------------------------------------------------------------

/**
 * Scans every Instagram connection (VERIFY_PAGE per step, continuing itself). The first older
 * (pre-IM6) connection found stops it: requests whose parts are done go to `review`. A scan
 * that ends without finding one lets every request whose parts are done complete. The set of
 * older connections only shrinks (every connect since IM6 records a scoped id), so a clean scan
 * stays true.
 */
export const verifyDeletionRequests = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.union(v.literal("legacy_remains"), v.literal("scanning"), v.literal("verified")),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("connections")
      .withIndex("by_provider_identity", (q) => q.eq("provider", "instagram"))
      .paginate({ numItems: VERIFY_PAGE, cursor: cursor ?? null });
    const settle = internal.instagram.dataDeletion.requests.settleDeletionRequests;
    if (page.page.some(isLegacyInstagram)) {
      await ctx.scheduler.runAfter(0, settle, { verified: false, status: "pending" });
      return "legacy_remains" as const;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.instagram.dataDeletion.requests.verifyDeletionRequests,
        { cursor: page.continueCursor },
      );
      return "scanning" as const;
    }
    await ctx.scheduler.runAfter(0, settle, { verified: true, status: "pending" });
    return "verified" as const;
  },
});

const SETTLE_ORDER = ["pending", "review", "closed_unverified"] as const;

/**
 * Applies a verification to requests whose every part is done, COMPLETE_BATCH per step:
 * verified -> `completed` (pending, review and closed_unverified alike); not verified ->
 * pending ones go to `review`.
 */
export const settleDeletionRequests = internalMutation({
  args: {
    verified: v.boolean(),
    status: literalUnion(SETTLE_ORDER),
    cursor: v.optional(v.string()),
  },
  returns: v.number(),
  handler: async (ctx, { verified, status, cursor }) => {
    const now = Date.now();
    const page = await ctx.db
      .query("instagramDataDeletionRequests")
      .withIndex("by_status_next_attempt", (q) => q.eq("status", status))
      .paginate({ numItems: COMPLETE_BATCH, cursor: cursor ?? null });
    let settled = 0;
    for (const request of page.page) {
      if (!request.targets.every((target) => target.done)) continue;
      if (verified) {
        await ctx.db.patch(request._id, { status: "completed", completedAt: now, updatedAt: now });
        settled++;
      } else if (status === "pending") {
        await ctx.db.patch(request._id, { status: "review", updatedAt: now });
        settled++;
      }
    }
    const self = internal.instagram.dataDeletion.requests.settleDeletionRequests;
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, self, { verified, status, cursor: page.continueCursor });
    } else if (verified) {
      const next = SETTLE_ORDER[SETTLE_ORDER.indexOf(status) + 1];
      if (next !== undefined) await ctx.scheduler.runAfter(0, self, { verified, status: next });
    }
    return settled;
  },
});

/** What the public status page may show: dates and state only. */
export const deletionStatus = internalQuery({
  args: { confirmationCode: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      status: v.union(
        v.literal("pending"),
        v.literal("review"),
        v.literal("completed"),
        v.literal("closed_unverified"),
      ),
      receivedAt: v.number(),
      completedAt: v.optional(v.number()),
      closedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, { confirmationCode }) => {
    const request = await ctx.db
      .query("instagramDataDeletionRequests")
      .withIndex("by_confirmation_code", (q) => q.eq("confirmationCode", confirmationCode))
      .first();
    if (request === null || request.origin !== "meta") return null;
    return {
      status: request.status,
      receivedAt: request.receivedAt,
      ...(request.completedAt !== undefined ? { completedAt: request.completedAt } : {}),
      ...(request.closedAt !== undefined ? { closedAt: request.closedAt } : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// Operator functions (internal: `npx convex run`, never reachable from a tenant)
// ---------------------------------------------------------------------------

/** Older (pre-IM6) Instagram connections, a page of all Instagram connections at a time. */
export const listLegacyInstagramConnections = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(
      v.object({
        connectionId: v.id("connections"),
        orgId: v.id("organizations"),
        status: v.string(),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { paginationOpts }) => {
    const result = await ctx.db
      .query("connections")
      .withIndex("by_provider_identity", (q) => q.eq("provider", "instagram"))
      .paginate(paginationOpts);
    return {
      page: result.page
        .filter(isLegacyInstagram)
        .map((c) => ({ connectionId: c._id, orgId: c.orgId, status: c.status })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * Closes a review WITHOUT full verification: `closed_unverified`, never `completed`. Only from
 * `review` (its own deletion work is done). A later verification still completes it.
 */
export const closeDeletionReview = internalMutation({
  args: {
    requestId: v.id("instagramDataDeletionRequests"),
    reasonCode: literalUnion(CLOSE_REASONS),
    operator: v.string(),
  },
  returns: v.union(v.literal("closed"), v.literal("refused")),
  handler: async (ctx, { requestId, reasonCode, operator }) => {
    const request = await ctx.db.get(requestId);
    if (request === null || request.status !== "review") return "refused" as const;
    const now = Date.now();
    await ctx.db.patch(requestId, {
      status: "closed_unverified",
      closedAt: now,
      closeReason: reasonCode,
      closedBy: operator,
      updatedAt: now,
    });
    return "closed" as const;
  },
});

/**
 * Deletes an older (pre-IM6) Instagram connection's data and erases its identity (the org
 * agreed, or the connection is abandoned), through the same steps as a Meta request (origin
 * `operator`, not shown on the status page). Refused for anything but an older connection.
 */
export const eraseLegacyInstagramConnection = internalMutation({
  args: {
    connectionId: v.id("connections"),
    reasonCode: literalUnion(ERASE_REASONS),
    operator: v.string(),
  },
  returns: v.union(v.id("instagramDataDeletionRequests"), v.null()),
  handler: async (ctx, { connectionId, reasonCode, operator }) => {
    const connection = await ctx.db.get(connectionId);
    if (connection === null || !isLegacyInstagram(connection)) return null;
    const tenant = await systemTenant(ctx.db, connection.orgId, `operator:${operator}`);
    if (tenant === null) return null;
    const now = Date.now();
    const requestId = await ctx.db.insert("instagramDataDeletionRequests", {
      confirmationCode: newConfirmationCode(),
      requestKey: `operator:${connectionId}:${now}`,
      origin: "operator",
      operatorReason: reasonCode,
      status: "pending",
      targets: [
        {
          orgId: connection.orgId,
          connectionId,
          begun: false,
          messagingAccountIds: [],
          done: false,
        },
      ],
      receivedAt: now,
      nextAttemptAt: now,
      attempts: 0,
      updatedAt: now,
    });
    await writeAudit(ctx.db, tenant, {
      action: AUDIT_ACTIONS.instagramDataDeletionRequested,
      targetType: "connection",
      targetId: connectionId,
      changes: { reason: { from: null, to: reasonCode } },
    });
    await ctx.scheduler.runAfter(
      0,
      internal.instagram.dataDeletion.requests.advanceDeletionRequest,
      { requestId },
    );
    return requestId;
  },
});
