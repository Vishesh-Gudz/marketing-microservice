import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type DatabaseReader } from "../_generated/server";
import { connectionProviderValidator } from "../domain/validators";
import { AUDIT_ACTIONS, writeAudit } from "../lib/audit";
import { apiError } from "../lib/errors";
import { INSTAGRAM_MESSAGING_SCOPE } from "../providers/instagram/config";
import { MAX_PENDING_STATES_PER_ORG, OAUTH_STATE_TTL_MS } from "./config";
import { sanitizeOAuthDiagnostics } from "./oauthDiagnostics";
import { isAllowedReturnUrl } from "./returnUrls";

/**
 * OAuth state lifecycle. INTERNAL-ONLY table. States are:
 * - created by an authenticated tenant (via v1/connections:beginConnect),
 * - looked up ONLY by the SHA-256 hash of the nonce (the raw nonce is never stored),
 * - single-use (pending -> consumed atomically) and valid for 10 minutes.
 */

/** Fixed, non-sensitive failure codes surfaced to the returnUrl. */
export const CALLBACK_ERROR_CODES = [
  "access_denied",
  "invalid_state",
  "expired_state",
  "exchange_failed",
  "identity_mismatch",
  "discovery_failed",
  "internal",
] as const;
export type CallbackErrorCode = (typeof CALLBACK_ERROR_CODES)[number];
export const callbackErrorValidator = v.union(
  ...CALLBACK_ERROR_CODES.map((code) => v.literal(code)),
);

async function activeApp(db: DatabaseReader, issuer: string) {
  const app = await db
    .query("integrationApps")
    .withIndex("by_issuer", (q) => q.eq("issuer", issuer))
    .unique();
  return app !== null && app.status === "active" ? app : null;
}

/**
 * Creates a pending state. Called by the tenant-resolved beginConnect action.
 *
 * ADR 0017: returns the scopes to request in addition to the provider's own. Instagram asks for
 * the messaging permission when `instagramMessaging` is requested, and also on every reconnect
 * of a connection already granted it, so a reconnect never drops it silently.
 */
