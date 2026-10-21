import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  linkAdAccounts as linkAccounts,
  discoveredAssetsOf,
  unlinkAdAccount as unlinkAccount,
} from "../connections/assets";
import { oauthClientConfig, oauthRedirectUri, providerRegistry } from "../connections/config";
import { disconnectConnection } from "../connections/lifecycle";
import {
  discoveredSocialAccountsOf,
  linkSocialAccounts as linkSocial,
  unlinkSocialAccount as unlinkSocial,
} from "../connections/socialAssets";
import { connectionProviderValidator } from "../domain/validators";
import { pkceChallengeS256, randomToken, sha256Base64Url } from "../lib/crypto";
import { toIso } from "../lib/dto";
import { apiError } from "../lib/errors";
import { getOwned, orgAdminAction, orgAdminMutation, orgQuery } from "../lib/tenancy";
import { adAccountDto, toAdAccountDto } from "./dto/adAccount";
import {
  connectionDto,
  discoveredAssetDto,
  toConnectionDto,
  toDiscoveredAssetDto,
  type ConnectionDto,
} from "./dto/connection";
import {
  discoveredSocialAccountDto,
  socialAccountDto,
  toDiscoveredSocialAccountDto,
  toSocialAccountDto,
} from "./dto/socialAccount";

/**
 * Platform connections (Phase 4). Admin-only for every connection-changing
 * operation; viewers may list. Never exposes credentials or OAuth state.
 * Phase 10: Instagram Login connections ("instagram") discover and link organic social
 * accounts through the *SocialAccount* functions; ad accounts and social accounts use
 * separate functions and tables and can never be linked through each other's path.
 */

function requiredScopes(provider: Parameters<ReturnType<typeof providerRegistry>["oauth"]>[0]) {
  const registry = providerRegistry();
  return registry.hasOAuth(provider) ? registry.oauth(provider).requiredScopes : [];
}

/**
 * Starts an OAuth connection. An ACTION because the state nonce and PKCE
 * verifier need cryptographically secure randomness (query/mutation
 * randomness is deterministic in Convex). The raw nonce is returned only
 * inside the authorize URL; the database stores its SHA-256 hash.
 */
export const beginConnect = orgAdminAction({
  args: {
    provider: connectionProviderValidator,
    returnUrl: v.optional(v.string()),
    reconnectConnectionId: v.optional(v.string()),
  },
  returns: v.object({ authorizeUrl: v.string(), expiresAt: v.string() }),
  handler: async (ctx, args): Promise<{ authorizeUrl: string; expiresAt: string }> => {
    const registry = providerRegistry();
    // Refused before any OAuth state exists: the platform is not registered, or its app
    // settings are missing or invalid (Meta).
    if (
      !registry.hasOAuth(args.provider) ||
      registry.oauth(args.provider).isConfigured?.(oauthClientConfig(args.provider)) === false
    ) {
      throw apiError("INVALID_ARGUMENT", "This platform cannot be connected yet.", {
        field: "provider",
      });
    }
    const spec = registry.oauth(args.provider);
    const nonce = randomToken();
    const codeVerifier = spec.usesPkce ? randomToken() : undefined;
    // Before any OAuth state exists: an invalid redirect override refuses here.
    const redirectUri = oauthRedirectUri(args.provider);

    const { expiresAt }: { expiresAt: number } = await ctx.runMutation(
      internal.connections.oauthState.create,
      {
        orgId: ctx.tenant.orgId,
        issuer: ctx.tenant.issuer,
        subject: ctx.tenant.subject,
        provider: args.provider,
        nonceHash: await sha256Base64Url(nonce),
        ...(codeVerifier !== undefined ? { codeVerifier } : {}),
        ...(args.returnUrl !== undefined ? { returnUrl: args.returnUrl } : {}),
        ...(args.reconnectConnectionId !== undefined
          ? { reconnectConnectionId: args.reconnectConnectionId }
          : {}),
      },
    );

    const authorizeUrl = spec.buildAuthorizationUrl({
      state: nonce,
      redirectUri,
      ...(codeVerifier !== undefined
        ? { codeChallenge: await pkceChallengeS256(codeVerifier) }
        : {}),
      config: oauthClientConfig(args.provider),
    });
    return { authorizeUrl, expiresAt: toIso(expiresAt) };
  },
});

/** The caller's connections (any status). */
export const list = orgQuery({
  args: {},
  returns: v.array(connectionDto),
  handler: async (ctx): Promise<ConnectionDto[]> => {
    const now = Date.now();
    const connections = await ctx.db
      .query("connections")
      .withIndex("by_org_provider_identity", (q) => q.eq("orgId", ctx.tenant.orgId))
      .take(100);
    return connections.map((c) => toConnectionDto(c, requiredScopes(c.provider), now));
  },
});

