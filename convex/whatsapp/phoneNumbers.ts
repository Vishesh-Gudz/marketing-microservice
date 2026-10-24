import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type DatabaseReader, type DatabaseWriter } from "../_generated/server";
import { AUDIT_ACTIONS, writeAudit } from "../lib/audit";
import { requireOperatorSubject, requireUserSubject } from "./config";
import { isNumericId } from "./payload";

/**
 * WhatsApp phone-number routing: the server-controlled mapping from a Meta phone_number_id to
 * exactly one org. It is the ONLY way a webhook delivery reaches a tenant.
 *
 * Invariant: at most one `active` row per phone_number_id across all orgs. `register` refuses a
 * number that another org holds active; the webhook additionally fails closed if it ever finds
 * more than one, or a WABA id that differs from the registered one.
 *
 * Internal only: no public function accepts an org id or a phone_number_id to route. Two entry
 * points share one registration path:
 * - `register` / `disconnect`: run by an operator (Convex dashboard, or a deploy key) with an
 *   `operator:<name>` actorSubject, recorded but NOT verified by this application.
 * - `registerForConnection` (ADR 0014): called by the Embedded Signup action for a number of a
 *   connected WABA, with the signed-in admin's verified JWT subject.
 */

async function activeRows(db: DatabaseReader, phoneNumberId: string) {
  // Approved global index (convex/schema.test.ts): tenant resolution and the uniqueness check.
  return await db
    .query("whatsappPhoneNumbers")
    .withIndex("by_phone_number_status", (q) =>
      q.eq("phoneNumberId", phoneNumberId).eq("status", "active"),
    )
    .take(2);
}

/**
 * The org-owned number a webhook change belongs to, or null (unknown, ambiguous, or the
 * delivery's WABA id does not match the registered one). Never consults the payload for an org.
 */
export async function resolveWebhookNumber(
  db: DatabaseReader,
  change: { phoneNumberId: string; wabaId: string },
): Promise<Doc<"whatsappPhoneNumbers"> | null> {
  const rows = await activeRows(db, change.phoneNumberId);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  return row.wabaId === change.wabaId ? row : null;
}

/**
 * True when an event happened before the number's current activation, i.e. it belongs to a
 * previous ownership (another org, or this org before a disconnect) and must not be stored.
 * Meta timestamps have one-second resolution, so the cutoff is the activation's second: an
 * event in that same second counts as at activation. Rows without `activatedAt` (registered
 * before it existed) use `createdAt`.
 */
export function isBeforeActivation(
  number: Pick<Doc<"whatsappPhoneNumbers">, "activatedAt" | "createdAt">,
  timestampMs: number,
): boolean {
  const activatedAt = number.activatedAt ?? number.createdAt;
  return timestampMs < Math.floor(activatedAt / 1000) * 1000;
}

const registerResult = v.union(
  v.object({ ok: v.literal(true), numberId: v.id("whatsappPhoneNumbers") }),
  v.object({
    ok: v.literal(false),
    reason: v.union(v.literal("invalid_id"), v.literal("in_use"), v.literal("no_org")),
  }),
);

/**
 * The one registration path. Registers (or re-activates) a number for an org and refuses a
 * number another org holds active. `link` ties the number to a connected WABA (Embedded
 * Signup); without it (operator), a new row is recorded as `operator` and an existing row keeps
 * its source and account.
 */
