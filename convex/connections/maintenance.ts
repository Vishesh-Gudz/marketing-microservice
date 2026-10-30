import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { AUDIT_ACTIONS, SYSTEM_SWEEP_SUBJECT, writeAudit } from "../lib/audit";
import { STATE_RETENTION_MS, SWEEP_BATCH } from "./config";
import { deleteExpiredGrants } from "./credentialStore";
import { startCredentialSweep } from "./credentialSweep";

/**
 * Hourly connection health sweep (convex/crons.ts). Uses the approved global
 * system indexes; every step is bounded by SWEEP_BATCH.
 * 1. Deletes expired pending states and old consumed/failed states.
 * 2. S2: deletes unclaimed OAuth grants (encrypted credentials) past their expiry.
 * 3. Marks active connections whose access token expired as needs_reauth (Meta ~60 days).
 * 4. Backstop: deletes credentials still attached to revoked connections. A revoked WhatsApp
 *    connection keeps its credential for WHATSAPP_REVOKED_CREDENTIAL_GRACE_MS (ADR 0014 B4: its
 *    disconnect cleanup still unsubscribes with the token and deletes it itself); every other
 *    provider is unchanged. IM7.0: every revoked connection is visited, page by page from a
 *    persisted cursor (credentialSweep.ts); this run processes the first page of its pass and
 *    schedules the rest. `credentialPageLimit` (tests only) caps the pages of one run.
 */
export const sweep = internalMutation({
  args: { credentialPageLimit: v.optional(v.number()) },
  returns: v.object({
    statesDeleted: v.number(),
    grantsDeleted: v.number(),
    expired: v.number(),
    credentialsDeleted: v.number(),
    credentialSweep: v.union(v.literal("started"), v.literal("busy")),
  }),
  handler: async (ctx, { credentialPageLimit }) => {
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

    const credentials = await startCredentialSweep(ctx, now, credentialPageLimit);

    return {
      statesDeleted,
      grantsDeleted,
      expired,
      credentialsDeleted: credentials.deleted,
      credentialSweep: credentials.run,
    };
  },
});
