import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { AUDIT_ACTIONS, SYSTEM_SWEEP_SUBJECT, writeAudit } from "../lib/audit";
import { STATE_RETENTION_MS, SWEEP_BATCH } from "./config";
import { deleteCredential, deleteExpiredGrants } from "./credentialStore";

/**
 * Hourly connection health sweep (convex/crons.ts). Uses the approved global
 * system indexes; every step is bounded by SWEEP_BATCH.
 * 1. Deletes expired pending states and old consumed/failed states.
 * 2. S2: deletes unclaimed OAuth grants (encrypted credentials) past their expiry.
 * 3. Marks active connections whose access token expired as needs_reauth (Meta ~60 days).
 * 4. Backstop: deletes credentials still attached to revoked connections.
 */
export const sweep = internalMutation({
  args: {},
  returns: v.object({
    statesDeleted: v.number(),
    grantsDeleted: v.number(),
    expired: v.number(),
    credentialsDeleted: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();

    let statesDeleted = 0;
    const states = await ctx.db
      .query("oauthStates")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now))
      .take(SWEEP_BATCH);
    for (const state of states) {
      if (state.status === "pending" || state.expiresAt < now - STATE_RETENTION_MS) {
        await ctx.db.delete(state._id);
        statesDeleted++;
      }
    }

    const grantsDeleted = await deleteExpiredGrants(ctx.db, now, SWEEP_BATCH);

    let expired = 0;
    const expiring = await ctx.db
      .query("connections")
      .withIndex("by_status_expires", (q) =>
        q.eq("status", "active").gte("tokenExpiresAt", 0).lt("tokenExpiresAt", now),
      )
      .take(SWEEP_BATCH);
    for (const connection of expiring) {
      const org = await ctx.db.get(connection.orgId);
      await ctx.db.patch(connection._id, {
        status: "needs_reauth",
        lastError: { kind: "auth", message: "Access token expired", at: now },
        updatedAt: now,
      });
      await writeAudit(
        ctx.db,
        { orgId: connection.orgId, issuer: org?.issuer ?? "", subject: SYSTEM_SWEEP_SUBJECT },
        {
          action: AUDIT_ACTIONS.connectionNeedsReauth,
          targetType: "connection",
          targetId: connection._id,
          changes: {
            status: { from: "active", to: "needs_reauth" },
            reason: { from: null, to: "token_expired" },
          },
        },
      );
      expired++;
    }

    let credentialsDeleted = 0;
    const revoked = await ctx.db
      .query("connections")
      .withIndex("by_status_expires", (q) => q.eq("status", "revoked"))
      .take(SWEEP_BATCH);
    for (const connection of revoked) {
      if (await deleteCredential(ctx.db, connection.orgId, connection._id)) {
        const org = await ctx.db.get(connection.orgId);
        await writeAudit(
          ctx.db,
          { orgId: connection.orgId, issuer: org?.issuer ?? "", subject: SYSTEM_SWEEP_SUBJECT },
          {
            action: AUDIT_ACTIONS.credentialDeleted,
            targetType: "connection",
            targetId: connection._id,
          },
        );
        credentialsDeleted++;
      }
    }

    return { statesDeleted, grantsDeleted, expired, credentialsDeleted };
  },
});
