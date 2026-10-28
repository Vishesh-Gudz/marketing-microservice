import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type DatabaseWriter,
  type MutationCtx,
} from "../_generated/server";
import { literalUnion } from "../domain/validators";
import {
  AUDIT_ACTIONS,
  AUDIT_CODE_PATTERN,
  SYSTEM_YOUTUBE_RETENTION_SUBJECT,
  writeAudit,
} from "../lib/audit";
import { isProviderError, PROVIDER_ERROR_KINDS } from "../providers/errors";
import { cancelRun } from "../sync/runs";
import { findSocialSyncAccount } from "../sync/state";
import { providerRegistry, YOUTUBE_RETENTION } from "./config";
import { CredentialUnavailableError, withConnectionCredential } from "./credentialStore";

/**
 * YouTube data retention (ADR 0016, Checkpoint 3b; YouTube API Services Developer Policies
 * III.D.2.3 and III.E.4; docs/providers/youtube.md "Retention").
 *
 * WHAT is deleted: a YouTube channel's stored data is HARD-deleted — its videos, their lifetime
 * snapshots, its day rows, its sync runs and tasks, its sync state, then the channel row itself
 * (last, so an interrupted purge keeps its anchor and is resumed). Never: Instagram rows, rows of
 * another org, credentials (the credential store owns them), connection rows, audit entries.
 *
 * WHEN (each path re-verifies platform "youtube" and the org of every row it deletes):
 * 1. Disconnect and unlink (in-app): `markYouTubeAccountForPurge` marks the channel
 *    (status "disconnected", unlinked) in the admin's transaction and schedules the purge at
 *    once. Disconnect also revokes at Google through the existing flow.
 * 2. Hourly sweep: resumes every channel still marked (an interrupted chain), and deletes videos
 *    no listing has refreshed for 25 days with their snapshots. Absence from the listing is NOT
 *    evidence that a video was deleted on YouTube (it may also be beyond the 5,000-upload
 *    listing cap); the row is deleted because its metadata can no longer be refreshed.
 * 3. Daily authorization check: a linked channel whose authorization was last confirmed
 *    (socialAccounts.lastSeenAt: set by every successful sync preflight, a fresh token plus
 *    `channels.list?mine=true`, and at link time) more than 25 days ago gets ONE explicit check
 *    (a fresh token plus `channels.list?mine=true`, through the existing discovery). Only a
 *    confirmed failure purges:
 *      - Google's token endpoint answers `invalid_grant` (the refresh token is invalid,
 *        expired or revoked; we never claim WHICH)        -> authorization_invalid
 *      - the channel is not among the authorization's channels -> channel_not_authorized
 *      - no stored credential exists                       -> credential_missing
 *      - the connection was revoked (an in-app disconnect)  -> disconnected
 *    Everything else (network, timeout, 5xx, quota, configuration, an unusable or undecryptable
 *    credential, another auth or permission code) is INCONCLUSIVE: the data is kept, the outcome
 *    is audited (kind and an allowlisted code only) and the check runs again the next day.
 *    A check that finds the channel confirms the authorization: lastSeenAt is set to now.
 *
 * RELINK: a channel marked for purge cannot be linked again until its purge completed
 * (linkSocialAccounts: CONFLICT purge_pending); afterwards it is linked as a new channel and
 * backfilled from scratch, so no partially deleted history is ever resumed.
 *
 * HOW: every purge step deletes at most purgeStepDeletes rows and schedules its continuation;
 * every step re-reads what is left, so a retried, repeated or overlapping run never deletes
 * twice and an interrupted one resumes. Convex runs mutations serializably. A sync page that
 * arrives after the channel was unlinked is refused by the engine's linkage check in its own
 * transaction, so a late commit can never re-create purged rows; an active run is cancelled.
 * No token is read, logged or returned here except inside the credential store's wrapper.
 */

