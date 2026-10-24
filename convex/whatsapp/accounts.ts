import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type DatabaseReader,
  type DatabaseWriter,
} from "../_generated/server";
import { encryptedValidator, upsertDirectConnection } from "../connections/credentialStore";
import { markConnectionNeedsReauth } from "../connections/lifecycle";
import { AUDIT_ACTIONS, writeAudit } from "../lib/audit";
import {
  MAX_REGISTRATION_ATTEMPTS,
  REGISTRATION_COOLDOWN_MS,
  REGISTRATION_RATE_LIMIT_CODE,
  requireUserSubject,
  SIGNUP_TIMEOUT_MS,
  whatsappConnectionsEnabled,
} from "./config";
import { isNumericId } from "./payload";
import { numberAvailabilityOf, registerNumber } from "./phoneNumbers";
import { onboardingTypeValidator } from "./validators";

/**
 * WhatsApp connections (ADR 0014): the database side of Embedded Signup.
 *
 * The signup action (convex/whatsapp/signup.ts) exchanges the signup code, verifies with Meta
 * that the token was granted the WABA and that the number belongs to it, encrypts the business
 * token and the registration PIN for (orgId, "whatsapp", wabaId), and then calls
 * `recordConnection`. This module never sees plaintext and never calls Meta.
 *
 * - The org and actor come from the caller's verified JWT (passed on by the action), never from
 *   the browser. The actor must be a signed-in user, never an operator or system label.
 * - One connection and one account row per (org, WABA). The WABA id is the connection key: it
 *   is the asset Meta lets us verify (the owning business is not verifiable).
 * - A WABA is active in at most one org (D10): another org's active WABA is refused before
 *   anything is written, through the approved global index `by_waba_status`.
 * - The signup's number is routed in the SAME transaction as the connection and account: a
 *   number that another org took meanwhile (or an operator-managed one) refuses the whole
 *   write, so no connection or account is ever left without its number.
 * - A signup that read the stored PIN refuses to write if another signup replaced the
 *   credential meanwhile (`expectedCredentialVersion`): a stored PIN is never overwritten.
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
    /** Verified with Meta before this call (token grant + read access). */
    wabaId: v.string(),
    onboardingType: onboardingTypeValidator,
    /** WABA name as read from Meta; optional. */
    displayName: v.optional(v.string()),
    grantedScopes: v.array(v.string()),
    /** Token expiry from Meta's token inspection; absent = does not expire. */
    tokenExpiresAt: v.optional(v.number()),
    /** Business token and PIN encrypted for (orgId, "whatsapp", wabaId). */
    encrypted: encryptedValidator,
    /**
     * The connection's credentialVersion when the action read the stored PIN (null: there was
     * no connection). Refused if it changed meanwhile. Absent: no check (internal callers
     * that never read a PIN).
     */
    expectedCredentialVersion: v.optional(v.union(v.null(), v.number())),
    /** The number to route to this org with the account, in the same transaction. */
    number: v.optional(
      v.object({ phoneNumberId: v.string(), displayPhoneNumber: v.optional(v.string()) }),
    ),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      connectionId: v.id("connections"),
      accountId: v.id("whatsappBusinessAccounts"),
      numberId: v.optional(v.id("whatsappPhoneNumbers")),
      reconnected: v.boolean(),
    }),
    v.object({
      ok: v.literal(false),
      reason: v.union(
        v.literal("connections_disabled"),
        v.literal("invalid_id"),
        v.literal("no_org"),
        v.literal("waba_in_use"),
        v.literal("credential_changed"),
        v.literal("phone_number_in_use"),
        v.literal("phone_number_operator_managed"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    requireUserSubject(args.actorSubject);
    if (!whatsappConnectionsEnabled()) {
      return { ok: false as const, reason: "connections_disabled" as const };
    }
    if (!isNumericId(args.wabaId)) return { ok: false as const, reason: "invalid_id" as const };
    if (args.number !== undefined && !isNumericId(args.number.phoneNumberId)) {
      return { ok: false as const, reason: "invalid_id" as const };
    }
    if ((await ctx.db.get(args.orgId)) === null) {
      return { ok: false as const, reason: "no_org" as const };
    }
    // Another org's WABA wins; its identity is never revealed.
    if (await wabaActiveElsewhere(ctx.db, args.wabaId, args.orgId)) {
      return { ok: false as const, reason: "waba_in_use" as const };
    }
    if (args.expectedCredentialVersion !== undefined) {
      const existing = await ctx.db
        .query("connections")
        .withIndex("by_org_provider_identity", (q) =>
          q.eq("orgId", args.orgId).eq("provider", "whatsapp").eq("externalUserId", args.wabaId),
        )
        .unique();
      if ((existing?.credentialVersion ?? null) !== args.expectedCredentialVersion) {
        return { ok: false as const, reason: "credential_changed" as const };
      }
    }
    if (args.number !== undefined) {
      const availability = await numberAvailabilityOf(
        ctx.db,
        args.orgId,
        args.number.phoneNumberId,
      );
      if (availability === "in_use") {
        return { ok: false as const, reason: "phone_number_in_use" as const };
      }
      if (availability === "operator_managed") {
        return { ok: false as const, reason: "phone_number_operator_managed" as const };
      }
    }

    const now = Date.now();
    const { connectionId, reconnected } = await upsertDirectConnection(ctx.db, {
      orgId: args.orgId,
      provider: "whatsapp",
      externalUserId: args.wabaId,
      ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
      grantedScopes: args.grantedScopes,
      ...(args.tokenExpiresAt !== undefined ? { tokenExpiresAt: args.tokenExpiresAt } : {}),
      connectedBySubject: args.actorSubject,
      encrypted: args.encrypted,
      now,
    });

    const account = await ctx.db
      .query("whatsappBusinessAccounts")
      .withIndex("by_org_waba", (q) => q.eq("orgId", args.orgId).eq("wabaId", args.wabaId))
      .unique();
    let accountId: Id<"whatsappBusinessAccounts">;
    if (account) {
      accountId = account._id;
      // A new signup re-runs the webhook subscription (Meta's post-signup step 2).
      await ctx.db.patch(account._id, {
        connectionId,
        onboardingType: args.onboardingType,
        status: "active",
        connectedBySubject: args.actorSubject,
        subscribedAt: undefined,
        setupError: undefined,
        disconnectedAt: undefined,
        updatedAt: now,
      });
    } else {
      accountId = await ctx.db.insert("whatsappBusinessAccounts", {
        orgId: args.orgId,
        wabaId: args.wabaId,
        connectionId,
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

    let numberId: Id<"whatsappPhoneNumbers"> | undefined;
    if (args.number !== undefined) {
      const routed = await registerNumber(ctx.db, {
        orgId: args.orgId,
        wabaId: args.wabaId,
        phoneNumberId: args.number.phoneNumberId,
        ...(args.number.displayPhoneNumber !== undefined
          ? { displayPhoneNumber: args.number.displayPhoneNumber }
          : {}),
        actorSubject: args.actorSubject,
        link: { accountId },
      });
      // Checked above in this transaction; failing here rolls back every write of this call.
      if (!routed.ok) throw new Error(`Number routing failed after its check: ${routed.reason}`);
      numberId = routed.numberId;
    }
    return {
      ok: true as const,
      connectionId,
      accountId,
      ...(numberId !== undefined ? { numberId } : {}),
      reconnected,
    };
  },
});

// ---------------------------------------------------------------------------
// Setup progress (webhook subscription and Cloud API registration at Meta)
// ---------------------------------------------------------------------------

export type SetupProgress = {
  status: "connected" | "action_required" | "reauthorization_required" | "disconnected";
  nextStep?: "subscribe" | "register";
  /** Set when the status itself has a reason (no active number); else the latest failure. */
  reason?: string;
};

/**
 * Where an account's setup at Meta stands (shared by the signup action and the account list):
 * connected once subscribed and every active number is registered; otherwise the next step.
 * A connection that is not active (its token expired or Meta refused it) needs a new signup
 * first: nothing can be retried with its token. An account without an active number has
 * nothing to set up (`no_active_number`; a new signup adds one); it is never subscribed.
 */
export function setupProgress(account: {
  active: boolean;
  connectionActive: boolean;
  subscribed: boolean;
  numbersRegistered: boolean[];
}): SetupProgress {
  if (!account.active) return { status: "disconnected" };
  if (!account.connectionActive) return { status: "reauthorization_required" };
  if (account.numbersRegistered.length === 0) {
    return { status: "action_required", reason: "no_active_number" };
  }
  if (!account.subscribed) return { status: "action_required", nextStep: "subscribe" };
  return account.numbersRegistered.every(Boolean)
    ? { status: "connected" }
    : { status: "action_required", nextStep: "register" };
}

const numberStateValidator = v.object({
  numberId: v.id("whatsappPhoneNumbers"),
  phoneNumberId: v.string(),
  registered: v.boolean(),
  /** Another call holds this number's registration claim right now (claimRegistration). */
  registrationInProgress: v.boolean(),
});

/**
 * How long a registration claim holds: twice the call's own timeout, so a claim always outlives
 * the call it protects, and a crashed action's claim expires on its own.
 */
export const REGISTRATION_CLAIM_MS = 2 * SIGNUP_TIMEOUT_MS;

/** Whether the account's connection is active (same org). */
async function connectionActiveOf(db: DatabaseReader, account: Doc<"whatsappBusinessAccounts">) {
  const connection = await db.get(account.connectionId);
  return (
    connection !== null && connection.orgId === account.orgId && connection.status === "active"
  );
}

/** The org's own account (by an untrusted id) with its numbers, or null. */
async function ownAccount(db: DatabaseReader, orgId: Id<"organizations">, accountId: string) {
  const id = db.normalizeId("whatsappBusinessAccounts", accountId);
  const account = id === null ? null : await db.get(id);
  return account !== null && account.orgId === orgId ? account : null;
}

async function accountNumbers(db: DatabaseReader, account: Doc<"whatsappBusinessAccounts">) {
  return await db
    .query("whatsappPhoneNumbers")
    .withIndex("by_org_account", (q) => q.eq("orgId", account.orgId).eq("accountId", account._id))
    .collect();
}

/** What a retry needs: never the credential itself (withConnectionCredential reads it). */
export const loadSetupState = internalQuery({
  args: { orgId: v.id("organizations"), accountId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      accountId: v.id("whatsappBusinessAccounts"),
      connectionId: v.id("connections"),
      wabaId: v.string(),
      status: v.union(v.literal("active"), v.literal("disconnected")),
      /** False once the token expired or Meta refused it (connection needs_reauth). */
      connectionActive: v.boolean(),
      subscribed: v.boolean(),
      /** Sanitized reason code of the latest failed step, if any. */
      setupReason: v.optional(v.string()),
      numbers: v.array(numberStateValidator),
    }),
  ),
  handler: async (ctx, { orgId, accountId }) => {
    const account = await ownAccount(ctx.db, orgId, accountId);
    if (account === null) return null;
    const numbers = (await accountNumbers(ctx.db, account)).filter((n) => n.status === "active");
    const now = Date.now();
    return {
      accountId: account._id,
      connectionId: account.connectionId,
      wabaId: account.wabaId,
      status: account.status,
      connectionActive: await connectionActiveOf(ctx.db, account),
      subscribed: account.subscribedAt !== undefined,
      ...(account.setupError !== undefined ? { setupReason: account.setupError.reason } : {}),
      numbers: numbers.map((n) => ({
        numberId: n._id,
        phoneNumberId: n.phoneNumberId,
        registered: n.platformRegisteredAt !== undefined,
        registrationInProgress: (n.registrationClaimedUntil ?? 0) > now,
      })),
    };
  },
});

/**
 * The signup's early number check (before any credential is read or stored), see
 * phoneNumbers.ts numberAvailabilityOf. `recordConnection` enforces it again in the same
 * transaction as its writes.
 */
export const numberAvailability = internalQuery({
  args: { orgId: v.id("organizations"), phoneNumberId: v.string() },
  returns: v.union(v.literal("available"), v.literal("in_use"), v.literal("operator_managed")),
  handler: async (ctx, { orgId, phoneNumberId }) =>
    await numberAvailabilityOf(ctx.db, orgId, phoneNumberId),
});

/**
 * The org's existing connection for a WABA, to keep its PIN on a reconnect: null if there is
 * none, otherwise its id, whether it is revoked (its credential is gone) and its
 * credentialVersion (passed back to recordConnection as `expectedCredentialVersion`).
 */
export const findConnectionForWaba = internalQuery({
  args: { orgId: v.id("organizations"), wabaId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      connectionId: v.id("connections"),
      revoked: v.boolean(),
      credentialVersion: v.number(),
    }),
  ),
  handler: async (ctx, { orgId, wabaId }) => {
    const connection = await ctx.db
      .query("connections")
      .withIndex("by_org_provider_identity", (q) =>
        q.eq("orgId", orgId).eq("provider", "whatsapp").eq("externalUserId", wabaId),
      )
      .unique();
    if (connection === null) return null;
    return {
      connectionId: connection._id,
      revoked: connection.status === "revoked",
      credentialVersion: connection.credentialVersion,
    };
  },
});

