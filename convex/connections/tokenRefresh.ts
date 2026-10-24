import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type ActionCtx } from "../_generated/server";
import { isOAuthConnectionProvider, type ConnectionProvider } from "../domain/types";
import { SYSTEM_TOKEN_REFRESH_SUBJECT } from "../lib/audit";
import { isProviderError } from "../providers/errors";
import { REFRESH_WINDOW_MS } from "../providers/instagram/config";
import { oauthClientConfig, providerRegistry } from "./config";
import {
  CredentialUnavailableError,
  encryptCredential,
  withConnectionCredential,
} from "./credentialStore";

/**
 * Daily long-lived token refresh (Phase 10, I-D8/I-D9; convex/crons.ts). Instagram Login
 * tokens last ~60 days and can be refreshed once at least 24 h old [doc]; an unrefreshed
 * token expires and the health sweep then moves the connection to needs_reauth.
 *
 * - Candidates: ACTIVE connections of a refreshing provider whose token expires within
 *   REFRESH_WINDOW_MS, read through the approved global `by_status_expires` index
 *   (bounded batch). Meta and Google are NOT refreshed here (Meta user tokens cannot be
 *   extended; Google mints access tokens per call from its refresh token).
 * - Plaintext exists only inside the action (withConnectionCredential -> OAuthSpec.refresh
 *   -> encryptCredential). The new ciphertext replaces the old one atomically with the
 *   expiry and credential generation (credentialStore.replaceRefreshedCredential), and only
 *   if nothing reconnected or disconnected the connection meanwhile.
 * - Fails closed: an unusable credential or an `auth` refresh failure moves the connection
 *   to needs_reauth (audited). Config problems and transient failures only record a
 *   sanitized error (retried the next day, before expiry). Nothing is logged; no token,
 *   URL or payload reaches an error, audit entry or the database.
 */

export const TOKEN_REFRESH_PROVIDERS: readonly ConnectionProvider[] = ["instagram"];
export const REFRESH_BATCH = 25;

const outcomeValidator = v.object({
  refreshed: v.number(),
  superseded: v.number(),
  skipped: v.number(),
  reauth: v.number(),
  failed: v.number(),
});

/** Active connections of refreshing providers whose token expires within the window. */
export const refreshCandidates = internalQuery({
  args: { now: v.number() },
  returns: v.array(v.id("connections")),
  handler: async (ctx, { now }) => {
    const rows = await ctx.db
      .query("connections")
      .withIndex("by_status_expires", (q) =>
        q
          .eq("status", "active")
          .gte("tokenExpiresAt", now)
          .lt("tokenExpiresAt", now + REFRESH_WINDOW_MS),
      )
      .filter((q) =>
        q.or(...TOKEN_REFRESH_PROVIDERS.map((provider) => q.eq(q.field("provider"), provider))),
      )
      .take(REFRESH_BATCH);
    return rows.map((row) => row._id);
  },
});

type Outcome = "refreshed" | "superseded" | "skipped" | "reauth" | "failed";

class RefreshIdentityError extends Error {
  constructor() {
    super("Refreshed credential belongs to a different identity");
    this.name = "RefreshIdentityError";
  }
}

async function refreshOne(ctx: ActionCtx, connectionId: Id<"connections">): Promise<Outcome> {
  try {
    return await withConnectionCredential(ctx, connectionId, async (credential, binding) => {
      const registry = providerRegistry();
      if (
        !isOAuthConnectionProvider(binding.provider) ||
        !TOKEN_REFRESH_PROVIDERS.includes(binding.provider) ||
        !registry.hasOAuth(binding.provider)
      ) {
        return "skipped";
      }
      const spec = registry.oauth(binding.provider);
      if (spec.refresh === undefined) return "skipped";
      const grant = await spec.refresh(credential, oauthClientConfig(binding.provider), Date.now());
      if (grant.identity.externalUserId !== binding.externalUserId) {
        // A refresh never changes the identity; anything else is unusable.
        throw new RefreshIdentityError();
      }
      const encrypted = await encryptCredential(binding, grant.credential);
      const replaced = await ctx.runMutation(
        internal.connections.credentialStore.replaceRefreshedCredential,
        {
          connectionId,
          expectedCredentialVersion: binding.credentialVersion,
          ...(grant.expiresAt !== undefined ? { tokenExpiresAt: grant.expiresAt } : {}),
          encrypted,
          actorSubject: SYSTEM_TOKEN_REFRESH_SUBJECT,
        },
      );
      return replaced ? "refreshed" : "superseded";
    });
  } catch (error) {
    if (error instanceof CredentialUnavailableError) return "skipped";
    const tooNew = isProviderError(error) && error.providerCode === "token_refresh:token_too_new";
    if (tooNew) return "skipped";
    const reauth =
      error instanceof RefreshIdentityError || (isProviderError(error) && error.kind === "auth");
    if (reauth) {
      await ctx.runMutation(internal.connections.lifecycle.markNeedsReauth, {
        connectionId,
        reason: "token_refresh_failed",
        actorSubject: SYSTEM_TOKEN_REFRESH_SUBJECT,
      });
      return "reauth";
    }
    await ctx.runMutation(internal.connections.assets.recordConnectionError, {
      connectionId,
      kind: isProviderError(error) ? error.kind : "internal",
      message: "Token refresh failed",
    });
    return "failed";
  }
}

export const refreshExpiringTokens = internalAction({
  args: {},
  returns: outcomeValidator,
  handler: async (ctx) => {
    const ids: Id<"connections">[] = await ctx.runQuery(
      internal.connections.tokenRefresh.refreshCandidates,
      { now: Date.now() },
    );
    const counts = { refreshed: 0, superseded: 0, skipped: 0, reauth: 0, failed: 0 };
    for (const connectionId of ids) counts[await refreshOne(ctx, connectionId)]++;
    return counts;
  },
});