export const YOUTUBE_PURGE_REASONS = [
  "disconnected",
  "unlinked",
  "authorization_invalid",
  "channel_not_authorized",
  "credential_missing",
] as const;
export type YouTubePurgeReason = (typeof YOUTUBE_PURGE_REASONS)[number];
const purgeReasonValidator = literalUnion(YOUTUBE_PURGE_REASONS);

const countsValidator = v.object({
  posts: v.number(),
  snapshots: v.number(),
  days: v.number(),
  runs: v.number(),
  tasks: v.number(),
});
type PurgeCounts = { posts: number; snapshots: number; days: number; runs: number; tasks: number };
const NO_COUNTS: PurgeCounts = { posts: 0, snapshots: 0, days: 0, runs: 0, tasks: 0 };

type Budget = { left: number };
type Actor = { orgId: Id<"organizations">; issuer: string; subject: string };

async function systemActor(db: DatabaseWriter, orgId: Id<"organizations">): Promise<Actor> {
  const org = await db.get(orgId);
  return { orgId, issuer: org?.issuer ?? "", subject: SYSTEM_YOUTUBE_RETENTION_SUBJECT };
}

/** Unlinks the channel and marks it for purge (the sweep's resume marker), audited. */
async function beginPurge(
  db: DatabaseWriter,
  account: Doc<"socialAccounts">,
  reason: YouTubePurgeReason,
  actor: Actor,
  now: number,
): Promise<void> {
  if (account.platform !== "youtube") throw new Error("Only YouTube channels are purged");
  await db.patch(account._id, {
    connectionId: undefined,
    linkedAt: undefined,
    status: "disconnected",
    updatedAt: now,
  });
  await writeAudit(db, actor, {
    action: AUDIT_ACTIONS.socialAccountPurgeStarted,
    targetType: "socialAccount",
    targetId: account._id,
    changes: { reason: { from: null, to: reason } },
  });
}

async function schedulePurge(ctx: MutationCtx, account: Doc<"socialAccounts">): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.connections.youtubeRetention.purgeYouTubeAccount, {
    orgId: account.orgId,
    socialAccountId: account._id,
  });
}

/**
 * Disconnect / unlink (connections/socialAssets.ts): marks a YouTube channel for purge and
 * schedules it, in the caller's transaction. `actor` is the admin.
 */
export async function markYouTubeAccountForPurge(
  ctx: MutationCtx,
  account: Doc<"socialAccounts">,
  reason: Extract<YouTubePurgeReason, "disconnected" | "unlinked">,
  actor: Actor,
  now: number,
): Promise<void> {
  await beginPurge(ctx.db, account, reason, actor, now);
  await schedulePurge(ctx, account);
}

/**
 * Deletes a video's snapshots, then the video. False when the budget ran out first (the video
 * is kept until its snapshots are gone, so nothing is orphaned).
 */
async function deleteVideo(
  db: DatabaseWriter,
  post: Doc<"socialPosts">,
  budget: Budget,
  counts: PurgeCounts,
): Promise<boolean> {
  if (budget.left <= 0) return false;
  const limit = budget.left;
  const snapshots = await db
    .query("socialPostMetricSnapshots")
    .withIndex("by_org_post_date", (q) => q.eq("orgId", post.orgId).eq("postId", post._id))
    .take(limit);
  for (const snapshot of snapshots) {
    await db.delete(snapshot._id);
    counts.snapshots++;
  }
  budget.left -= snapshots.length;
  if (snapshots.length === limit) return false; // maybe more: the next step continues
  await db.delete(post._id);
  budget.left--;
  counts.posts++;
  return true;
}

