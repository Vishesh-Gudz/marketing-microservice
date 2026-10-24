import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type DatabaseReader } from "../_generated/server";
import { encryptedValidator, upsertDirectConnection } from "../connections/credentialStore";
import { AUDIT_ACTIONS, writeAudit } from "../lib/audit";
import { requireUserSubject, whatsappConnectionsEnabled } from "./config";
import { isNumericId } from "./payload";
import { onboardingTypeValidator } from "./validators";

/**
 * WhatsApp connections (ADR 0014): the database side of Embedded Signup.
 *
 * The Embedded Signup action (B2) exchanges the signup code, verifies server-side that the WABA
 * belongs to the token's business, encrypts the business token (and the registration PIN) for
 * (orgId, "whatsapp", businessId), and then calls `recordConnection`. This module never sees
 * plaintext and never calls Meta.
 *
 * - The org and actor come from the caller's verified JWT (passed on by the action), never from
 *   the browser. The actor must be a signed-in user, never an operator or system label.
 * - A WABA is active in at most one org (D10): another org's active WABA is refused before
 *   anything is written, through the approved global index `by_waba_status`.
 * - One connection per (org, business): its credential is the business token. One account row
 *   per (org, WABA).
 * - New connections stay closed on cloud deployments until WHATSAPP_CONNECTIONS_ENABLED=true.
 */

/** Whether ANOTHER org has this WABA active. Reads the approved global index only to compare. */
async function wabaActiveElsewhere(
  db: DatabaseReader,
  wabaId: string,
  orgId: Id<"organizations">,
): Promise<boolean> {
  const active = await db
    .query("whatsappBusinessAccounts")
    .withIndex("by_waba_status", (q) => q.eq("wabaId", wabaId).eq("status", "active"))
    .take(2);
  return active.some((row) => row.orgId !== orgId);
}

export const recordConnection = internalMutation({
  args: {
    orgId: v.id("organizations"),
    /** The connecting admin's verified JWT issuer and subject (from the action's tenant). */
    issuer: v.string(),
    actorSubject: v.string(),
    businessId: v.string(),
    wabaId: v.string(),
    onboardingType: onboardingTypeValidator,
    /** Business name for display (from Meta); optional. */
    displayName: v.optional(v.string()),
    grantedScopes: v.array(v.string()),
    /** Business token (+ PIN) encrypted for (orgId, "whatsapp", businessId). */
    encrypted: encryptedValidator,
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      connectionId: v.id("connections"),
      accountId: v.id("whatsappBusinessAccounts"),
      reconnected: v.boolean(),
    }),
    v.object({
      ok: v.literal(false),
      reason: v.union(
        v.literal("connections_disabled"),
        v.literal("invalid_id"),
        v.literal("no_org"),
        v.literal("waba_in_use"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    requireUserSubject(args.actorSubject);
    if (!whatsappConnectionsEnabled()) {
      return { ok: false as const, reason: "connections_disabled" as const };
    }
    if (!isNumericId(args.businessId) || !isNumericId(args.wabaId)) {
      return { ok: false as const, reason: "invalid_id" as const };
    }
    if ((await ctx.db.get(args.orgId)) === null) {
      return { ok: false as const, reason: "no_org" as const };
    }
    // Another org's WABA wins; its identity is never revealed.
    if (await wabaActiveElsewhere(ctx.db, args.wabaId, args.orgId)) {
      return { ok: false as const, reason: "waba_in_use" as const };
    }

    const now = Date.now();
    const { connectionId, reconnected } = await upsertDirectConnection(ctx.db, {
      orgId: args.orgId,
      provider: "whatsapp",
      externalUserId: args.businessId,
      ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
      grantedScopes: args.grantedScopes,
      connectedBySubject: args.actorSubject,
      encrypted: args.encrypted,
      now,
    });

    const account = await ctx.db
      .query("whatsappBusinessAccounts")
      .withIndex("by_org_waba", (q) => q.eq("orgId", args.orgId).eq("wabaId", args.wabaId))
      .unique();
    const fields = {
      connectionId,
      businessId: args.businessId,
      onboardingType: args.onboardingType,
      status: "active" as const,
      connectedBySubject: args.actorSubject,
      disconnectedAt: undefined,
      updatedAt: now,
    };
    let accountId: Id<"whatsappBusinessAccounts">;
    if (account) {
      accountId = account._id;
      await ctx.db.patch(account._id, fields);
    } else {
      accountId = await ctx.db.insert("whatsappBusinessAccounts", {
        orgId: args.orgId,
        wabaId: args.wabaId,
        connectionId,
        businessId: args.businessId,
        onboardingType: args.onboardingType,
        status: "active",
        connectedBySubject: args.actorSubject,
        createdAt: now,
        updatedAt: now,
      });
    }

    await writeAudit(
      ctx.db,
      { orgId: args.orgId, issuer: args.issuer, subject: args.actorSubject },
      {
        action: reconnected
          ? AUDIT_ACTIONS.connectionReconnected
          : AUDIT_ACTIONS.connectionConnected,
        targetType: "connection",
        targetId: connectionId,
        changes: { provider: { from: null, to: "whatsapp" } },
      },
    );
    return { ok: true as const, connectionId, accountId, reconnected };
  },
});
