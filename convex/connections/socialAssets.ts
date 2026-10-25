import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type DatabaseReader, type MutationCtx } from "../_generated/server";
import { isSocialConnectionProvider } from "../domain/types";
import { AUDIT_ACTIONS, writeAudit } from "../lib/audit";
import { apiError } from "../lib/errors";
import { getOwned, type Tenant } from "../lib/tenancy";
import { orgScopeFromTenant } from "../mapping/scope";
import type { ProviderDiscoveredSocialAccount } from "../providers/social/types";
import { SOCIAL_RECORD_VALIDATORS } from "../providers/social/validate";
import { ensureSocialSyncAccount } from "../sync/state";
import { upsertLinkedSocialAccount } from "../sync/upsert";
import { MAX_LINK_BATCH, providerRegistry } from "./config";
import { markYouTubeAccountForPurge } from "./youtubeRetention";

/**
 * Discovered organic social accounts (Phase 10) and linking them to the canonical
 * `socialAccounts` table — the social counterpart of assets.ts, deliberately separate
 * (discoveredSocialAccounts vs discoveredAssets; socialAccounts vs adAccounts), so an ad
 * account and a social account can never be confused. The socialAccounts write goes
 * through the single canonical write path (sync/upsert.ts, natural key orgId, platform,
 * externalId), and linking creates the account's sync state in the same transaction.
 */

type TenantCtx = MutationCtx & { tenant: Tenant };

export async function discoveredSocialAccountsOf(
  db: DatabaseReader,
  orgId: Id<"organizations">,
  connectionId: Id<"connections">,
): Promise<Doc<"discoveredSocialAccounts">[]> {
  return await db
    .query("discoveredSocialAccounts")
    .withIndex("by_org_connection_external", (q) =>
      q.eq("orgId", orgId).eq("connectionId", connectionId),
    )
    .collect();
}

/** Replaces a social connection's discovered accounts with a fresh discovery. */
export const storeDiscoveredSocialAccounts = internalMutation({
  args: {
    connectionId: v.id("connections"),
    records: v.array(SOCIAL_RECORD_VALIDATORS.discoveredSocialAccount),
    actorSubject: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, { connectionId, records, actorSubject }) => {
    const connection = await ctx.db.get(connectionId);
    if (
      connection === null ||
      connection.status !== "active" ||
      !isSocialConnectionProvider(connection.provider)
    ) {
      return 0;
    }
    const org = await ctx.db.get(connection.orgId);
    const now = Date.now();

    const previous = await discoveredSocialAccountsOf(ctx.db, connection.orgId, connectionId);
    for (const row of previous) await ctx.db.delete(row._id);

    let stored = 0;
    const seen = new Set<string>();
    for (const record of records) {
      // Provider records are tenant-free; the org comes from the stored connection. Only
      // accounts of the connection's own platform are kept, once each.
      if (record.platform !== connection.provider || seen.has(record.externalId)) continue;
      seen.add(record.externalId);
      await ctx.db.insert("discoveredSocialAccounts", {
        orgId: connection.orgId,
        connectionId,
        platform: record.platform,
        externalId: record.externalId,
        ...(record.username !== undefined ? { username: record.username } : {}),
        accountType: record.accountType,
        discoveredAt: now,
      });
      stored++;
    }
    await ctx.db.patch(connectionId, { lastError: undefined, updatedAt: now });
    await writeAudit(
      ctx.db,
      { orgId: connection.orgId, issuer: org?.issuer ?? "", subject: actorSubject },
      {
        action: AUDIT_ACTIONS.connectionAssetsDiscovered,
        targetType: "connection",
        targetId: connectionId,
        changes: { socialAccounts: { from: previous.length, to: stored } },
      },
    );
    return stored;
  },
});

function discoveredToRecord(row: Doc<"discoveredSocialAccounts">): ProviderDiscoveredSocialAccount {
  return {
    platform: row.platform,
    externalId: row.externalId,
    ...(row.username !== undefined ? { username: row.username } : {}),
    accountType: row.accountType,
  };
}

/**
 * Links discovered social accounts of an ACTIVE social connection (1-50 per call). Only ids
 * discovered by that connection are linkable. Relinking an account from another connection
 * of the same org is allowed and audited.
 */