/** One bounded pass over the channel's dependent rows. True when none is left. */
async function deleteChannelRows(
  ctx: MutationCtx,
  account: Doc<"socialAccounts">,
  budget: Budget,
  counts: PurgeCounts,
  now: number,
): Promise<boolean> {
  const { orgId } = account;
  const syncAccount = await findSocialSyncAccount(ctx.db, orgId, account._id);
  if (syncAccount?.activeRunId !== undefined) {
    const run = await ctx.db.get(syncAccount.activeRunId);
    if (run !== null && run.orgId === orgId) await cancelRun(ctx, run, "account_unlinked", now);
  }

  for (;;) {
    const posts = await ctx.db
      .query("socialPosts")
      .withIndex("by_org_account_published", (q) =>
        q.eq("orgId", orgId).eq("socialAccountId", account._id),
      )
      .take(10);
    if (posts.length === 0) break;
    for (const post of posts) {
      if (!(await deleteVideo(ctx.db, post, budget, counts))) return false;
    }
  }

  for (;;) {
    if (budget.left <= 0) return false;
    const days = await ctx.db
      .query("socialAccountMetricsDaily")
      .withIndex("by_org_account_date", (q) =>
        q.eq("orgId", orgId).eq("socialAccountId", account._id),
      )
      .take(budget.left);
    if (days.length === 0) break;
    for (const day of days) await ctx.db.delete(day._id);
    budget.left -= days.length;
    counts.days += days.length;
  }

  for (;;) {
    const runs = await ctx.db
      .query("syncRuns")
      .withIndex("by_org_social_account_created", (q) =>
        q.eq("orgId", orgId).eq("socialAccountId", account._id),
      )
      .take(5);
    if (runs.length === 0) break;
    for (const run of runs) {
      if (budget.left <= 0) return false;
      const limit = budget.left;
      const tasks = await ctx.db
        .query("syncTasks")
        .withIndex("by_org_run_seq", (q) => q.eq("orgId", orgId).eq("runId", run._id))
        .take(limit);
      for (const task of tasks) await ctx.db.delete(task._id);
      budget.left -= tasks.length;
      counts.tasks += tasks.length;
      if (tasks.length === limit) return false;
      await ctx.db.delete(run._id);
      budget.left--;
      counts.runs++;
    }
  }

  if (budget.left <= 0) return false;
  const state = await findSocialSyncAccount(ctx.db, orgId, account._id);
  if (state !== null) {
    await ctx.db.delete(state._id);
    budget.left--;
  }
  return true;
}

/**
 * One purge step of a YouTube channel (bounded; continues itself). Skips — deletes nothing —
 * when the channel no longer exists, belongs to another org, is not YouTube, or is not marked
 * for purge (e.g. relinked in the meantime). `start` (the daily check, a confirmed failure)
 * marks it first, and only if its authorization is still unconfirmed since `staleBefore`.
 */
