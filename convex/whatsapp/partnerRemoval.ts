import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import {
  CredentialUnavailableError,
  deleteCredential,
  withConnectionCredential,
} from "../connections/credentialStore";
import { AUDIT_ACTIONS, SYSTEM_WHATSAPP_WEBHOOK_SUBJECT, writeAudit } from "../lib/audit";
import {
  MAX_PARTNER_REMOVAL_CHECKS,
  WABA_ACCESS_REFUSED_CODES,
  WABA_NOT_ACCESSIBLE,
} from "./config";
import { readWaba, type GraphFailure, type GraphOutcome } from "./graph";
import { disconnectNumberRow } from "./phoneNumbers";
import { parseCredential, tokenRefused } from "./signup";

/**
 * Meta's `account_update` `PARTNER_REMOVED` webhook (ADR 0014 B4b).
 *
 * Meta documents the event as a WABA being unshared with a Solution Partner, not necessarily
 * us, and does not document which apps receive it. So the event alone changes nothing: for the
 * one org whose account holds the WABA active (approved global index
 * whatsappBusinessAccounts.by_waba_status; the WABA id was verified with Meta at signup, never
 * taken from the browser or the payload's other fields), the webhook reads the WABA with that
 * org's own stored token. Only when Meta refuses (the token, or access to the WABA) is the
 * account disconnected, in one transaction (`applyPartnerRemoval`): its numbers stop routing,
 * the connection is revoked and the credential deleted. Nothing is called at Meta to clean up:
 * our access is gone.
 *
 * - Meta still answers the read: another partner was removed, or the event is older than a
 *   reconnect. Acknowledged; nothing changes.
 * - Anything else (network, timeout, 5xx, rate limit, a credential that cannot be decrypted):
 *   the delivery is answered 500 and Meta retries it (for up to 7 days, Meta docs); checks
 *   already applied find nothing to do by then.
 * - Repeats find no active account: no call, no write. The write re-checks the account,
 *   connection and credential version the check used, so a reconnect or a disconnect made
 *   meanwhile is never undone by an older check.
 * - Only the matched org's account, its connection and its own numbers are written; operator-
 *   managed numbers and other orgs' rows never are. No Meta write call is ever made here.
 */

export type Verdict = "access_remains" | "access_lost" | "retry";

const candidateValidator = v.object({
  orgId: v.id("organizations"),
  accountId: v.id("whatsappBusinessAccounts"),
  connectionId: v.id("connections"),
  /** False once Meta refused the token or it expired (needs_reauth): access is lost already. */
  connectionActive: v.boolean(),
  credentialVersion: v.number(),
});

/**
 * The one active account holding the WABA, or null: none, or (never, by the one-org-per-WABA
 * invariant) more than one, which is ignored rather than guessed at. Reads the approved global
 * index; the ids go back to the webhook action, which writes only through applyPartnerRemoval.
 */
export const partnerRemovalCandidate = internalQuery({
  args: { wabaId: v.string() },
  returns: v.union(v.null(), candidateValidator),
  handler: async (ctx, { wabaId }) => {
    const active = await ctx.db
      .query("whatsappBusinessAccounts")
      .withIndex("by_waba_status", (q) => q.eq("wabaId", wabaId).eq("status", "active"))
      .take(2);
    if (active.length !== 1) return null;
    const account = active[0]!;
    const connection = await ctx.db.get(account.connectionId);
    if (connection === null || connection.orgId !== account.orgId) return null;
    return {
      orgId: account.orgId,
      accountId: account._id,
      connectionId: connection._id,
      connectionActive: connection.status === "active",
      credentialVersion: connection.credentialVersion,
    };
  },
});

function wabaAccessRefused(failure: GraphFailure): boolean {
  if (failure.kind !== "http" || failure.metaCode === undefined) return false;
  return (
    WABA_ACCESS_REFUSED_CODES.has(failure.metaCode) ||
    (failure.metaCode === WABA_NOT_ACCESSIBLE.code &&
      failure.metaSubcode === WABA_NOT_ACCESSIBLE.subcode)
  );
}

/** Meta's answer to reading the WABA with the org's token. */
export function verdictOf(result: GraphOutcome): Verdict {
  if (result.ok) return "access_remains";
  if (tokenRefused(result.failure) || wabaAccessRefused(result.failure)) return "access_lost";
  return "retry";
}

type Candidate = Infer<typeof candidateValidator>;

