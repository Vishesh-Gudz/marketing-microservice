import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { sha256Base64Url } from "../lib/crypto";
import { isProviderError } from "../providers/errors";
import type { ProviderAdAccount } from "../providers/types";
import {
  DISCOVERY_MAX_PAGES,
  oauthClientConfig,
  oauthRedirectUri,
  providerRegistry,
} from "./config";
import { encryptCredential, withConnectionCredential } from "./credentialStore";
import type { CallbackErrorCode } from "./oauthState";
import { withResultParams } from "./returnUrls";

/**
 * OAuth callback and discovery flows (ACTIONS: the only place plaintext
 * credentials exist). The callback is unauthenticated; the single-use state
 * nonce is its only capability, and the org/initiator come from that stored
 * state. Providers and OAuth specs stay tenant-free.
 */

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function htmlPage(title: string, message: string): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`;
  return new Response(body, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}

type Outcome =
  | { status: "connected"; connectionId: string; warning?: "discovery_failed" }
  | { status: "error"; error: CallbackErrorCode };

/** Redirects to the (already allow-listed) return URL, or shows a static page. */
function finish(returnUrl: string | undefined, outcome: Outcome): Response {
  if (returnUrl !== undefined) {
    const params: Record<string, string> =
      outcome.status === "connected"
        ? {
            status: "connected",
            connection: outcome.connectionId,
            ...(outcome.warning ? { warning: outcome.warning } : {}),
          }
        : { status: "error", error: outcome.error };
    return new Response(null, {
      status: 302,
      headers: { ...SECURITY_HEADERS, Location: withResultParams(returnUrl, params) },
    });
  }
  return outcome.status === "connected"
    ? htmlPage("Connection complete", "You can close this window.")
    : htmlPage("Connection failed", "The connection could not be completed. Please try again.");
}

/** Sanitized error for storage: provider error kind + generic message; never payloads. */
function sanitize(error: unknown): { kind: string; message: string } {
  if (isProviderError(error)) return { kind: error.kind, message: "The platform request failed" };
  return { kind: "internal", message: "Unexpected error" };
}

/** Lists every account the connection can see (bounded) and stores them. */
export async function discoverAssets(
  ctx: ActionCtx,
  connectionId: Id<"connections">,
  actorSubject: string,
): Promise<number> {
  const records = await withConnectionCredential(
    ctx,
    connectionId,
    async (credential, connection) => {
      const provider = providerRegistry().ads(connection.provider);
      const found: ProviderAdAccount[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < DISCOVERY_MAX_PAGES; page++) {
        // Tenant-free provider call: only the credential and the attempt number.
        const result = await provider.listAccounts(
          { credential, attempt: 1 },
          cursor ? { cursor } : {},
        );
        found.push(...result.items);
        if (result.nextCursor === undefined) break;
        cursor = result.nextCursor;
      }
      return found;
    },
  );
  return await ctx.runMutation(internal.connections.assets.storeDiscoveredAssets, {
    connectionId,
    records,
    actorSubject,
  });
}

/** GET /oauth/callback */
export async function handleOAuthCallback(ctx: ActionCtx, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  if (!state || state.length > 256)
    return finish(undefined, { status: "error", error: "invalid_state" });

  const consumed = await ctx.runMutation(internal.connections.oauthState.consume, {
    nonceHash: await sha256Base64Url(state),
  });
  if (!consumed.ok) return finish(consumed.returnUrl, { status: "error", error: consumed.code });

  const fail = async (error: CallbackErrorCode) => {
    await ctx.runMutation(internal.connections.oauthState.fail, {
      stateId: consumed.stateId,
      code: error,
    });
    return finish(consumed.returnUrl, { status: "error", error });
  };

  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") !== null || !code) return await fail("access_denied");

  const spec = providerRegistry().oauth(consumed.provider);
  let grant;
  try {
    grant = await spec.exchangeCode({
      code,
      redirectUri: oauthRedirectUri(),
      ...(consumed.codeVerifier !== undefined ? { codeVerifier: consumed.codeVerifier } : {}),
      config: oauthClientConfig(consumed.provider),
      now: Date.now(),
    });
  } catch {
    return await fail("exchange_failed");
  }

  let encrypted;
  try {
    encrypted = await encryptCredential(
      {
        orgId: consumed.orgId,
        provider: consumed.provider,
        externalUserId: grant.identity.externalUserId,
      },
      grant.credential,
    );
  } catch {
    return await fail("internal");
  }

  const stored = await ctx.runMutation(
    internal.connections.credentialStore.upsertConnectionWithCredential,
    {
      stateId: consumed.stateId,
      identity: {
        externalUserId: grant.identity.externalUserId,
        ...(grant.identity.displayName !== undefined
          ? { displayName: grant.identity.displayName }
          : {}),
      },
      grantedScopes: grant.grantedScopes,
      ...(grant.expiresAt !== undefined ? { tokenExpiresAt: grant.expiresAt } : {}),
      encrypted,
    },
  );
  if (!stored.ok)
    return await fail(
      stored.reason === "identity_mismatch" ? "identity_mismatch" : "invalid_state",
    );

  try {
    await discoverAssets(ctx, stored.connectionId, consumed.initiatedBySubject);
  } catch (error) {
    await ctx.runMutation(internal.connections.assets.recordConnectionError, {
      connectionId: stored.connectionId,
      ...sanitize(error),
    });
    return finish(consumed.returnUrl, {
      status: "connected",
      connectionId: stored.connectionId,
      warning: "discovery_failed",
    });
  }
  return finish(consumed.returnUrl, { status: "connected", connectionId: stored.connectionId });
}

/** Re-runs discovery (scheduled by v1/connections:refreshAssets). */
export const runDiscovery = internalAction({
  args: { connectionId: v.id("connections"), actorSubject: v.string() },
  returns: v.null(),
  handler: async (ctx, { connectionId, actorSubject }) => {
    try {
      await discoverAssets(ctx, connectionId, actorSubject);
    } catch (error) {
      await ctx.runMutation(internal.connections.assets.recordConnectionError, {
        connectionId,
        ...sanitize(error),
      });
    }
    return null;
  },
});

/** Best-effort platform revocation, then ALWAYS deletes the stored credential. */
export const revokeAtPlatform = internalAction({
  args: { connectionId: v.id("connections"), actorSubject: v.string() },
  returns: v.null(),
  handler: async (ctx, { connectionId, actorSubject }) => {
    try {
      await withConnectionCredential(
        ctx,
        connectionId,
        async (credential, connection) => {
          const spec = providerRegistry().oauth(connection.provider);
          await spec.revoke?.(credential, oauthClientConfig(connection.provider));
        },
        { allowRevoked: true },
      );
    } catch {
      // Platform revocation is best effort; the local credential is deleted regardless.
    } finally {
      await ctx.runMutation(internal.connections.credentialStore.deleteForConnection, {
        connectionId,
        actorSubject,
      });
    }
    return null;
  },
});