async function activeAccountOf(
  db: DatabaseWriter,
  orgId: Id<"organizations">,
  accountId: Id<"whatsappBusinessAccounts">,
) {
  const account = await db.get(accountId);
  return account !== null && account.orgId === orgId && account.status === "active"
    ? account
    : null;
}

/** Records the outcome of the webhook subscription call. Returns false if the account is gone. */
export const recordSubscribeResult = internalMutation({
  args: {
    orgId: v.id("organizations"),
    accountId: v.id("whatsappBusinessAccounts"),
    /** Absent = success; otherwise a sanitized reason code. */
    failure: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, { orgId, accountId, failure }) => {
    const account = await activeAccountOf(ctx.db, orgId, accountId);
    if (account === null) return false;
    const now = Date.now();
    await ctx.db.patch(
      account._id,
      failure === undefined
        ? { subscribedAt: now, setupError: undefined, updatedAt: now }
        : { setupError: { step: "subscribe", reason: failure, at: now }, updatedAt: now },
    );
    return true;
  },
});

/**
 * Claims one number's next registration call; the ONLY way to get permission for one. In one
 * transaction (concurrent claims are serialized; at most one wins): refused if the number is
 * already registered, another call holds a live claim, it reached MAX_REGISTRATION_ATTEMPTS
 * (support has to step in) or it is inside Meta's rate-limit window. A won claim counts the
 * attempt before the call is made (an interrupted call still counts) and holds for
 * REGISTRATION_CLAIM_MS; recordRegisterResult releases it.
 */
