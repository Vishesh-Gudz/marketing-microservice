import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import {
  isAdPlatform,
  isOAuthConnectionProvider,
  isSocialConnectionProvider,
} from "../domain/types";
import { randomToken, sha256Base64Url } from "../lib/crypto";
import { isProviderError } from "../providers/errors";
import type { ProviderDiscoveredSocialAccount } from "../providers/social/types";
import type { ProviderAdAccount } from "../providers/types";
import {
  DISCOVERY_MAX_PAGES,
  oauthClientConfig,
  oauthRedirectUri,
  providerRegistry,
} from "./config";
import {
  CredentialUnavailableError,
  encryptCredential,
  withConnectionCredential,
  type PlatformRevoke,
} from "./credentialStore";
import type { OAuthFailureDiagnostics } from "./oauthDiagnostics";
import type { CallbackErrorCode } from "./oauthState";
import { withResultParams } from "./returnUrls";

/**
 * OAuth callback and discovery flows (ACTIONS: the only place plaintext
 * credentials exist). The callback is unauthenticated; the single-use state
 * nonce is its only capability, and the org/initiator come from that stored
 * state. Providers and OAuth specs stay tenant-free.
 *
 * S2 (ownership): whoever completes the platform consent is not necessarily the user who
 * started it (a forwarded authorization link). The callback therefore never creates a
 * connection: it stores the encrypted grant and returns a one-time claim code to the return
 * URL. Only the initiating user, signed in to the initiating org, can claim it
 * (v1/connections:completeConnect), which creates the connection and runs discovery.
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

type Outcome = { status: "pending"; claim: string } | { status: "error"; error: CallbackErrorCode };

/**
 * Redirects to the (already allow-listed) return URL, or shows a static page. A pending grant
 * always has a return URL (storeGrant refuses states without one).
 */
function finish(returnUrl: string | undefined, outcome: Outcome): Response {
  if (returnUrl !== undefined) {
    const params: Record<string, string> =
      outcome.status === "pending"
        ? { status: "pending", claim: outcome.claim }
        : { status: "error", error: outcome.error };
    return new Response(null, {
      status: 302,
      headers: { ...SECURITY_HEADERS, Location: withResultParams(returnUrl, params) },
    });
  }
  return htmlPage("Connection failed", "The connection could not be completed. Please try again.");
}

/**
 * Sanitized error for storage: provider error kind + generic message; never payloads. The
 * platform code goes only to recordConnectionError, which keeps an allowlisted reason.
 */
function sanitize(error: unknown): { kind: string; message: string; providerCode?: string } {
  if (isProviderError(error)) {
    return {
      kind: error.kind,
      message: "The platform request failed",
      ...(error.providerCode !== undefined ? { providerCode: error.providerCode } : {}),
    };
  }
  return { kind: "internal", message: "Unexpected error" };
}

type Discovered =
  | { kind: "ads"; records: ProviderAdAccount[] }
  | { kind: "social"; records: ProviderDiscoveredSocialAccount[] };

/**
 * Lists every account the connection can see (bounded) and stores them. Ad connections
 * list ad accounts (discoveredAssets); social connections (Phase 10, Instagram Login) list
 * organic social accounts (discoveredSocialAccounts) through the SDK-free default-runtime
 * discovery: no Node hop, and never the ads provider.
 */