async function registerNumber(
  db: DatabaseWriter,
  input: {
    orgId: Id<"organizations">;
    wabaId: string;
    phoneNumberId: string;
    displayPhoneNumber?: string;
    actorSubject: string;
    link?: { accountId: Id<"whatsappBusinessAccounts"> };
  },
) {
  if (!isNumericId(input.wabaId) || !isNumericId(input.phoneNumberId)) {
    return { ok: false as const, reason: "invalid_id" as const };
  }
  const org = await db.get(input.orgId);
  if (org === null) return { ok: false as const, reason: "no_org" as const };

  const active = await activeRows(db, input.phoneNumberId);
  // Another org's active registration wins; its identity is never revealed.
  if (active.some((row) => row.orgId !== input.orgId)) {
    return { ok: false as const, reason: "in_use" as const };
  }
  const now = Date.now();
  const own = await db
    .query("whatsappPhoneNumbers")
    .withIndex("by_org_phone_number", (q) =>
      q.eq("orgId", input.orgId).eq("phoneNumberId", input.phoneNumberId),
    )
    .unique();
  // A new or re-activated registration starts a new ownership; updating a number that is
  // already active keeps its activation, so its own late deliveries are not dropped.
  const activating = own === null || own.status !== "active";
  const linkFields = input.link
    ? { source: "embedded_signup" as const, accountId: input.link.accountId }
    : {};
  const fields = {
    wabaId: input.wabaId,
    displayPhoneNumber: input.displayPhoneNumber,
    status: "active" as const,
    registeredBySubject: input.actorSubject,
    ...(activating ? { activatedAt: now } : {}),
    disconnectedAt: undefined,
    ...linkFields,
    updatedAt: now,
  };
  let numberId;
  if (own !== null) {
    numberId = own._id;
    await db.patch(own._id, fields);
  } else {
    numberId = await db.insert("whatsappPhoneNumbers", {
      orgId: input.orgId,
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      ...(input.displayPhoneNumber !== undefined
        ? { displayPhoneNumber: input.displayPhoneNumber }
        : {}),
      status: "active",
      registeredBySubject: input.actorSubject,
      activatedAt: now,
      source: "operator",
      ...linkFields,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (activating) {
    await writeAudit(
      db,
      { orgId: input.orgId, issuer: org.issuer, subject: input.actorSubject },
      {
        action: AUDIT_ACTIONS.whatsappNumberRegistered,
        targetType: "whatsappPhoneNumber",
        targetId: numberId,
        changes: { status: { from: own?.status ?? null, to: "active" } },
      },
    );
  }
  return { ok: true as const, numberId };
}

/** Operator registration: registers (or re-activates) a number for an org. */
export const register = internalMutation({
  args: {
    orgId: v.id("organizations"),
    wabaId: v.string(),
    phoneNumberId: v.string(),
    displayPhoneNumber: v.optional(v.string()),
    actorSubject: v.string(),
  },
  returns: registerResult,
  handler: async (ctx, args) => {
    requireOperatorSubject(args.actorSubject);
    return await registerNumber(ctx.db, args);
  },
});

/**
 * Embedded Signup registration (ADR 0014): registers a number of an org's ACTIVE connected WABA,
 * after the action verified with Meta that the number belongs to it. The WABA id comes from the
 * account row, never from the caller. `actorSubject` is the signed-in admin's verified subject.
 */
export const registerForConnection = internalMutation({
  args: {
    orgId: v.id("organizations"),
    accountId: v.id("whatsappBusinessAccounts"),
    phoneNumberId: v.string(),
    displayPhoneNumber: v.optional(v.string()),
    actorSubject: v.string(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), numberId: v.id("whatsappPhoneNumbers") }),
    v.object({
      ok: v.literal(false),
      reason: v.union(
        v.literal("invalid_id"),
        v.literal("in_use"),
        v.literal("no_org"),
        v.literal("no_account"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    requireUserSubject(args.actorSubject);
    const account = await ctx.db.get(args.accountId);
    if (account === null || account.orgId !== args.orgId || account.status !== "active") {
      return { ok: false as const, reason: "no_account" as const };
    }
    return await registerNumber(ctx.db, {
      orgId: args.orgId,
      wabaId: account.wabaId,
      phoneNumberId: args.phoneNumberId,
      ...(args.displayPhoneNumber !== undefined
        ? { displayPhoneNumber: args.displayPhoneNumber }
        : {}),
      actorSubject: args.actorSubject,
      link: { accountId: account._id },
    });
  },
});

/** Stops routing a number's webhooks to its org. History (conversations, messages) is kept. */
export const disconnect = internalMutation({
  args: { numberId: v.id("whatsappPhoneNumbers"), actorSubject: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { numberId, actorSubject }) => {
    requireOperatorSubject(actorSubject);
    const row = await ctx.db.get(numberId);
    if (row === null || row.status !== "active") return false;
    const now = Date.now();
    await ctx.db.patch(row._id, { status: "disconnected", disconnectedAt: now, updatedAt: now });
    const org = await ctx.db.get(row.orgId);
    await writeAudit(
      ctx.db,
      { orgId: row.orgId, issuer: org?.issuer ?? "", subject: actorSubject },
      {
        action: AUDIT_ACTIONS.whatsappNumberDisconnected,
        targetType: "whatsappPhoneNumber",
        targetId: row._id,
        changes: { status: { from: "active", to: "disconnected" } },
      },
    );
    return true;
  },
});
