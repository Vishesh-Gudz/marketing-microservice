import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type DatabaseWriter, type MutationCtx } from "../_generated/server";
import { AUDIT_ACTIONS, writeAudit } from "../lib/audit";
import { getOwned, type Tenant } from "../lib/tenancy";
import { discoveredAssetsOf } from "./assets";
import { unlinkSocialAccountsOfConnection } from "./socialAssets";

/**
 * Connection lifecycle:  active -> needs_reauth -> (reconnect) -> active
 *                        active|needs_reauth -> revoked (disconnect; credential deleted)
 */

type TenantCtx = MutationCtx & { tenant: Tenant };

/**
 * Disconnects: revoked + unlink its ad accounts and (Phase 10) social accounts (rows and
 * data kept) + drop discovered assets + schedule platform revoke and credential deletion.
 */
export async function disconnectConnection(
  ctx: TenantCtx,
  connectionIdInput: string,
): Promise<Doc<"connections">> {
  const connection = await getOwned(ctx, "connections", connectionIdInput);
  if (connection.status === "revoked") return connection;
  const now = Date.now();

  await ctx.db.patch(connection._id, { status: "revoked", revokedAt: now, updatedAt: now });
  const linked = await ctx.db
    .query("adAccounts")
    .withIndex("by_org_connection", (q) =>
      q.eq("orgId", ctx.tenant.orgId).eq("connectionId", connection._id),
    )
    .collect();
  for (const account of linked) {
    await ctx.db.patch(account._id, {
      connectionId: undefined,
      linkedAt: undefined,
      updatedAt: now,
    });
    await writeAudit(ctx.db, ctx.tenant, {
      action: AUDIT_ACTIONS.adAccountUnlinked,
      targetType: "adAccount",
      targetId: account._id,
      changes: { connectionId: { from: connection._id, to: null } },
    });
  }
  for (const asset of await discoveredAssetsOf(ctx.db, ctx.tenant.orgId, connection._id)) {
    await ctx.db.delete(asset._id);
  }
  const socialUnlinked = await unlinkSocialAccountsOfConnection(ctx, connection._id, now);
  await ctx.scheduler.runAfter(0, internal.connections.oauthFlow.revokeAtPlatform, {
    connectionId: connection._id,
    actorSubject: ctx.tenant.subject,
  });
  await writeAudit(ctx.db, ctx.tenant, {
    action: AUDIT_ACTIONS.connectionDisconnected,
    targetType: "connection",
    targetId: connection._id,
    changes: {
      status: { from: connection.status, to: "revoked" },
      unlinkedAccounts: { from: linked.length + socialUnlinked, to: 0 },
    },
  });
  return (await ctx.db.get(connection._id))!;
}

/**
 * Marks an active connection as needing re-authorization, with its audit entry,
 * inside the caller's transaction. Returns false if it was not active. Used by
 * `markNeedsReauth` and by the sync engine on provider `auth` errors (Phase 5).
 */
export async function markConnectionNeedsReauth(
  db: DatabaseWriter,
  connectionId: Id<"connections">,
  reason: string,
  actorSubject: string,
): Promise<boolean> {
  const connection = await db.get(connectionId);
  if (connection === null || connection.status !== "active") return false;
  const org = await db.get(connection.orgId);
  const now = Date.now();
  await db.patch(connectionId, {
    status: "needs_reauth",
    lastError: { kind: "auth", message: "Re-authorization required", at: now },
    updatedAt: now,
  });
  await writeAudit(
    db,
    { orgId: connection.orgId, issuer: org?.issuer ?? "", subject: actorSubject },
    {
      action: AUDIT_ACTIONS.connectionNeedsReauth,
      targetType: "connection",
      targetId: connectionId,
      changes: {
        status: { from: "active", to: "needs_reauth" },
        reason: { from: null, to: reason },
      },
    },
  );
  return true;
}

/** Marks an active connection as needing re-authorization (health sweep, operators). */
export const markNeedsReauth = internalMutation({
  args: { connectionId: v.id("connections"), reason: v.string(), actorSubject: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { connectionId, reason, actorSubject }) =>
    await markConnectionNeedsReauth(ctx.db, connectionId, reason, actorSubject),
});