export async function discoverAssets(
  ctx: ActionCtx,
  connectionId: Id<"connections">,
  actorSubject: string,
): Promise<number> {
  const found = await withConnectionCredential(
    ctx,
    connectionId,
    async (credential, connection): Promise<Discovered> => {
      if (isSocialConnectionProvider(connection.provider)) {
        const discovery = providerRegistry().socialDiscovery(connection.provider);
        const accounts: ProviderDiscoveredSocialAccount[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < DISCOVERY_MAX_PAGES; page++) {
          const result = await discovery.listAccounts(
            { credential, attempt: 1 },
            cursor ? { cursor } : {},
          );
          accounts.push(...result.items);
          if (result.nextCursor === undefined) break;
          cursor = result.nextCursor;
        }
        return { kind: "social", records: accounts };
      }
      if (!isAdPlatform(connection.provider)) return { kind: "ads", records: [] };
      const provider = providerRegistry().ads(connection.provider);
      const records: ProviderAdAccount[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < DISCOVERY_MAX_PAGES; page++) {
        // Tenant-free provider call: only the credential and the attempt number.
        const result = await provider.listAccounts(
          { credential, attempt: 1 },
          cursor ? { cursor } : {},
        );
        records.push(...result.items);
        if (result.nextCursor === undefined) break;
        cursor = result.nextCursor;
      }
      return { kind: "ads", records };
    },
  );
  if (found.kind === "social") {
    return await ctx.runMutation(internal.connections.socialAssets.storeDiscoveredSocialAccounts, {
      connectionId,
      records: found.records,
      actorSubject,
    });
  }
  return await ctx.runMutation(internal.connections.assets.storeDiscoveredAssets, {
    connectionId,
    records: found.records,
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

  const fail = async (error: CallbackErrorCode, diagnostics?: OAuthFailureDiagnostics) => {
    await ctx.runMutation(internal.connections.oauthState.fail, {
      stateId: consumed.stateId,
      code: error,
      ...(diagnostics !== undefined ? { diagnostics } : {}),
    });
    return finish(consumed.returnUrl, { status: "error", error });
  };

  // S2: the grant can only be claimed from the return URL. A state without one (created before
  // returnUrl became required) is refused before anything is exchanged.
  if (consumed.returnUrl === undefined) return await fail("invalid_state");

  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") !== null || !code) return await fail("access_denied");

  // The same redirect URI as the authorization request (same provider, from the stored state).
  // If it cannot be built (an invalid override), nothing is sent to the platform.
  let redirectUri: string;
  try {
    redirectUri = oauthRedirectUri(consumed.provider);
  } catch {
    return await fail("internal");
  }

  const spec = providerRegistry().oauth(consumed.provider);
  let grant;
  try {
    grant = await spec.exchangeCode({
      code,
      redirectUri,
      ...(consumed.codeVerifier !== undefined ? { codeVerifier: consumed.codeVerifier } : {}),
      config: oauthClientConfig(consumed.provider),
      now: Date.now(),
    });
  } catch (error) {
    // D28b: only the error's kind and staged providerCode are passed on; the mutation
    // keeps allowlisted values only. Messages, URLs and payloads never leave here.
    return await fail(
      "exchange_failed",
      isProviderError(error)
        ? {
            kind: error.kind,
            ...(error.providerCode !== undefined ? { providerCode: error.providerCode } : {}),
          }
        : undefined,
    );
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

  // S2: the raw claim code travels only in the redirect to the allow-listed return URL; the
  // database keeps its SHA-256 hash.
  const claim = randomToken();
  const stored = await ctx.runMutation(internal.connections.credentialStore.storeGrant, {
    stateId: consumed.stateId,
    identity: {
      externalUserId: grant.identity.externalUserId,
      ...(grant.identity.displayName !== undefined
        ? { displayName: grant.identity.displayName }
        : {}),
      ...(grant.identity.scopedUserId !== undefined
        ? { scopedUserId: grant.identity.scopedUserId }
        : {}),
    },
    grantedScopes: grant.grantedScopes,
    ...(grant.expiresAt !== undefined ? { tokenExpiresAt: grant.expiresAt } : {}),
    encrypted,
    claimHash: await sha256Base64Url(claim),
  });
  if (!stored.ok)
    return await fail(
      stored.reason === "identity_mismatch" ? "identity_mismatch" : "invalid_state",
    );
  return finish(consumed.returnUrl, { status: "pending", claim });
}

export type CompletedConnection = { connectionId: Id<"connections">; discoveryFailed: boolean };

/**
 * Discovery right after a successful claim (v1/connections:completeConnect). A discovery
 * failure keeps the connection (recorded as its sanitized lastError) and is reported as a
 * warning, as the callback used to.
 */
export async function discoverAfterClaim(
  ctx: ActionCtx,
  connectionId: Id<"connections">,
  actorSubject: string,
): Promise<CompletedConnection> {
  try {
    await discoverAssets(ctx, connectionId, actorSubject);
    return { connectionId, discoveryFailed: false };
  } catch (error) {
    await ctx.runMutation(internal.connections.assets.recordConnectionError, {
      connectionId,
      ...sanitize(error),
    });
    return { connectionId, discoveryFailed: true };
  }
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

/** Sanitized revoke failure: provider error kind and code (filtered again when audited). */
function revokeFailure(error: unknown): Pick<PlatformRevoke, "failureKind" | "failureCode"> {
  if (!isProviderError(error)) return { failureKind: "internal" };
  return {
    failureKind: error.kind,
    ...(error.providerCode !== undefined ? { failureCode: error.providerCode } : {}),
  };
}

/**
 * Best-effort platform revocation of the disconnected credential, then its deletion. How the
 * revoke ended is audited with the deletion (`connection.platform_revoke`), so a revocation
 * that failed or never ran is visible instead of silent.
 *
 * Only the disconnect's own authorization is touched: nothing is sent and nothing is deleted
 * unless the connection is still `revoked` on `credentialVersion` (a reconnect increments it,
 * so disconnect -> reconnect -> disconnect never lets the first job reach the second
 * authorization). The deletion re-checks both in its own transaction. A job without
 * `credentialVersion` was scheduled before versions existed: it neither revokes nor deletes
 * (`legacy_job`); the hourly sweep (maintenance.ts) deletes the credential of a connection
 * that is still revoked.
 */
export const revokeAtPlatform = internalAction({
  args: {
    connectionId: v.id("connections"),
    actorSubject: v.string(),
    credentialVersion: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { connectionId, actorSubject, credentialVersion }) => {
    if (credentialVersion === undefined) {
      await ctx.runMutation(internal.connections.credentialStore.deleteForConnection, {
        connectionId,
        actorSubject,
        platformRevoke: { outcome: "not_attempted", failureKind: "legacy_job" },
      });
      return null;
    }
    let platformRevoke: PlatformRevoke = { outcome: "not_attempted", failureKind: "internal" };
    try {
      platformRevoke = await withConnectionCredential(
        ctx,
        connectionId,
        async (credential, connection): Promise<PlatformRevoke> => {
          if (
            connection.status !== "revoked" ||
            connection.credentialVersion !== credentialVersion
          ) {
            return { outcome: "not_attempted", failureKind: "superseded" };
          }
          // WhatsApp connections are never revoked through the OAuth spec (ADR 0014): the
          // generic disconnect refuses them, and their own offboarding unsubscribes the WABA.
          if (!isOAuthConnectionProvider(connection.provider)) return { outcome: "not_supported" };
          const spec = providerRegistry().oauth(connection.provider);
          if (spec.revoke === undefined) return { outcome: "not_supported" };
          const config = oauthClientConfig(connection.provider);
          try {
            await spec.revoke(credential, config);
            return { outcome: "revoked" };
          } catch (error) {
            return { outcome: "failed", ...revokeFailure(error) };
          }
        },
        { allowRevoked: true },
      );
    } catch (error) {
      // Nothing was sent: the credential or the provider's configuration could not be used.
      // Platform revocation is best effort; the disconnected credential is deleted regardless.
      platformRevoke = {
        outcome: "not_attempted",
        failureKind:
          error instanceof CredentialUnavailableError ? "credential_unavailable" : "internal",
      };
    } finally {
      await ctx.runMutation(internal.connections.credentialStore.deleteForConnection, {
        connectionId,
        actorSubject,
        platformRevoke,
        credentialVersion,
      });
    }
    return null;
  },
});