/** Reads the WABA with the candidate's stored token. Never throws. */
async function checkAccess(
  ctx: ActionCtx,
  candidate: Candidate,
  wabaId: string,
  appSecret: string,
): Promise<{ verdict: Verdict; credentialVersion: number }> {
  const lost = { verdict: "access_lost" as const, credentialVersion: candidate.credentialVersion };
  if (!candidate.connectionActive) return lost;
  try {
    return await withConnectionCredential(ctx, candidate.connectionId, async (credential, at) => {
      const parsed = parseCredential(credential);
      // A stored credential without a usable token can reach nothing.
      const verdict =
        parsed === null
          ? ("access_lost" as const)
          : verdictOf(await readWaba(wabaId, { accessToken: parsed.accessToken, appSecret }));
      return { verdict, credentialVersion: at.credentialVersion };
    });
  } catch (error) {
    // No credential stored: nothing can reach the WABA. Anything else (the connection changed
    // since the lookup, a key or decryption failure): checked again on Meta's retry.
    if (error instanceof CredentialUnavailableError && error.reason !== "inactive") return lost;
    return { verdict: "retry", credentialVersion: candidate.credentialVersion };
  }
}

/**
 * Meta confirmed the removal: disconnects the account in one transaction, unless the account,
 * its connection or the credential version changed since the check (`superseded`).
 */
export const applyPartnerRemoval = internalMutation({
  args: {
    orgId: v.id("organizations"),
    accountId: v.id("whatsappBusinessAccounts"),
    connectionId: v.id("connections"),
    /** The credential generation the check used. */
    credentialVersion: v.number(),
  },
  returns: v.union(v.literal("removed"), v.literal("superseded")),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    const connection = await ctx.db.get(args.connectionId);
    if (
      account === null ||
      account.orgId !== args.orgId ||
      account.status !== "active" ||
      account.connectionId !== args.connectionId ||
      connection === null ||
      connection.orgId !== args.orgId ||
      connection.credentialVersion !== args.credentialVersion
    ) {
      return "superseded" as const;
    }
    const org = await ctx.db.get(args.orgId);
    const actor = {
      orgId: args.orgId,
      issuer: org?.issuer ?? "",
      subject: SYSTEM_WHATSAPP_WEBHOOK_SUBJECT,
    };
    const now = Date.now();

    const numbers = await ctx.db
      .query("whatsappPhoneNumbers")
      .withIndex("by_org_account", (q) => q.eq("orgId", args.orgId).eq("accountId", account._id))
      .collect();
    const routed = numbers.filter((number) => number.status === "active");
    for (const number of routed) await disconnectNumberRow(ctx.db, number, actor, now);

    if (connection.status !== "revoked") {
      await ctx.db.patch(connection._id, { status: "revoked", revokedAt: now, updatedAt: now });
      await writeAudit(ctx.db, actor, {
        action: AUDIT_ACTIONS.connectionDisconnected,
        targetType: "connection",
        targetId: connection._id,
        changes: {
          status: { from: connection.status, to: "revoked" },
          routedNumbers: { from: routed.length, to: 0 },
        },
      });
    }
    // Nothing at Meta needs the token any more: our access to the WABA is gone.
    if (await deleteCredential(ctx.db, args.orgId, connection._id)) {
      await writeAudit(ctx.db, actor, {
        action: AUDIT_ACTIONS.credentialDeleted,
        targetType: "connection",
        targetId: connection._id,
      });
    }
    await ctx.db.patch(account._id, {
      status: "disconnected",
      disconnectedAt: now,
      disconnectedBySubject: SYSTEM_WHATSAPP_WEBHOOK_SUBJECT,
      setupError: undefined,
      updatedAt: now,
    });
    await writeAudit(ctx.db, actor, {
      action: AUDIT_ACTIONS.whatsappPartnerRemoved,
      targetType: "whatsappBusinessAccount",
      targetId: account._id,
      changes: {
        status: { from: "active", to: "disconnected" },
        routedNumbers: { from: routed.length, to: 0 },
      },
    });
    return "removed" as const;
  },
});

/**
 * Handles a delivery's partner removals (payload.ts `partnerRemovals`), in order. True when all
 * are settled; false when the delivery must be answered 500 so that Meta retries it: a check
 * could not be made, or more than MAX_PARTNER_REMOVAL_CHECKS WABAs needed one (the rest are
 * checked on the retry, when the settled ones find nothing to do).
 */
export async function handlePartnerRemovals(
  ctx: ActionCtx,
  wabaIds: string[],
  appSecret: string,
): Promise<boolean> {
  let settled = true;
  let checks = 0;
  for (const wabaId of wabaIds) {
    const candidate = await ctx.runQuery(internal.whatsapp.partnerRemoval.partnerRemovalCandidate, {
      wabaId,
    });
    if (candidate === null) continue;
    if (checks === MAX_PARTNER_REMOVAL_CHECKS) return false;
    checks++;
    const { verdict, credentialVersion } = await checkAccess(ctx, candidate, wabaId, appSecret);
    if (verdict === "retry") settled = false;
    if (verdict !== "access_lost") continue;
    await ctx.runMutation(internal.whatsapp.partnerRemoval.applyPartnerRemoval, {
      orgId: candidate.orgId,
      accountId: candidate.accountId,
      connectionId: candidate.connectionId,
      credentialVersion,
    });
  }
  return settled;
}