export const claimRegistration = internalMutation({
  args: {
    orgId: v.id("organizations"),
    accountId: v.id("whatsappBusinessAccounts"),
    numberId: v.id("whatsappPhoneNumbers"),
  },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({
      ok: v.literal(false),
      reason: v.union(
        v.literal("gone"),
        v.literal("registered"),
        v.literal("registration_in_progress"),
        v.literal("registration_attempts_exhausted"),
        v.literal("registration_rate_limited"),
      ),
    }),
  ),
  handler: async (ctx, { orgId, accountId, numberId }) => {
    const account = await activeAccountOf(ctx.db, orgId, accountId);
    const number = await ctx.db.get(numberId);
    if (
      account === null ||
      number === null ||
      number.orgId !== orgId ||
      number.accountId !== account._id ||
      number.status !== "active"
    ) {
      return { ok: false as const, reason: "gone" as const };
    }
    if (number.platformRegisteredAt !== undefined) {
      return { ok: false as const, reason: "registered" as const };
    }
    const now = Date.now();
    if ((number.registrationClaimedUntil ?? 0) > now) {
      return { ok: false as const, reason: "registration_in_progress" as const };
    }
    const limit =
      (number.registrationAttempts ?? 0) >= MAX_REGISTRATION_ATTEMPTS
        ? ("registration_attempts_exhausted" as const)
        : (number.registrationBlockedUntil ?? 0) > now
          ? ("registration_rate_limited" as const)
          : null;
    if (limit !== null) {
      await ctx.db.patch(account._id, {
        setupError: { step: "register", reason: limit, at: now },
        updatedAt: now,
      });
      return { ok: false as const, reason: limit };
    }
    await ctx.db.patch(number._id, {
      registrationAttempts: (number.registrationAttempts ?? 0) + 1,
      registrationClaimedUntil: now + REGISTRATION_CLAIM_MS,
      updatedAt: now,
    });
    return { ok: true as const };
  },
});