export const get = orgQuery({
  args: { connectionId: v.string() },
  returns: connectionDto,
  handler: async (ctx, { connectionId }) => {
    const connection = await getOwned(ctx, "connections", connectionId);
    return toConnectionDto(connection, requiredScopes(connection.provider), Date.now());
  },
});

/** Admin only: accounts this connection can access, and whether each is linked. */
export const listDiscoveredAssets = orgQuery({
  minRole: "admin",
  args: { connectionId: v.string() },
  returns: v.array(discoveredAssetDto),
  handler: async (ctx, { connectionId }) => {
    const connection = await getOwned(ctx, "connections", connectionId);
    const linked = await ctx.db
      .query("adAccounts")
      .withIndex("by_org_connection", (q) =>
        q.eq("orgId", ctx.tenant.orgId).eq("connectionId", connection._id),
      )
      .collect();
    const linkedIds = new Set(linked.map((a) => `${a.platform}:${a.externalId}`));
    const assets = await discoveredAssetsOf(ctx.db, ctx.tenant.orgId, connection._id);
    return assets.map((a) =>
      toDiscoveredAssetDto(a, linkedIds.has(`${a.platform}:${a.externalId}`)),
    );
  },
});

/** Admin only: link discovered accounts (1-50 per call) to this connection. */
export const linkAdAccounts = orgAdminMutation({
  args: { connectionId: v.string(), externalIds: v.array(v.string()) },
  returns: v.array(adAccountDto),
  handler: async (ctx, { connectionId, externalIds }) =>
    (await linkAccounts(ctx, connectionId, externalIds)).map((account) => toAdAccountDto(account)),
});

/** Admin only: unlink an ad account (row and metrics are kept). */
export const unlinkAdAccount = orgAdminMutation({
  args: { adAccountId: v.string() },
  returns: adAccountDto,
  handler: async (ctx, { adAccountId }) => toAdAccountDto(await unlinkAccount(ctx, adAccountId)),
});

/** Admin only: organic social accounts this connection can access (Phase 10). */
export const listDiscoveredSocialAccounts = orgQuery({
  minRole: "admin",
  args: { connectionId: v.string() },
  returns: v.array(discoveredSocialAccountDto),
  handler: async (ctx, { connectionId }) => {
    const connection = await getOwned(ctx, "connections", connectionId);
    const linked = await ctx.db
      .query("socialAccounts")
      .withIndex("by_org_connection", (q) =>
        q.eq("orgId", ctx.tenant.orgId).eq("connectionId", connection._id),
      )
      .collect();
    const linkedIds = new Set(linked.map((a) => `${a.platform}:${a.externalId}`));
    const rows = await discoveredSocialAccountsOf(ctx.db, ctx.tenant.orgId, connection._id);
    return rows.map((row) =>
      toDiscoveredSocialAccountDto(row, linkedIds.has(`${row.platform}:${row.externalId}`)),
    );
  },
});

/** Admin only: link discovered social accounts (1-50 per call) to this connection (Phase 10). */
export const linkSocialAccounts = orgAdminMutation({
  args: { connectionId: v.string(), externalIds: v.array(v.string()) },
  returns: v.array(socialAccountDto),
  handler: async (ctx, { connectionId, externalIds }) =>
    (await linkSocial(ctx, connectionId, externalIds)).map(toSocialAccountDto),
});

/** Admin only: unlink a social account (row and data are kept) (Phase 10). */
export const unlinkSocialAccount = orgAdminMutation({
  args: { socialAccountId: v.string() },
  returns: socialAccountDto,
  handler: async (ctx, { socialAccountId }) =>
    toSocialAccountDto(await unlinkSocial(ctx, socialAccountId)),
});

/** Admin only: revoke the connection, unlink its accounts and delete its credential. */
export const disconnect = orgAdminMutation({
  args: { connectionId: v.string() },
  returns: connectionDto,
  handler: async (ctx, { connectionId }) => {
    const connection = await disconnectConnection(ctx, connectionId);
    return toConnectionDto(connection, requiredScopes(connection.provider), Date.now());
  },
});

/** Admin only: re-run account discovery in the background. */
export const refreshAssets = orgAdminMutation({
  args: { connectionId: v.string() },
  returns: v.null(),
  handler: async (ctx, { connectionId }) => {
    const connection = await getOwned(ctx, "connections", connectionId);
    if (connection.status !== "active") {
      throw apiError("CONFLICT", "The connection is not active.", {
        reason: "connection_inactive",
      });
    }
    await ctx.scheduler.runAfter(0, internal.connections.oauthFlow.runDiscovery, {
      connectionId: connection._id,
      actorSubject: ctx.tenant.subject,
    });
    return null;
  },
});
