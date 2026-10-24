import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type DatabaseReader,
} from "../_generated/server";
import { deleteCredential, withConnectionCredential } from "../connections/credentialStore";
import { AUDIT_ACTIONS, SYSTEM_WHATSAPP_OFFBOARDING_SUBJECT, writeAudit } from "../lib/audit";
import {
  MAX_OFFBOARDING_ATTEMPTS,
  OFFBOARDING_CLAIM_MS,
  OFFBOARDING_RETRY_DELAYS_MS,
  requireUserSubject,
  signupAppConfig,
} from "./config";
import { isSuccess, unsubscribeApp } from "./graph";
import { disconnectNumberRow } from "./phoneNumbers";
import { failureReason, parseCredential, tokenRefused } from "./signup";

/**
 * Disconnecting a WhatsApp Business Account (ADR 0014, B4).
 *
 * 1. `beginDisconnect`, ONE transaction, run with the signed-in admin's verified identity: every
 *    active number of the account stops routing (from this commit on, deliveries for it are
 *    acknowledged and dropped; history is kept), the connection is revoked (nothing may use the
 *    token any more) and the account is disconnected with its Meta cleanup `pending`. The
 *    credential stays: the cleanup needs the token.
 * 2. The Meta cleanup (`runCleanup`), one attempt at a time (`claimCleanup`): unless another org
 *    or an operator-managed number still uses the WABA (then it is skipped: unsubscribing would
 *    cut their webhooks too, our app being shared), our app is unsubscribed from the WABA's
 *    webhooks with the stored token. A failure is retried on a schedule
 *    (OFFBOARDING_RETRY_DELAYS_MS); when the cleanup ends, done or given up, the credential is
 *    deleted in the same transaction (`recordCleanupResult`).
 *
 * The token is never revoked at Meta (Meta documents revocation for system users, not for
 * Embedded Signup business tokens) and numbers are never deregistered (both decided for B4).
 * While a cleanup is pending, no org can connect the WABA (accounts.ts recordConnection).
 * Late deliveries for the numbers are dropped at ingest; events accepted before the disconnect
 * are still applied (they were received while the number was routed to this org).
 */

export type CleanupResult =
  "unsubscribed" | "skipped_shared" | "token_invalid" | "credential_missing";

const cleanupResultValidator = v.union(
  v.literal("unsubscribed"),
  v.literal("skipped_shared"),
  v.literal("token_invalid"),
  v.literal("credential_missing"),
);

const outcomeValidator = v.union(
  v.object({ kind: v.literal("done"), result: cleanupResultValidator }),
  v.object({ kind: v.literal("failed"), reason: v.string() }),
);
type Outcome = { kind: "done"; result: CleanupResult } | { kind: "failed"; reason: string };

const cleanupStatusValidator = v.union(
  v.literal("pending"),
  v.literal("done"),
  v.literal("failed"),
);

type Offboarding = NonNullable<Doc<"whatsappBusinessAccounts">["offboarding"]>;

/** The cleanup record without the transient fields (claim, next attempt). */
function settledRecord(o: Offboarding): Offboarding {
  return { status: o.status, attempts: o.attempts, startedAt: o.startedAt };
}

/**
 * Whether the WABA is still in use after this account's disconnect: another org's active
 * account (approved global index whatsappBusinessAccounts.by_waba_status), or any active number
 * on it in any org, e.g. an operator-managed one (approved global index
 * whatsappPhoneNumbers.by_waba_status). Rows are only counted.
 */
async function wabaStillUsed(db: DatabaseReader, wabaId: string): Promise<boolean> {
  const accounts = await db
    .query("whatsappBusinessAccounts")
    .withIndex("by_waba_status", (q) => q.eq("wabaId", wabaId).eq("status", "active"))
    .take(1);
  if (accounts.length > 0) return true;
  const numbers = await db
    .query("whatsappPhoneNumbers")
    .withIndex("by_waba_status", (q) => q.eq("wabaId", wabaId).eq("status", "active"))
    .take(1);
  return numbers.length > 0;
}

