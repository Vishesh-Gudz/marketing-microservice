import { v, type Infer } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx } from "../../_generated/server";
import {
  CredentialUnavailableError,
  withConnectionCredential,
} from "../../connections/credentialStore";
import { markConnectionNeedsReauth } from "../../connections/lifecycle";
import { classifyInstagramFailure } from "../../providers/instagram/errors";
import {
  GRAPH_ORIGIN,
  INSTAGRAM_GRAPH_VERSION,
  INSTAGRAM_SUBSCRIBED_FIELDS,
  UNIFIED_GRAPH_ORIGIN,
  UNIFIED_GRAPH_VERSION,
  UNIFIED_SUBSCRIBED_FIELDS,
} from "../../providers/instagram/config";
import {
  isInstagramMessagingCredential,
  isInstagramUnifiedCredential,
} from "../../providers/instagram/credential";
import {
  RequestBudget,
  sendInstagram,
  type InstagramFailure,
} from "../../providers/instagram/transport";
import { enableMessaging, recordActionRequired, recordSubscribed } from "./accounts";
import { SUBSCRIBE_TIMEOUT_MS } from "./config";

/**
 * Turning Instagram messaging on (ADR 0017, IM3): the database step (`enable`, all checks of
 * accounts.ts `enableMessaging`), then the account's webhook subscription with its own token:
 * ONE request, `POST graph.instagram.com/v25.0/{account}/subscribed_apps` with the fixed field
 * list (transport caller "messaging"; the token only in `Authorization: Bearer`).
 *
 * - Accepted (`{"success": true}` [doc]): the account is `active` and subscribed.
 * - Anything else: `action_required` with a sanitized reason (`meta_<code>`, `http_<status>`,
 *   `network`, `timeout`, `unexpected_response`, `credential_unavailable`, …); it still holds
 *   the account and receives its customers' messages. A token Meta refuses (an `auth`
 *   failure) also moves the connection to `needs_reauth`. An admin retries (`retrySetup`).
 * - Each call is one attempt (`beginSetupAttempt`); its outcome is recorded only for that hold
 *   and attempt (`recordSubscriptionResult`), so a delayed answer is ignored once anything newer
 *   happened.
 * Nothing logs; no token, URL or Meta text is stored or returned.
 */

const tenantArgs = { orgId: v.id("organizations"), issuer: v.string(), subject: v.string() };

const refusalValidator = v.union(
  v.literal("not_found"),
  v.literal("not_linked"),
  v.literal("connection_inactive"),
  v.literal("scope_missing"),
  v.literal("in_use"),
  v.literal("purge_in_progress"),
);

/** The database step of an enable, by an untrusted social account id. */
export const enable = internalMutation({
  args: { ...tenantArgs, socialAccountId: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), accountId: v.id("instagramMessagingAccounts") }),
    v.object({ ok: v.literal(false), reason: refusalValidator }),
  ),
  handler: async (ctx, { socialAccountId, ...actor }) => {
    const id = ctx.db.normalizeId("socialAccounts", socialAccountId);
    if (id === null) return { ok: false as const, reason: "not_found" as const };
    const result = await enableMessaging(ctx.db, actor, id);
    return result.ok ? { ok: true as const, accountId: result.accountId } : result;
  },
});

const setupStateValidator = v.object({
  accountId: v.id("instagramMessagingAccounts"),
  status: v.union(v.literal("active"), v.literal("action_required")),
  setupReason: v.optional(v.string()),
});
export type SetupState = Infer<typeof setupStateValidator>;

function setupStateOf(account: Doc<"instagramMessagingAccounts">): SetupState {
  return {
    accountId: account._id,
    status: account.status === "action_required" ? "action_required" : "active",
    ...(account.status === "action_required" && account.setupError !== undefined
      ? { setupReason: account.setupError.reason }
      : {}),
  };
}

/** The setup state of an account of this org that still holds (not turned off). */
export const setupState = internalQuery({
  args: { orgId: v.id("organizations"), accountId: v.id("instagramMessagingAccounts") },
  returns: v.union(v.null(), setupStateValidator),
  handler: async (ctx, { orgId, accountId }) => {
    const account = await ctx.db.get(accountId);
    if (account === null || account.orgId !== orgId || account.status === "disabled") return null;
    return setupStateOf(account);
  },
});

