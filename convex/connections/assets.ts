import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type DatabaseReader, type MutationCtx } from "../_generated/server";
import { AUDIT_ACTIONS, writeAudit } from "../lib/audit";
import { apiError } from "../lib/errors";
import { getOwned, type Tenant } from "../lib/tenancy";
import { orgScopeFromTenant } from "../mapping/scope";
import type { ProviderAdAccount } from "../providers/types";
import { RECORD_VALIDATORS } from "../providers/validate";
import { ensureSyncAccount } from "../sync/state";
import { upsertLinkedAdAccount } from "../sync/upsert";
import { MAX_LINK_BATCH } from "./config";

/**
 * Discovered assets (what a connection can see) and linking them to the
 * canonical `adAccounts` table. The adAccounts write goes through the single
 * canonical write path (sync/upsert.ts: upsert by natural key orgId, platform,
 * externalId), and linking creates the account's sync state (Phase 5).
 */

type TenantCtx = MutationCtx & { tenant: Tenant };

/** A connection's discovered assets (org-scoped index). */
export async function discoveredAssetsOf(
  db: DatabaseReader,
  orgId: Id<"organizations">,
  connectionId: Id<"connections">,
): Promise<Doc<"discoveredAssets">[]> {
  return await db
    .query("discoveredAssets")
    .withIndex("by_org_connection_external", (q) =>
      q.eq("orgId", orgId).eq("connectionId", connectionId),
    )
    .collect();
}

/** Replaces a connection's discovered assets with a fresh provider listing. */
export const storeDiscoveredAssets = internalMutation({
  args: {
    connectionId: v.id("connections"),
    records: v.array(RECORD_VALIDATORS.adAccount),
    actorSubject: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, { connectionId, records, actorSubject }) => {
    const connection = await ctx.db.get(connectionId);
    if (connection === null || connection.status !== "active") return 0;
    const org = await ctx.db.get(connection.orgId);
    const now = Date.now();

    const previous = await discoveredAssetsOf(ctx.db, connection.orgId, connectionId);
    for (const asset of previous) await ctx.db.delete(asset._id);

    let stored = 0;
    for (const record of records) {
      // Provider records are tenant-free; the org comes from the stored connection.
      if (record.platform !== connection.provider) continue;
      await ctx.db.insert("discoveredAssets", {
        orgId: connection.orgId,
        connectionId,
        assetType: "ad_account",
        platform: record.platform,
        externalId: record.externalId,
        name: record.name,
        currency: record.currency,
        timezone: record.timezone,
        status: record.status,
        ...(record.rawStatus !== undefined ? { rawStatus: record.rawStatus } : {}),
        isManager: record.isManager,
        ...(record.parentExternalId !== undefined
          ? { parentExternalId: record.parentExternalId }
          : {}),
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
        changes: { assets: { from: previous.length, to: stored } },
      },
    );
    return stored;
  },
});

/** Records a sanitized connection error (kind + generic message only). */
export const recordConnectionError = internalMutation({
  args: { connectionId: v.id("connections"), kind: v.string(), message: v.string() },
  returns: v.null(),
  handler: async (ctx, { connectionId, kind, message }) => {
    const connection = await ctx.db.get(connectionId);
    if (connection === null) return null;
    const now = Date.now();
    await ctx.db.patch(connectionId, { lastError: { kind, message, at: now }, updatedAt: now });
    return null;
  },
});

function assetToRecord(asset: Doc<"discoveredAssets">): ProviderAdAccount {
  return {
    platform: asset.platform,
    externalId: asset.externalId,
    name: asset.name,
    currency: asset.currency,
    timezone: asset.timezone,
    status: asset.status,
    ...(asset.rawStatus !== undefined ? { rawStatus: asset.rawStatus } : {}),
    isManager: asset.isManager,
    ...(asset.parentExternalId !== undefined ? { parentExternalId: asset.parentExternalId } : {}),
  };
}

/**
 * Links discovered accounts of an ACTIVE connection. Only ids discovered by
 * that connection are linkable; manager accounts are rejected. Relinking an
 * account from another connection of the same org is allowed and audited.
 */
export async function linkAdAccounts(
  ctx: TenantCtx,
  connectionIdInput: string,
  externalIds: readonly string[],
): Promise<Doc<"adAccounts">[]> {
  const connection = await getOwned(ctx, "connections", connectionIdInput);
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
  const linked: Doc<"adAccounts">[] = [];

  for (const externalId of unique) {
    const asset = await ctx.db
      .query("discoveredAssets")
      .withIndex("by_org_connection_external", (q) =>
        q
          .eq("orgId", ctx.tenant.orgId)
          .eq("connectionId", connection._id)
          .eq("externalId", externalId),
      )
      .unique();
    if (asset === null) {
      throw apiError("NOT_FOUND", "Account was not discovered by this connection.", { externalId });
    }
    if (asset.isManager) {
      throw apiError("INVALID_ARGUMENT", "Manager accounts cannot be linked.", { externalId });
    }

    // The single canonical write path (convex/sync/upsert.ts), by natural key.
    const { adAccountId, created, previousConnectionId } = await upsertLinkedAdAccount(
      ctx.db,
      scope,
      assetToRecord(asset),
      connection._id,
      now,
    );

    let action: string | undefined = AUDIT_ACTIONS.adAccountLinked;
    if (!created) {
      if (previousConnectionId === connection._id)
        action = undefined; // already linked: idempotent
      else if (previousConnectionId !== undefined) action = AUDIT_ACTIONS.adAccountRelinked;
    }

    if (action !== undefined) {
      await writeAudit(ctx.db, ctx.tenant, {
        action,
        targetType: "adAccount",
        targetId: adAccountId,
        ...(previousConnectionId !== undefined && action === AUDIT_ACTIONS.adAccountRelinked
          ? { changes: { connectionId: { from: previousConnectionId, to: connection._id } } }
          : {}),
      });
    }
    const account = (await ctx.db.get(adAccountId))!;
    // Phase 5: the account gets (or resumes) a sync schedule in the same transaction.
    await ensureSyncAccount(
      ctx.db,
      account,
      { relinked: previousConnectionId !== undefined && previousConnectionId !== connection._id },
      now,
    );
    linked.push(account);
  }
  return linked;
}

/** Unlinks an account (idempotent). The row and its metrics are kept. */
export async function unlinkAdAccount(
  ctx: TenantCtx,
  adAccountIdInput: string,
): Promise<Doc<"adAccounts">> {
  const account = await getOwned(ctx, "adAccounts", adAccountIdInput);
  if (account.connectionId === undefined) return account;
  await ctx.db.patch(account._id, {
    connectionId: undefined,
    linkedAt: undefined,
    updatedAt: Date.now(),
  });
  await writeAudit(ctx.db, ctx.tenant, {
    action: AUDIT_ACTIONS.adAccountUnlinked,
    targetType: "adAccount",
    targetId: account._id,
    changes: { connectionId: { from: account.connectionId, to: null } },
  });
  return (await ctx.db.get(account._id))!;
}