export const purgeYouTubeAccount = internalMutation({
  args: {
    orgId: v.id("organizations"),
    socialAccountId: v.id("socialAccounts"),
    start: v.optional(v.object({ reason: purgeReasonValidator, staleBefore: v.number() })),
    step: v.optional(v.number()),
    deleted: v.optional(countsValidator),
  },
  returns: v.object({
    status: v.union(
      v.literal("skipped"),
      v.literal("continued"),
      v.literal("paused"),
      v.literal("done"),
    ),
    deleted: countsValidator,
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const counts: PurgeCounts = { ...(args.deleted ?? NO_COUNTS) };
    const account = await ctx.db.get(args.socialAccountId);
    if (account === null || account.orgId !== args.orgId || account.platform !== "youtube") {
      return { status: "skipped" as const, deleted: counts };
    }
    if (account.status !== "disconnected") {
      const start = args.start;
      if (start === undefined || (account.lastSeenAt ?? 0) >= start.staleBefore) {
        return { status: "skipped" as const, deleted: counts };
      }
      await beginPurge(
        ctx.db,
        account,
        start.reason,
        await systemActor(ctx.db, account.orgId),
        now,
      );
    }

    const budget: Budget = { left: YOUTUBE_RETENTION.purgeStepDeletes };
    if (!(await deleteChannelRows(ctx, account, budget, counts, now))) {
      const step = (args.step ?? 0) + 1;
      if (step >= YOUTUBE_RETENTION.maxPurgeSteps) {
        return { status: "paused" as const, deleted: counts }; // the hourly sweep resumes it
      }
      await ctx.scheduler.runAfter(0, internal.connections.youtubeRetention.purgeYouTubeAccount, {
        orgId: account.orgId,
        socialAccountId: account._id,
        step,
        deleted: counts,
      });
      return { status: "continued" as const, deleted: counts };
    }

    // The anchor goes last: everything that pointed at it is gone.
    await ctx.db.delete(account._id);
    await writeAudit(ctx.db, await systemActor(ctx.db, account.orgId), {
      action: AUDIT_ACTIONS.socialAccountPurged,
      targetType: "socialAccount",
      targetId: account._id,
      changes: {
        posts: { from: null, to: counts.posts },
        snapshots: { from: null, to: counts.snapshots },
        days: { from: null, to: counts.days },
        runs: { from: null, to: counts.runs },
      },
    });
    return { status: "done" as const, deleted: counts };
  },
});

/**
 * Hourly (convex/crons.ts): resumes channels still marked for purge, and deletes YouTube videos
 * no listing has refreshed for 25 days with their snapshots (bounded; continues itself up to
 * maxContinuations times, then the next run continues).
 */
export const sweepYouTubeRetention = internalMutation({
  args: { continuation: v.optional(v.number()) },
  returns: v.object({ resumed: v.number(), videosDeleted: v.number(), continued: v.boolean() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const cutoff = now - YOUTUBE_RETENTION.videoNotSeenMs;

    // Approved global index: YouTube channels marked for purge, across orgs.
    const marked = await ctx.db
      .query("socialAccounts")
      .withIndex("by_platform_status_seen", (q) =>
        q.eq("platform", "youtube").eq("status", "disconnected"),
      )
      .take(YOUTUBE_RETENTION.accountsPerPass);
    for (const account of marked) await schedulePurge(ctx, account);

    // Approved global index: YouTube videos not refreshed by a listing since the cutoff.
    const budget: Budget = { left: YOUTUBE_RETENTION.sweepDeletes };
    const counts: PurgeCounts = { ...NO_COUNTS };
    const stale = await ctx.db
      .query("socialPosts")
      .withIndex("by_platform_seen", (q) => q.eq("platform", "youtube").lt("lastSeenAt", cutoff))
      .take(YOUTUBE_RETENTION.accountsPerPass * 2);
    for (const post of stale) {
      if (post.platform !== "youtube") continue;
      const owner = await ctx.db.get(post.socialAccountId);
      // Re-verified: the owning channel (when it still exists) is a YouTube channel of the
      // post's own org. A post whose channel row is already gone is a YouTube orphan.
      if (owner !== null && (owner.orgId !== post.orgId || owner.platform !== "youtube")) continue;
      if (!(await deleteVideo(ctx.db, post, budget, counts))) break;
    }

    const continuation = args.continuation ?? 0;
    const more = budget.left <= 0 || stale.length === YOUTUBE_RETENTION.accountsPerPass * 2;
    const continued = more && continuation < YOUTUBE_RETENTION.maxContinuations;
    if (continued) {
      await ctx.scheduler.runAfter(0, internal.connections.youtubeRetention.sweepYouTubeRetention, {
        continuation: continuation + 1,
      });
    }
    return { resumed: marked.length, videosDeleted: counts.posts, continued };
  },
});

/**
 * Daily (convex/crons.ts): every linked YouTube channel whose authorization was last confirmed
 * more than 25 days ago gets one explicit check (verifyYouTubeAuthorization). A channel that is
 * already unlinked (an in-app unlink from before retention existed) is marked for purge.
 * Paginated over the approved global index; continues itself up to maxContinuations times.
 */
export const planYouTubeAuthorizationChecks = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    continuation: v.optional(v.number()),
  },
  returns: v.object({ checks: v.number(), marked: v.number(), continued: v.boolean() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const staleBefore = now - YOUTUBE_RETENTION.authorizationCheckAfterMs;
    const page = await ctx.db
      .query("socialAccounts")
      .withIndex("by_platform_status_seen", (q) =>
        q.eq("platform", "youtube").eq("status", "active").lt("lastSeenAt", staleBefore),
      )
      .paginate({ numItems: YOUTUBE_RETENTION.accountsPerPass, cursor: args.cursor ?? null });
    let checks = 0;
    let marked = 0;
    for (const account of page.page) {
      if (account.platform !== "youtube") continue;
      if (account.connectionId === undefined) {
        await beginPurge(
          ctx.db,
          account,
          "unlinked",
          await systemActor(ctx.db, account.orgId),
          now,
        );
        await schedulePurge(ctx, account);
        marked++;
        continue;
      }
      await ctx.scheduler.runAfter(
        0,
        internal.connections.youtubeRetention.verifyYouTubeAuthorization,
        { orgId: account.orgId, socialAccountId: account._id, staleBefore },
      );
      checks++;
    }
    const continuation = args.continuation ?? 0;
    const continued = !page.isDone && continuation < YOUTUBE_RETENTION.maxContinuations;
    if (continued) {
      await ctx.scheduler.runAfter(
        0,
        internal.connections.youtubeRetention.planYouTubeAuthorizationChecks,
        { cursor: page.continueCursor, continuation: continuation + 1 },
      );
    }
    return { checks, marked, continued };
  },
});