/**
 * Meta refused the business token during setup (TOKEN_AUTH_ERROR_CODES): records the step and
 * moves the connection to needs_reauth (audited, sanitized error). The admin must sign up
 * again; no retry uses the token. `actorSubject` is the signed-in admin whose call found it.
 */
export const recordReauthRequired = internalMutation({
  args: {
    orgId: v.id("organizations"),
    accountId: v.id("whatsappBusinessAccounts"),
    step: v.union(v.literal("subscribe"), v.literal("register")),
    actorSubject: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, { orgId, accountId, step, actorSubject }) => {
    requireUserSubject(actorSubject);
    const account = await activeAccountOf(ctx.db, orgId, accountId);
    if (account === null) return false;
    const now = Date.now();
    await ctx.db.patch(account._id, {
      setupError: { step, reason: "token_invalid", at: now },
      updatedAt: now,
    });
    await markConnectionNeedsReauth(
      ctx.db,
      account.connectionId,
      "whatsapp_token_invalid",
      actorSubject,
    );
    return true;
  },
});

/**
 * Records the outcome of a claimed registration call (the attempt was counted by the claim)
 * and releases the claim.
 */
export const recordRegisterResult = internalMutation({
  args: {
    orgId: v.id("organizations"),
    accountId: v.id("whatsappBusinessAccounts"),
    numberId: v.id("whatsappPhoneNumbers"),
    failure: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, { orgId, accountId, numberId, failure }) => {
    const account = await activeAccountOf(ctx.db, orgId, accountId);
    const number = await ctx.db.get(numberId);
    if (account === null || number === null || number.orgId !== orgId) return false;
    if (number.accountId !== account._id) return false;
    const now = Date.now();
    const rateLimited = failure === `meta_${REGISTRATION_RATE_LIMIT_CODE}`;
    await ctx.db.patch(number._id, {
      registrationClaimedUntil: undefined,
      ...(failure === undefined
        ? { platformRegisteredAt: now, registrationBlockedUntil: undefined }
        : {}),
      ...(rateLimited ? { registrationBlockedUntil: now + REGISTRATION_COOLDOWN_MS } : {}),
      updatedAt: now,
    });
    await ctx.db.patch(
      account._id,
      failure === undefined
        ? {
            ...(account.setupError?.step === "register" ? { setupError: undefined } : {}),
            updatedAt: now,
          }
        : { setupError: { step: "register", reason: failure, at: now }, updatedAt: now },
    );
    return true;
  },
});
