import { v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx } from "../../_generated/server";
import {
  CredentialUnavailableError,
  withConnectionCredential,
} from "../../connections/credentialStore";
import { markConnectionNeedsReauth } from "../../connections/lifecycle";
import { AUDIT_ACTIONS, writeAudit } from "../../lib/audit";
import { apiError } from "../../lib/errors";
import {
  GRAPH_ORIGIN,
  hasInstagramMessagingPermission,
  INSTAGRAM_GRAPH_VERSION,
  UNIFIED_GRAPH_ORIGIN,
  UNIFIED_GRAPH_VERSION,
} from "../../providers/instagram/config";
import {
  isInstagramMessagingCredential,
  isInstagramUnifiedCredential,
} from "../../providers/instagram/credential";
import { classifyInstagramFailure } from "../../providers/instagram/errors";
import { RequestBudget, sendInstagram } from "../../providers/instagram/transport";
import { messagingHolder } from "./accounts";
import {
  ICE_BREAKER_PAYLOAD_PREFIX,
  ICE_BREAKER_TIMEOUT_MS,
  MAX_ICE_BREAKER_CHARS,
  MAX_ICE_BREAKERS,
} from "./config";
import { failureReason } from "./lifecycle";

/**
 * Ice breakers (ADR 0021; [doc] Instagram "Ice breakers"): up to 4 questions Instagram shows a
 * person opening a chat with the account; a tap arrives as a `messaging_postbacks` event with
 * the question as its title (payload.ts reads it as the customer's message). Admins set them from
 * the Instagram DM settings page; Meta holds them, this app keeps what it set (the account's
 * `iceBreakers`) and audits each change (a count only).
 *
 * - Set: `POST /<IG_ID>/messenger_profile` with `{platform: "instagram", ice_breakers: [{
 *   call_to_actions: [{question, payload}]}]}` [doc]; the payloads are ICE_BREAKER_1..4.
 * - Remove: `DELETE /<IG_ID>/messenger_profile` with `{fields: ["ice_breakers"]}` [doc].
 * - Unified Login: the same paths on graph.facebook.com with the system-user token [assume];
 *   Instagram Login: graph.instagram.com, as documented. The token is sent only in the header.
 * - Only for an account whose messaging is on (not disabled), held by this org, on an active
 *   connection with the messaging permission. A refused token moves the connection to
 *   needs_reauth (unless a reconnect already replaced the credential).
 */

type Tenant = { orgId: Id<"organizations">; issuer: string; subject: string };

const refusalValidator = v.union(
  v.literal("not_found"),
  v.literal("messaging_unavailable"),
  v.literal("reconnect_required"),
  v.literal("scope_missing"),
);

/** The account an ice breaker call works on, or why it cannot. */
export const iceBreakerTarget = internalQuery({
  args: { orgId: v.id("organizations"), accountId: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      accountId: v.id("instagramMessagingAccounts"),
      connectionId: v.id("connections"),
      igAccountId: v.string(),
    }),
    v.object({ ok: v.literal(false), reason: refusalValidator }),
  ),
  handler: async (ctx, { orgId, accountId }) => {
    const id = ctx.db.normalizeId("instagramMessagingAccounts", accountId);
    const account = id === null ? null : await ctx.db.get(id);
    if (account === null || account.orgId !== orgId) {
      return { ok: false as const, reason: "not_found" as const };
    }
    const holder = await messagingHolder(ctx.db, account.igAccountId);
    if (account.status === "disabled" || holder === null || holder._id !== account._id) {
      return { ok: false as const, reason: "messaging_unavailable" as const };
    }
    const connection = await ctx.db.get(account.connectionId);
    if (connection === null || connection.orgId !== orgId) {
      return { ok: false as const, reason: "messaging_unavailable" as const };
    }
    if (connection.status !== "active") {
      return { ok: false as const, reason: "reconnect_required" as const };
    }
    if (!hasInstagramMessagingPermission(connection.grantedScopes)) {
      return { ok: false as const, reason: "scope_missing" as const };
    }
    return {
      ok: true as const,
      accountId: account._id,
      connectionId: connection._id,
      igAccountId: account.igAccountId,
    };
  },
});