/** The channel to check, re-verified (still linked, YouTube, same org, still unconfirmed). */
export const authorizationTarget = internalQuery({
  args: {
    orgId: v.id("organizations"),
    socialAccountId: v.id("socialAccounts"),
    staleBefore: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({ connectionId: v.id("connections"), externalId: v.string() }),
  ),
  handler: async (ctx, { orgId, socialAccountId, staleBefore }) => {
    const account = await ctx.db.get(socialAccountId);
    if (
      account === null ||
      account.orgId !== orgId ||
      account.platform !== "youtube" ||
      account.status !== "active" ||
      account.connectionId === undefined ||
      (account.lastSeenAt ?? 0) >= staleBefore
    ) {
      return null;
    }
    const connection = await ctx.db.get(account.connectionId);
    if (connection !== null && connection.orgId !== orgId) return null;
    return { connectionId: account.connectionId, externalId: account.externalId };
  },
});

export type AuthorizationOutcome =
  | { kind: "authorized" }
  | { kind: "confirmed"; reason: Exclude<YouTubePurgeReason, "unlinked"> }
  | { kind: "inconclusive"; failureKind: string; failureCode?: string };

/**
 * The decision logic (see the module comment): one fresh token + `channels.list?mine=true`
 * through the existing discovery; only Google-confirmed failures or a missing credential purge.
 * The credential is used only inside the credential store's wrapper and never returned.
 */
export async function checkYouTubeAuthorization(
  ctx: ActionCtx,
  target: { orgId: Id<"organizations">; connectionId: Id<"connections">; externalId: string },
): Promise<AuthorizationOutcome> {
  try {
    const owned = await withConnectionCredential(
      ctx,
      target.connectionId,
      async (credential, binding) => {
        if (binding.orgId !== target.orgId || binding.provider !== "youtube") {
          throw new Error("Connection binding mismatch");
        }
        const page = await providerRegistry()
          .socialDiscovery("youtube")
          .listAccounts({ credential, attempt: 1 }, {});
        return page.items.some((item) => item.externalId === target.externalId);
      },
      { allowNeedsReauth: true },
    );
    return owned ? { kind: "authorized" } : { kind: "confirmed", reason: "channel_not_authorized" };
  } catch (error) {
    if (error instanceof CredentialUnavailableError) {
      // "inactive" with allowNeedsReauth = the connection is "revoked" (an in-app disconnect).
      return {
        kind: "confirmed",
        reason: error.reason === "inactive" ? "disconnected" : "credential_missing",
      };
    }
    if (isProviderError(error)) {
      if (error.kind === "auth" && error.providerCode === "invalid_grant") {
        return { kind: "confirmed", reason: "authorization_invalid" };
      }
      if (error.kind === "permission" && error.providerCode === "account_mismatch") {
        return { kind: "confirmed", reason: "channel_not_authorized" };
      }
      return {
        kind: "inconclusive",
        failureKind: error.kind,
        ...(error.providerCode !== undefined && AUDIT_CODE_PATTERN.test(error.providerCode)
          ? { failureCode: error.providerCode }
          : {}),
      };
    }
    return {
      kind: "inconclusive",
      failureKind: "internal",
    };
  }
}