/** Which hold and attempt a subscription call belongs to (see recordSubscriptionResult). */
const attemptValidator = v.object({ activatedAt: v.number(), attempt: v.number() });

/**
 * Starts a webhook-subscription attempt for an account of this org that still holds: the row's
 * `setupAttempt` goes up by one, in this transaction, before Meta is called. Returns the target
 * and the attempt, or `subscribed` when there is nothing to do; null when the account is not
 * this org's or no longer holds.
 */
export const beginSetupAttempt = internalMutation({
  args: { orgId: v.id("organizations"), accountId: v.string() },
  returns: v.union(
    v.null(),
    v.object({ subscribed: v.literal(true), state: setupStateValidator }),
    v.object({
      subscribed: v.literal(false),
      accountId: v.id("instagramMessagingAccounts"),
      connectionId: v.id("connections"),
      igAccountId: v.string(),
      ...attemptValidator.fields,
    }),
  ),
  handler: async (ctx, { orgId, accountId }) => {
    const id = ctx.db.normalizeId("instagramMessagingAccounts", accountId);
    const account = id === null ? null : await ctx.db.get(id);
    if (account === null || account.orgId !== orgId || account.status === "disabled") return null;
    if (account.status === "active" && account.subscribedAt !== undefined) {
      return { subscribed: true as const, state: setupStateOf(account) };
    }
    const attempt = (account.setupAttempt ?? 0) + 1;
    await ctx.db.patch(account._id, { setupAttempt: attempt, updatedAt: Date.now() });
    return {
      subscribed: false as const,
      accountId: account._id,
      connectionId: account.connectionId,
      igAccountId: account.igAccountId,
      activatedAt: account.activatedAt,
      attempt,
    };
  },
});

const outcomeValidator = v.union(
  v.object({
    kind: v.literal("subscribed"),
    /** The fields actually subscribed (Unified Login has its own list). Absent: Instagram Login's. */
    fields: v.optional(v.array(v.string())),
  }),
  v.object({
    kind: v.literal("failed"),
    reason: v.string(),
    tokenRefused: v.boolean(),
    /** The credential the refused call used (a reconnect since then replaced it). */
    credentialVersion: v.optional(v.number()),
  }),
);
type Outcome = Infer<typeof outcomeValidator>;

/**
 * Records a subscription call's outcome, but ONLY for the hold and attempt that made it: the row
 * must still hold (not `disabled`), on the same `activatedAt` (no turn-off and re-enable since)
 * and the same `setupAttempt` (no newer attempt started). Anything else is `stale` and changes
 * nothing, so a delayed answer never revives a turned-off account, never overwrites a newer
 * attempt and never moves a newer hold to `action_required`. A refused token moves the
 * connection to `needs_reauth` only while it still has the credential that was refused.
 */
export const recordSubscriptionResult = internalMutation({
  args: {
    ...tenantArgs,
    accountId: v.id("instagramMessagingAccounts"),
    connectionId: v.id("connections"),
    ...attemptValidator.fields,
    outcome: outcomeValidator,
  },
  returns: v.union(v.literal("applied"), v.literal("stale")),
  handler: async (ctx, { accountId, connectionId, activatedAt, attempt, outcome, ...actor }) => {
    const account = await ctx.db.get(accountId);
    if (
      account === null ||
      account.orgId !== actor.orgId ||
      account.status === "disabled" ||
      account.activatedAt !== activatedAt ||
      (account.setupAttempt ?? 0) !== attempt
    ) {
      return "stale" as const;
    }
    if (outcome.kind === "subscribed") {
      await recordSubscribed(
        ctx.db,
        actor,
        accountId,
        outcome.fields ?? INSTAGRAM_SUBSCRIBED_FIELDS.split(","),
      );
      return "applied" as const;
    }
    await recordActionRequired(ctx.db, actor, accountId, outcome.reason);
    const connection = await ctx.db.get(connectionId);
    if (
      outcome.tokenRefused &&
      connection !== null &&
      connection.orgId === actor.orgId &&
      connection.credentialVersion === outcome.credentialVersion
    ) {
      await markConnectionNeedsReauth(
        ctx.db,
        connectionId,
        "instagram_token_invalid",
        actor.subject,
      );
    }
    return "applied" as const;
  },
});