/** Step 1 (see the module comment). Null: no such account in this org. Idempotent. */
export const beginDisconnect = internalMutation({
  args: {
    orgId: v.id("organizations"),
    /** The signed-in admin's verified JWT issuer and subject (from the action's tenant). */
    issuer: v.string(),
    actorSubject: v.string(),
    /** Untrusted (from the browser): only this org's account is found. */
    accountId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      accountId: v.id("whatsappBusinessAccounts"),
      alreadyDisconnected: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    requireUserSubject(args.actorSubject);
    const id = ctx.db.normalizeId("whatsappBusinessAccounts", args.accountId);
    const account = id === null ? null : await ctx.db.get(id);
    if (account === null || account.orgId !== args.orgId) return null;
    if (account.status === "disconnected") {
      return { accountId: account._id, alreadyDisconnected: true };
    }
    const actor = { orgId: args.orgId, issuer: args.issuer, subject: args.actorSubject };
    const now = Date.now();

    const numbers = await ctx.db
      .query("whatsappPhoneNumbers")
      .withIndex("by_org_account", (q) => q.eq("orgId", args.orgId).eq("accountId", account._id))
      .collect();
    const routed = numbers.filter((number) => number.status === "active");
    for (const number of routed) await disconnectNumberRow(ctx.db, number, actor, now);

    const connection = await ctx.db.get(account.connectionId);
    if (connection !== null && connection.orgId === args.orgId && connection.status !== "revoked") {
      await ctx.db.patch(connection._id, { status: "revoked", revokedAt: now, updatedAt: now });
      await writeAudit(ctx.db, actor, {
        action: AUDIT_ACTIONS.connectionDisconnected,
        targetType: "connection",
        targetId: connection._id,
        changes: {
          status: { from: connection.status, to: "revoked" },
          routedNumbers: { from: routed.length, to: 0 },
        },
      });
    }

    await ctx.db.patch(account._id, {
      status: "disconnected",
      disconnectedAt: now,
      disconnectedBySubject: args.actorSubject,
      setupError: undefined,
      offboarding: { status: "pending", attempts: 0, startedAt: now },
      updatedAt: now,
    });
    return { accountId: account._id, alreadyDisconnected: false };
  },
});

/**
 * Claims the next cleanup attempt; the ONLY way to get one. In one transaction (concurrent
 * claims are serialized; at most one wins): refused unless the cleanup is pending and no other
 * attempt holds it. A won claim counts the attempt and reports whether the WABA is still used.
 */
export const claimCleanup = internalMutation({
  args: { orgId: v.id("organizations"), accountId: v.id("whatsappBusinessAccounts") },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      connectionId: v.id("connections"),
      wabaId: v.string(),
      shared: v.boolean(),
    }),
    v.object({
      ok: v.literal(false),
      reason: v.union(v.literal("not_pending"), v.literal("in_progress")),
    }),
  ),
  handler: async (ctx, { orgId, accountId }) => {
    const account = await ctx.db.get(accountId);
    const offboarding = account?.offboarding;
    if (
      account === null ||
      account.orgId !== orgId ||
      account.status !== "disconnected" ||
      offboarding?.status !== "pending"
    ) {
      return { ok: false as const, reason: "not_pending" as const };
    }
    const now = Date.now();
    if ((offboarding.claimedUntil ?? 0) > now) {
      return { ok: false as const, reason: "in_progress" as const };
    }
    await ctx.db.patch(account._id, {
      offboarding: {
        ...settledRecord(offboarding),
        ...(offboarding.lastFailure !== undefined ? { lastFailure: offboarding.lastFailure } : {}),
        attempts: offboarding.attempts + 1,
        claimedUntil: now + OFFBOARDING_CLAIM_MS,
      },
      updatedAt: now,
    });
    return {
      ok: true as const,
      connectionId: account.connectionId,
      wabaId: account.wabaId,
      shared: await wabaStillUsed(ctx.db, account.wabaId),
    };
  },
});

/**
 * Records a claimed attempt. A failure before the last attempt schedules the next one (in this
 * transaction). Otherwise the cleanup ends, done or failed, and the credential is deleted here.
 */