/** Daily check of one channel (scheduled by planYouTubeAuthorizationChecks). */
export const verifyYouTubeAuthorization = internalAction({
  args: {
    orgId: v.id("organizations"),
    socialAccountId: v.id("socialAccounts"),
    staleBefore: v.number(),
  },
  returns: v.union(
    v.literal("skipped"),
    v.literal("authorized"),
    v.literal("purge"),
    v.literal("inconclusive"),
  ),
  handler: async (ctx, args) => {
    const target = await ctx.runQuery(
      internal.connections.youtubeRetention.authorizationTarget,
      args,
    );
    if (target === null) return "skipped" as const;
    const outcome = await checkYouTubeAuthorization(ctx, { orgId: args.orgId, ...target });
    if (outcome.kind === "confirmed") {
      await ctx.runMutation(internal.connections.youtubeRetention.purgeYouTubeAccount, {
        orgId: args.orgId,
        socialAccountId: args.socialAccountId,
        start: { reason: outcome.reason, staleBefore: args.staleBefore },
      });
      return "purge" as const;
    }
    if (outcome.kind === "authorized") {
      await ctx.runMutation(internal.connections.youtubeRetention.recordAuthorizedCheck, {
        orgId: args.orgId,
        socialAccountId: args.socialAccountId,
        connectionId: target.connectionId,
      });
      return "authorized" as const;
    }
    await ctx.runMutation(internal.connections.youtubeRetention.recordInconclusiveCheck, {
      orgId: args.orgId,
      socialAccountId: args.socialAccountId,
      failureKind: outcome.failureKind,
      ...(outcome.failureCode !== undefined ? { failureCode: outcome.failureCode } : {}),
    });
    return "inconclusive" as const;
  },
});

/** The authorization was confirmed: lastSeenAt restarts the 25 days (same channel, same link). */
export const recordAuthorizedCheck = internalMutation({
  args: {
    orgId: v.id("organizations"),
    socialAccountId: v.id("socialAccounts"),
    connectionId: v.id("connections"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.socialAccountId);
    if (
      account === null ||
      account.orgId !== args.orgId ||
      account.platform !== "youtube" ||
      account.status !== "active" ||
      account.connectionId !== args.connectionId
    ) {
      return null;
    }
    const now = Date.now();
    await ctx.db.patch(account._id, { lastSeenAt: now, updatedAt: now });
    return null;
  },
});

const INCONCLUSIVE_KINDS: ReadonlySet<string> = new Set([...PROVIDER_ERROR_KINDS, "internal"]);

/** Audits an inconclusive check (kind and an allowlisted code only); the data is kept. */
export const recordInconclusiveCheck = internalMutation({
  args: {
    orgId: v.id("organizations"),
    socialAccountId: v.id("socialAccounts"),
    failureKind: v.string(),
    failureCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.socialAccountId);
    if (account === null || account.orgId !== args.orgId || account.platform !== "youtube") {
      return null;
    }
    const kind = INCONCLUSIVE_KINDS.has(args.failureKind) ? args.failureKind : "internal";
    await writeAudit(ctx.db, await systemActor(ctx.db, account.orgId), {
      action: AUDIT_ACTIONS.socialAccountAuthorizationInconclusive,
      targetType: "socialAccount",
      targetId: account._id,
      changes: {
        failureKind: { from: null, to: kind },
        ...(args.failureCode !== undefined && AUDIT_CODE_PATTERN.test(args.failureCode)
          ? { failureCode: { from: null, to: args.failureCode } }
          : {}),
      },
    });
    return null;
  },
});