/** A sanitized reason code for a failed request (never a URL, body or Meta text). */
function failureReason(failure: InstagramFailure): string {
  switch (failure.type) {
    case "blocked":
      return "transport_blocked";
    case "budget_exceeded":
      return "request_budget_exceeded";
    case "network":
    case "timeout":
      return failure.type;
    case "invalid_json":
      return "unexpected_response";
    case "http":
      return failure.error?.code !== undefined
        ? `meta_${failure.error.code}`
        : `http_${failure.status}`;
  }
}

async function callSubscribe(
  ctx: ActionCtx,
  target: { connectionId: Id<"connections">; igAccountId: string },
): Promise<Outcome> {
  try {
    return await withConnectionCredential(ctx, target.connectionId, async (credential, binding) => {
      if (!isInstagramMessagingCredential(credential) || credential.userId !== target.igAccountId) {
        return { kind: "failed", reason: "credential_invalid", tokenRefused: false };
      }
      // [doc] Unified Login subscribes on graph.facebook.com with the system-user token and its
      // own field list; Instagram Login on graph.instagram.com, unchanged.
      const unified = isInstagramUnifiedCredential(credential);
      const fields = unified ? UNIFIED_SUBSCRIBED_FIELDS : INSTAGRAM_SUBSCRIBED_FIELDS;
      const url = new URL(
        unified
          ? `${UNIFIED_GRAPH_ORIGIN}/${UNIFIED_GRAPH_VERSION}/${target.igAccountId}/subscribed_apps`
          : `${GRAPH_ORIGIN}/${INSTAGRAM_GRAPH_VERSION}/${target.igAccountId}/subscribed_apps`,
      );
      url.searchParams.set("subscribed_fields", fields);
      const result = await sendInstagram(
        "messaging",
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential.accessToken}`,
            Accept: "application/json",
          },
        },
        { timeoutMs: SUBSCRIBE_TIMEOUT_MS, budget: new RequestBudget(1) },
      );
      if (result.ok) {
        const body = result.body as { success?: unknown } | null;
        return body !== null && typeof body === "object" && body.success === true
          ? { kind: "subscribed", ...(unified ? { fields: fields.split(",") } : {}) }
          : { kind: "failed", reason: "unexpected_response", tokenRefused: false };
      }
      return {
        kind: "failed",
        reason: failureReason(result.failure),
        tokenRefused: classifyInstagramFailure(result.failure).kind === "auth",
        credentialVersion: binding.credentialVersion,
      };
    });
  } catch (error) {
    if (error instanceof CredentialUnavailableError) {
      return { kind: "failed", reason: "credential_unavailable", tokenRefused: false };
    }
    throw error;
  }
}

type Tenant = { orgId: Id<"organizations">; issuer: string; subject: string };

/**
 * Subscribes the account unless it already is (as one attempt, see beginSetupAttempt), records
 * the outcome and returns the resulting setup state. Null when the account is not this org's
 * or no longer holds (turned off).
 */
export async function subscribeIfNeeded(
  ctx: ActionCtx,
  tenant: Tenant,
  accountId: string,
): Promise<SetupState | null> {
  const begun = await ctx.runMutation(internal.instagram.messaging.lifecycle.beginSetupAttempt, {
    orgId: tenant.orgId,
    accountId,
  });
  if (begun === null) return null;
  if (begun.subscribed) return begun.state;
  const outcome = await callSubscribe(ctx, begun);
  await ctx.runMutation(internal.instagram.messaging.lifecycle.recordSubscriptionResult, {
    orgId: tenant.orgId,
    issuer: tenant.issuer,
    subject: tenant.subject,
    accountId: begun.accountId,
    connectionId: begun.connectionId,
    activatedAt: begun.activatedAt,
    attempt: begun.attempt,
    outcome,
  });
  return await ctx.runQuery(internal.instagram.messaging.lifecycle.setupState, {
    orgId: tenant.orgId,
    accountId: begun.accountId,
  });
}