/** Records the ice breakers Meta accepted (null: removed), audited with the count only. */
export const recordIceBreakers = internalMutation({
  args: {
    orgId: v.id("organizations"),
    issuer: v.string(),
    subject: v.string(),
    accountId: v.id("instagramMessagingAccounts"),
    questions: v.union(v.null(), v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, { orgId, issuer, subject, accountId, questions }) => {
    const account = await ctx.db.get(accountId);
    if (account === null || account.orgId !== orgId) return null;
    const now = Date.now();
    const before = account.iceBreakers?.questions.length ?? 0;
    await ctx.db.patch(account._id, {
      iceBreakers:
        questions === null ? undefined : { questions, updatedAt: now, updatedBySubject: subject },
      updatedAt: now,
    });
    await writeAudit(
      ctx.db,
      { orgId, issuer, subject },
      {
        action:
          questions === null
            ? AUDIT_ACTIONS.instagramIceBreakersCleared
            : AUDIT_ACTIONS.instagramIceBreakersSet,
        targetType: "instagramMessagingAccount",
        targetId: account._id,
        changes: { questions: { from: before, to: questions?.length ?? 0 } },
      },
    );
    return null;
  },
});

/** Meta refused the token: the connection needs a reconnect (same credential only). */
export const markTokenRefused = internalMutation({
  args: {
    orgId: v.id("organizations"),
    connectionId: v.id("connections"),
    credentialVersion: v.number(),
    subject: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { orgId, connectionId, credentialVersion, subject }) => {
    const connection = await ctx.db.get(connectionId);
    if (
      connection !== null &&
      connection.orgId === orgId &&
      connection.credentialVersion === credentialVersion
    ) {
      await markConnectionNeedsReauth(ctx.db, connectionId, "instagram_token_invalid", subject);
    }
    return null;
  },
});

const REFUSALS: Readonly<
  Record<"messaging_unavailable" | "reconnect_required" | "scope_missing", string>
> = {
  messaging_unavailable: "Direct messages are not on for this Instagram account.",
  reconnect_required: "Instagram no longer accepts this connection. Reconnect Instagram.",
  scope_missing: "Reconnect Instagram and allow direct messages first.",
};

/** The checked questions (trimmed, 1-4, each 1-80 characters on one line, all different). */
export function checkIceBreakers(
  questions: string[],
): { ok: true; questions: string[] } | { ok: false; reason: string; field: string } {
  if (questions.length === 0 || questions.length > MAX_ICE_BREAKERS) {
    return { ok: false, reason: "ice_breaker_count", field: "questions" };
  }
  const checked: string[] = [];
  for (const [i, question] of questions.entries()) {
    const value = question.trim();
    if (value === "" || value.length > MAX_ICE_BREAKER_CHARS || /[\r\n]/.test(value)) {
      return { ok: false, reason: "ice_breaker_text", field: `questions.${i}` };
    }
    if (checked.includes(value)) {
      return { ok: false, reason: "duplicate_ice_breaker", field: `questions.${i}` };
    }
    checked.push(value);
  }
  return { ok: true, questions: checked };
}

async function requireTarget(ctx: ActionCtx, tenant: Tenant, accountId: string) {
  const target = await ctx.runQuery(internal.instagram.messaging.iceBreakers.iceBreakerTarget, {
    orgId: tenant.orgId,
    accountId,
  });
  if (!target.ok) {
    if (target.reason === "not_found") {
      throw apiError("NOT_FOUND", "No instagramMessagingAccounts record with this id.", {
        table: "instagramMessagingAccounts",
      });
    }
    throw apiError("CONFLICT", REFUSALS[target.reason], { reason: target.reason });
  }
  return target;
}

/** One messenger_profile call with the account's own token. Throws the caller-facing refusal. */
async function callProfile(
  ctx: ActionCtx,
  tenant: Tenant,
  target: { connectionId: Id<"connections">; igAccountId: string },
  method: "POST" | "DELETE",
  body: Record<string, unknown>,
): Promise<void> {
  type Result =
    { ok: true } | { ok: false; reason: string; refused: boolean; credentialVersion: number };
  let result: Result;
  try {
    result = await withConnectionCredential(
      ctx,
      target.connectionId,
      async (credential, binding) => {
        if (
          !isInstagramMessagingCredential(credential) ||
          credential.userId !== target.igAccountId
        ) {
          return { ok: false, reason: "credential_invalid", refused: false, credentialVersion: 0 };
        }
        const url = isInstagramUnifiedCredential(credential)
          ? `${UNIFIED_GRAPH_ORIGIN}/${UNIFIED_GRAPH_VERSION}/${target.igAccountId}/messenger_profile`
          : `${GRAPH_ORIGIN}/${INSTAGRAM_GRAPH_VERSION}/${target.igAccountId}/messenger_profile`;
        const response = await sendInstagram(
          "messaging",
          new URL(url),
          {
            method,
            headers: {
              Authorization: `Bearer ${credential.accessToken}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(body),
          },
          { timeoutMs: ICE_BREAKER_TIMEOUT_MS, budget: new RequestBudget(1) },
        );
        if (response.ok) {
          const answer = response.body as { result?: unknown; success?: unknown } | null;
          return answer?.result === "success" || answer?.success === true
            ? { ok: true }
            : { ok: false, reason: "unexpected_response", refused: false, credentialVersion: 0 };
        }
        return {
          ok: false,
          reason: failureReason(response.failure),
          refused: classifyInstagramFailure(response.failure).kind === "auth",
          credentialVersion: binding.credentialVersion,
        };
      },
    );
  } catch (error) {
    if (error instanceof CredentialUnavailableError) {
      throw apiError("CONFLICT", REFUSALS.reconnect_required, { reason: "reconnect_required" });
    }
    throw error;
  }
  if (result.ok) return;
  if (result.refused) {
    await ctx.runMutation(internal.instagram.messaging.iceBreakers.markTokenRefused, {
      orgId: tenant.orgId,
      connectionId: target.connectionId,
      credentialVersion: result.credentialVersion,
      subject: tenant.subject,
    });
    throw apiError("CONFLICT", REFUSALS.reconnect_required, { reason: "reconnect_required" });
  }
  throw apiError("PROVIDER_ERROR", "Instagram did not accept the change. Try again.", {
    reason: result.reason,
  });
}

/** v1/instagramMessaging:setIceBreakers. */
export async function setIceBreakersFor(
  ctx: ActionCtx,
  tenant: Tenant,
  args: { accountId: string; questions: string[] },
): Promise<void> {
  const checked = checkIceBreakers(args.questions);
  if (!checked.ok) {
    throw apiError(
      "INVALID_ARGUMENT",
      "Ice breakers are 1-4 different questions of up to 80 characters.",
      {
        field: checked.field,
        reason: checked.reason,
      },
    );
  }
  const target = await requireTarget(ctx, tenant, args.accountId);
  await callProfile(ctx, tenant, target, "POST", {
    platform: "instagram",
    ice_breakers: [
      {
        call_to_actions: checked.questions.map((question, i) => ({
          question,
          payload: `${ICE_BREAKER_PAYLOAD_PREFIX}${i + 1}`,
        })),
      },
    ],
  });
  await ctx.runMutation(internal.instagram.messaging.iceBreakers.recordIceBreakers, {
    orgId: tenant.orgId,
    issuer: tenant.issuer,
    subject: tenant.subject,
    accountId: target.accountId,
    questions: checked.questions,
  });
}

/** v1/instagramMessaging:clearIceBreakers. */
export async function clearIceBreakersFor(
  ctx: ActionCtx,
  tenant: Tenant,
  args: { accountId: string },
): Promise<void> {
  const target = await requireTarget(ctx, tenant, args.accountId);
  await callProfile(ctx, tenant, target, "DELETE", { fields: ["ice_breakers"] });
  await ctx.runMutation(internal.instagram.messaging.iceBreakers.recordIceBreakers, {
    orgId: tenant.orgId,
    issuer: tenant.issuer,
    subject: tenant.subject,
    accountId: target.accountId,
    questions: null,
  });
}