export const recordCleanupResult = internalMutation({
  args: {
    orgId: v.id("organizations"),
    accountId: v.id("whatsappBusinessAccounts"),
    outcome: outcomeValidator,
    actorSubject: v.string(),
  },
  returns: v.union(v.null(), cleanupStatusValidator),
  handler: async (ctx, { orgId, accountId, outcome, actorSubject }) => {
    const account = await ctx.db.get(accountId);
    const offboarding = account?.offboarding;
    if (account === null || account.orgId !== orgId || offboarding?.status !== "pending") {
      return null;
    }
    const now = Date.now();
    if (outcome.kind === "failed" && offboarding.attempts < MAX_OFFBOARDING_ATTEMPTS) {
      const delay =
        OFFBOARDING_RETRY_DELAYS_MS[offboarding.attempts - 1] ??
        OFFBOARDING_RETRY_DELAYS_MS.at(-1)!;
      await ctx.db.patch(account._id, {
        offboarding: {
          ...settledRecord(offboarding),
          lastFailure: outcome.reason,
          nextAttemptAt: now + delay,
        },
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(delay, internal.whatsapp.offboarding.retryCleanup, {
        orgId,
        accountId,
      });
      return "pending";
    }

    // The cleanup ends: the credential goes, whatever Meta answered.
    const org = await ctx.db.get(orgId);
    const actor = { orgId, issuer: org?.issuer ?? "", subject: actorSubject };
    if (await deleteCredential(ctx.db, orgId, account.connectionId)) {
      await writeAudit(ctx.db, actor, {
        action: AUDIT_ACTIONS.credentialDeleted,
        targetType: "connection",
        targetId: account.connectionId,
      });
    }
    if (outcome.kind === "done") {
      await ctx.db.patch(account._id, {
        ...(outcome.result === "unsubscribed" ? { subscribedAt: undefined } : {}),
        offboarding: {
          ...settledRecord(offboarding),
          status: "done",
          result: outcome.result,
          finishedAt: now,
        },
        updatedAt: now,
      });
      await writeAudit(ctx.db, actor, {
        action: AUDIT_ACTIONS.whatsappOffboardingCompleted,
        targetType: "whatsappBusinessAccount",
        targetId: account._id,
        changes: { result: { from: null, to: outcome.result } },
      });
      return "done";
    }
    await ctx.db.patch(account._id, {
      offboarding: {
        ...settledRecord(offboarding),
        status: "failed",
        lastFailure: outcome.reason,
        finishedAt: now,
      },
      updatedAt: now,
    });
    await writeAudit(ctx.db, actor, {
      action: AUDIT_ACTIONS.whatsappOffboardingFailed,
      targetType: "whatsappBusinessAccount",
      targetId: account._id,
      changes: { reason: { from: null, to: outcome.reason } },
    });
    return "failed";
  },
});

/** Unsubscribes with the stored token. Never throws for Meta failures. */
async function unsubscribe(
  ctx: ActionCtx,
  claim: { connectionId: Id<"connections">; wabaId: string },
): Promise<Outcome> {
  const app = signupAppConfig();
  if (app === null) return { kind: "failed", reason: "not_configured" };
  try {
    return await withConnectionCredential(
      ctx,
      claim.connectionId,
      async (credential): Promise<Outcome> => {
        const parsed = parseCredential(credential);
        if (parsed === null) return { kind: "done", result: "credential_missing" };
        const result = await unsubscribeApp(claim.wabaId, {
          accessToken: parsed.accessToken,
          appSecret: app.appSecret,
        });
        if (result.ok) {
          return isSuccess(result.body)
            ? { kind: "done", result: "unsubscribed" }
            : { kind: "failed", reason: "unexpected_response" };
        }
        // A refused token can unsubscribe nothing, now or later.
        if (tokenRefused(result.failure)) return { kind: "done", result: "token_invalid" };
        return { kind: "failed", reason: failureReason(result.failure) };
      },
      { allowRevoked: true },
    );
  } catch {
    // No stored credential (CredentialUnavailableError) or none readable: nothing to
    // unsubscribe with, now or later.
    return { kind: "done", result: "credential_missing" };
  }
}

/** Step 2 (see the module comment): one claimed attempt, recorded. */
export async function runCleanup(
  ctx: ActionCtx,
  orgId: Id<"organizations">,
  accountId: Id<"whatsappBusinessAccounts">,
  actorSubject: string,
): Promise<void> {
  const claim = await ctx.runMutation(internal.whatsapp.offboarding.claimCleanup, {
    orgId,
    accountId,
  });
  if (!claim.ok) return;
  const outcome: Outcome = claim.shared
    ? { kind: "done", result: "skipped_shared" }
    : await unsubscribe(ctx, claim);
  await ctx.runMutation(internal.whatsapp.offboarding.recordCleanupResult, {
    orgId,
    accountId,
    outcome,
    actorSubject,
  });
}

/** A scheduled retry (recordCleanupResult schedules it after a failed attempt). */
export const retryCleanup = internalAction({
  args: { orgId: v.id("organizations"), accountId: v.id("whatsappBusinessAccounts") },
  returns: v.null(),
  handler: async (ctx, { orgId, accountId }) => {
    await runCleanup(ctx, orgId, accountId, SYSTEM_WHATSAPP_OFFBOARDING_SUBJECT);
    return null;
  },
});

/** Where a disconnected account's cleanup stands (for the disconnect result). */
export const cleanupOf = internalQuery({
  args: { orgId: v.id("organizations"), accountId: v.id("whatsappBusinessAccounts") },
  returns: v.union(
    v.null(),
    v.object({ status: cleanupStatusValidator, nextAttemptAt: v.optional(v.number()) }),
  ),
  handler: async (ctx, { orgId, accountId }) => {
    const account = await ctx.db.get(accountId);
    const offboarding = account?.offboarding;
    if (account === null || account.orgId !== orgId || offboarding === undefined) return null;
    return {
      status: offboarding.status,
      ...(offboarding.nextAttemptAt !== undefined
        ? { nextAttemptAt: offboarding.nextAttemptAt }
        : {}),
    };
  },
});

/**
 * A setup call subscribed the WABA, but the account was disconnected meanwhile (its cleanup
 * may already have unsubscribed): whether to undo that subscription with the same token.
 * Never when the WABA is still used.
 */
export const lateSubscribeUndo = internalQuery({
  args: { orgId: v.id("organizations"), accountId: v.id("whatsappBusinessAccounts") },
  returns: v.union(v.null(), v.object({ wabaId: v.string() })),
  handler: async (ctx, { orgId, accountId }) => {
    const account = await ctx.db.get(accountId);
    if (account === null || account.orgId !== orgId || account.status !== "disconnected") {
      return null;
    }
    return (await wabaStillUsed(ctx.db, account.wabaId)) ? null : { wabaId: account.wabaId };
  },
});