export async function linkSocialAccounts(
  ctx: TenantCtx,
  connectionIdInput: string,
  externalIds: readonly string[],
): Promise<Doc<"socialAccounts">[]> {
  const connection = await getOwned(ctx, "connections", connectionIdInput);
  if (!isSocialConnectionProvider(connection.provider)) {
    throw apiError("INVALID_ARGUMENT", "This connection does not provide social accounts.", {
      field: "connectionId",
    });
  }
  if (connection.status !== "active") {
    throw apiError("CONFLICT", "The connection is not active.", { reason: "connection_inactive" });
  }
  const unique = [...new Set(externalIds)];
  if (unique.length === 0 || unique.length > MAX_LINK_BATCH) {
    throw apiError("INVALID_ARGUMENT", `Provide 1-${MAX_LINK_BATCH} external ids.`, {
      field: "externalIds",
    });
  }

  const now = Date.now();
  const scope = orgScopeFromTenant(ctx.tenant);
  const horizonDays = providerRegistry().socialCapabilities(
    connection.provider,
  ).accountMetricsHorizonDays;
  const linked: Doc<"socialAccounts">[] = [];

  for (const externalId of unique) {
    const discovered = await ctx.db
      .query("discoveredSocialAccounts")
      .withIndex("by_org_connection_external", (q) =>
        q
          .eq("orgId", ctx.tenant.orgId)
          .eq("connectionId", connection._id)
          .eq("externalId", externalId),
      )
      .unique();
    if (discovered === null) {
      throw apiError("NOT_FOUND", "Account was not discovered by this connection.", { externalId });
    }
    // ADR 0016 (Checkpoint 3b): a YouTube channel whose stored data is still being deleted is
    // linked again only once the purge completed (then as a new channel, backfilled afresh).
    if (connection.provider === "youtube") {
      const pending = await ctx.db
        .query("socialAccounts")
        .withIndex("by_org_platform_external", (q) =>
          q.eq("orgId", ctx.tenant.orgId).eq("platform", "youtube").eq("externalId", externalId),
        )
        .first();
      if (pending?.status === "disconnected") {
        throw apiError(
          "CONFLICT",
          "This channel's stored data is still being deleted. Try again shortly.",
          {
            reason: "purge_pending",
            externalId,
          },
        );
      }
    }

    // The single canonical write path (convex/sync/upsert.ts), by natural key.
    const { socialAccountId, created, previousConnectionId } = await upsertLinkedSocialAccount(
      ctx.db,
      scope,
      discoveredToRecord(discovered),
      connection._id,
      now,
    );

    let action: string | undefined = AUDIT_ACTIONS.socialAccountLinked;
    if (!created) {
      if (previousConnectionId === connection._id)
        action = undefined; // idempotent
      else if (previousConnectionId !== undefined) action = AUDIT_ACTIONS.socialAccountRelinked;
    }
    if (action !== undefined) {
      await writeAudit(ctx.db, ctx.tenant, {
        action,
        targetType: "socialAccount",
        targetId: socialAccountId,
        ...(previousConnectionId !== undefined && action === AUDIT_ACTIONS.socialAccountRelinked
          ? { changes: { connectionId: { from: previousConnectionId, to: connection._id } } }
          : {}),
      });
    }
    const account = (await ctx.db.get(socialAccountId))!;
    // The account gets (or resumes) a sync schedule in the same transaction.
    await ensureSocialSyncAccount(
      ctx.db,
      account,
      {
        relinked: previousConnectionId !== undefined && previousConnectionId !== connection._id,
        horizonDays,
      },
      now,
    );
    linked.push(account);
  }
  return linked;
}

/**
 * Unlinks a social account (idempotent). The row and its data are kept, except for YouTube
 * (ADR 0016, Checkpoint 3b): the channel is marked for purge and its stored data deleted
 * (connections/youtubeRetention.ts), also when it was already unlinked.
 */
export async function unlinkSocialAccount(
  ctx: TenantCtx,
  socialAccountIdInput: string,
): Promise<Doc<"socialAccounts">> {
  const account = await getOwned(ctx, "socialAccounts", socialAccountIdInput);
  const now = Date.now();
  if (account.connectionId !== undefined) {
    await ctx.db.patch(account._id, {
      connectionId: undefined,
      linkedAt: undefined,
      updatedAt: now,
    });
    await writeAudit(ctx.db, ctx.tenant, {
      action: AUDIT_ACTIONS.socialAccountUnlinked,
      targetType: "socialAccount",
      targetId: account._id,
      changes: { connectionId: { from: account.connectionId, to: null } },
    });
  }
  if (account.platform === "youtube" && account.status !== "disconnected") {
    await markYouTubeAccountForPurge(ctx, account, "unlinked", ctx.tenant, now);
  }
  return (await ctx.db.get(account._id))!;
}

/**
 * Disconnect path (lifecycle.ts): unlink every social account of the connection. YouTube
 * channels are marked for purge (ADR 0016, Checkpoint 3b).
 */
export async function unlinkSocialAccountsOfConnection(
  ctx: TenantCtx,
  connectionId: Id<"connections">,
  now: number,
): Promise<number> {
  const linked = await ctx.db
    .query("socialAccounts")
    .withIndex("by_org_connection", (q) =>
      q.eq("orgId", ctx.tenant.orgId).eq("connectionId", connectionId),
    )
    .collect();
  for (const account of linked) {
    await ctx.db.patch(account._id, {
      connectionId: undefined,
      linkedAt: undefined,
      updatedAt: now,
    });
    await writeAudit(ctx.db, ctx.tenant, {
      action: AUDIT_ACTIONS.socialAccountUnlinked,
      targetType: "socialAccount",
      targetId: account._id,
      changes: { connectionId: { from: connectionId, to: null } },
    });
    if (account.platform === "youtube") {
      await markYouTubeAccountForPurge(ctx, account, "disconnected", ctx.tenant, now);
    }
  }
  for (const row of await discoveredSocialAccountsOf(ctx.db, ctx.tenant.orgId, connectionId)) {
    await ctx.db.delete(row._id);
  }
  return linked.length;
}