export const create = internalMutation({
  args: {
    orgId: v.id("organizations"),
    issuer: v.string(),
    subject: v.string(),
    provider: connectionProviderValidator,
    nonceHash: v.string(),
    codeVerifier: v.optional(v.string()),
    // S2: required; the claim code is returned only to this URL.
    returnUrl: v.string(),
    reconnectConnectionId: v.optional(v.string()),
    instagramMessaging: v.optional(v.boolean()),
  },
  returns: v.object({ expiresAt: v.number(), extraScopes: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const app = await activeApp(ctx.db, args.issuer);
    if (app === null)
      throw apiError("APP_DISABLED", "The integration app for this token issuer is disabled.");

    if (!isAllowedReturnUrl(args.returnUrl, app.allowedReturnUrls)) {
      throw apiError("INVALID_ARGUMENT", "returnUrl is not allowed for this application.", {
        field: "returnUrl",
      });
    }

    if (args.instagramMessaging === true && args.provider !== "instagram") {
      throw apiError("INVALID_ARGUMENT", "Direct messages are only available for Instagram.", {
        field: "instagramMessaging",
      });
    }
    let reconnectConnectionId: Id<"connections"> | undefined;
    let keepsMessaging = false;
    if (args.reconnectConnectionId !== undefined) {
      const id = ctx.db.normalizeId("connections", args.reconnectConnectionId);
      const target = id === null ? null : await ctx.db.get(id);
      if (target === null || target.orgId !== args.orgId || target.provider !== args.provider) {
        throw apiError("NOT_FOUND", "No connections record with this id.", {
          table: "connections",
        });
      }
      reconnectConnectionId = target._id;
      keepsMessaging =
        target.provider === "instagram" && target.grantedScopes.includes(INSTAGRAM_MESSAGING_SCOPE);
    }
    const extraScopes =
      args.instagramMessaging === true || keepsMessaging ? [INSTAGRAM_MESSAGING_SCOPE] : [];

    const recent = await ctx.db
      .query("oauthStates")
      .withIndex("by_org_created", (q) =>
        q.eq("orgId", args.orgId).gt("createdAt", now - OAUTH_STATE_TTL_MS),
      )
      .collect();
    const pending = recent.filter((s) => s.status === "pending" && s.expiresAt > now).length;
    if (pending >= MAX_PENDING_STATES_PER_ORG) {
      throw apiError(
        "RATE_LIMITED",
        "Too many connection attempts in progress. Try again shortly.",
      );
    }

    const expiresAt = now + OAUTH_STATE_TTL_MS;
    const stateId = await ctx.db.insert("oauthStates", {
      orgId: args.orgId,
      provider: args.provider,
      nonceHash: args.nonceHash,
      ...(args.codeVerifier !== undefined ? { codeVerifier: args.codeVerifier } : {}),
      issuer: args.issuer,
      initiatedBySubject: args.subject,
      returnUrl: args.returnUrl,
      ...(reconnectConnectionId !== undefined ? { reconnectConnectionId } : {}),
      status: "pending",
      expiresAt,
      createdAt: now,
    });
    await writeAudit(
      ctx.db,
      { orgId: args.orgId, issuer: args.issuer, subject: args.subject },
      {
        action: AUDIT_ACTIONS.connectionOAuthStarted,
        targetType: "oauthState",
        targetId: stateId,
        changes: {
          provider: { from: null, to: args.provider },
          ...(extraScopes.length > 0 ? { messagingScope: { from: null, to: true } } : {}),
        },
      },
    );
    return { expiresAt, extraScopes };
  },
});

/**
 * Atomically consumes a state by nonce hash. Unknown, replayed, expired, or
 * orphaned (app disabled / org gone) states are rejected. Returns the bound
 * org, provider and PKCE verifier for the callback flow.
 */
export const consume = internalMutation({
  args: { nonceHash: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      stateId: v.id("oauthStates"),
      orgId: v.id("organizations"),
      provider: connectionProviderValidator,
      initiatedBySubject: v.string(),
      codeVerifier: v.optional(v.string()),
      returnUrl: v.optional(v.string()),
    }),
    v.object({
      ok: v.literal(false),
      code: v.union(v.literal("invalid_state"), v.literal("expired_state")),
      returnUrl: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { nonceHash }) => {
    const state = await ctx.db
      .query("oauthStates")
      .withIndex("by_nonce_hash", (q) => q.eq("nonceHash", nonceHash))
      .unique();
    if (state === null || state.status !== "pending") {
      return { ok: false as const, code: "invalid_state" as const };
    }
    const returnUrl = state.returnUrl !== undefined ? { returnUrl: state.returnUrl } : {};
    const now = Date.now();
    const actor = { orgId: state.orgId, issuer: state.issuer, subject: state.initiatedBySubject };

    const reject = async (code: "invalid_state" | "expired_state") => {
      await ctx.db.patch(state._id, { status: "failed", failureCode: code, consumedAt: now });
      await writeAudit(ctx.db, actor, {
        action: AUDIT_ACTIONS.connectionOAuthFailed,
        targetType: "oauthState",
        targetId: state._id,
        changes: { reason: { from: null, to: code } },
      });
      return { ok: false as const, code, ...returnUrl };
    };

    if (state.expiresAt <= now) return await reject("expired_state");
    if (
      (await activeApp(ctx.db, state.issuer)) === null ||
      (await ctx.db.get(state.orgId)) === null
    ) {
      return await reject("invalid_state");
    }

    await ctx.db.patch(state._id, { status: "consumed", consumedAt: now });
    return {
      ok: true as const,
      stateId: state._id,
      orgId: state.orgId,
      provider: state.provider,
      initiatedBySubject: state.initiatedBySubject,
      ...(state.codeVerifier !== undefined ? { codeVerifier: state.codeVerifier } : {}),
      ...returnUrl,
    };
  },
});

/**
 * Marks a consumed state failed (denied consent, exchange failure, ...). Optional
 * `diagnostics` (D28b) are reduced to the allowlisted audit fields; anything else
 * is dropped (see oauthDiagnostics.ts).
 */
export const fail = internalMutation({
  args: {
    stateId: v.id("oauthStates"),
    code: callbackErrorValidator,
    diagnostics: v.optional(
      v.object({ kind: v.optional(v.string()), providerCode: v.optional(v.string()) }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { stateId, code, diagnostics }) => {
    const state = await ctx.db.get(stateId);
    if (state === null) return null;
    await ctx.db.patch(stateId, { status: "failed", failureCode: code });
    await writeAudit(
      ctx.db,
      { orgId: state.orgId, issuer: state.issuer, subject: state.initiatedBySubject },
      {
        action: AUDIT_ACTIONS.connectionOAuthFailed,
        targetType: "oauthState",
        targetId: stateId,
        changes: { ...sanitizeOAuthDiagnostics(diagnostics), reason: { from: null, to: code } },
      },
    );
    return null;
  },
});
