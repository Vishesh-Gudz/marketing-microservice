import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { withConnectionCredential } from "../connections/credentialStore";
import { AUDIT_ACTIONS, writeAudit } from "../lib/audit";
import { apiError } from "../lib/errors";
import { configuredSecret } from "../messaging/signature";
import { requireUserSubject, WHATSAPP_ENV } from "./config";
import {
  createMessageTemplate,
  deleteMessageTemplate,
  isSuccess,
  listMessageTemplates,
  type CreatedTemplate,
  type GraphFailure,
} from "./graph";
import { failureReason, parseCredential, tokenRefused } from "./signup";
import { buildTemplateRequest, type TemplateDraft } from "./templateDrafts";
import { parseTemplate, type ParsedTemplate } from "./templates";

/**
 * WhatsApp template management (ADR 0020): listing every template of one of the caller's
 * WhatsApp Business Accounts, submitting a new one for Meta's review, and deleting one (one
 * language). Meta is the only store: nothing about templates is kept here except the audit
 * entries of creations and deletions (name, language and category only, never the text).
 *
 * - The account comes from an untrusted id and must be the caller's own (`templateAccount`), not
 *   disconnected, with an active connection; its stored business token is used, never returned.
 * - A draft is checked completely (convex/whatsapp/templateDrafts.ts) before Meta is called.
 * - Meta refusing the token marks the connection needs_reauth (`reconnect_required`); any other
 *   Meta failure is reported by kind and code only (`meta_<code>` or `meta_<code>_<subcode>`).
 */

const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_ID = /^\d{1,32}$/;

type Tenant = { orgId: Id<"organizations">; issuer: string; subject: string };

/** The caller's account a template call works on, or null (unknown or another org's). */
export const templateAccount = internalQuery({
  args: { orgId: v.id("organizations"), accountId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      accountId: v.id("whatsappBusinessAccounts"),
      connectionId: v.id("connections"),
      wabaId: v.string(),
      active: v.boolean(),
      connectionActive: v.boolean(),
    }),
  ),
  handler: async (ctx, { orgId, accountId }) => {
    const id = ctx.db.normalizeId("whatsappBusinessAccounts", accountId);
    const account = id === null ? null : await ctx.db.get(id);
    if (account === null || account.orgId !== orgId) return null;
    const connection = await ctx.db.get(account.connectionId);
    return {
      accountId: account._id,
      connectionId: account.connectionId,
      wabaId: account.wabaId,
      active: account.status === "active",
      connectionActive:
        connection !== null && connection.orgId === orgId && connection.status === "active",
    };
  },
});

/** Audits a template submitted for review or deleted (by the signed-in admin). */
export const recordTemplateChange = internalMutation({
  args: {
    orgId: v.id("organizations"),
    issuer: v.string(),
    actorSubject: v.string(),
    accountId: v.id("whatsappBusinessAccounts"),
    change: v.union(v.literal("created"), v.literal("deleted")),
    templateId: v.string(),
    name: v.string(),
    language: v.optional(v.string()),
    category: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireUserSubject(args.actorSubject);
    const account = await ctx.db.get(args.accountId);
    if (account === null || account.orgId !== args.orgId) return null;
    const created = args.change === "created";
    await writeAudit(
      ctx.db,
      { orgId: args.orgId, issuer: args.issuer, subject: args.actorSubject },
      {
        action: created
          ? AUDIT_ACTIONS.whatsappTemplateCreated
          : AUDIT_ACTIONS.whatsappTemplateDeleted,
        targetType: "whatsappBusinessAccount",
        targetId: account._id,
        changes: {
          template: created ? { from: null, to: args.name } : { from: args.name, to: null },
          templateId: created
            ? { from: null, to: args.templateId }
            : { from: args.templateId, to: null },
          ...(args.language !== undefined
            ? {
                language: created
                  ? { from: null, to: args.language }
                  : { from: args.language, to: null },
              }
            : {}),
          ...(args.category !== undefined ? { category: { from: null, to: args.category } } : {}),
        },
      },
    );
    return null;
  },
});

type Account = {
  accountId: Id<"whatsappBusinessAccounts">;
  connectionId: Id<"connections">;
  wabaId: string;
};

/** The caller's usable account, or the refusal for it. */
async function requireAccount(ctx: ActionCtx, tenant: Tenant, accountId: string): Promise<Account> {
  const found = await ctx.runQuery(internal.whatsapp.templateAdmin.templateAccount, {
    orgId: tenant.orgId,
    accountId,
  });
  if (found === null) throw apiError("NOT_FOUND", "No WhatsApp account with this id.");
  if (!found.active) {
    throw apiError("CONFLICT", "This WhatsApp account is disconnected.", {
      reason: "account_disconnected",
    });
  }
  if (!found.connectionActive) {
    throw apiError("CONFLICT", "Meta no longer accepts this connection. Connect WhatsApp again.", {
      reason: "reconnect_required",
    });
  }
  return { accountId: found.accountId, connectionId: found.connectionId, wabaId: found.wabaId };
}

/** Runs one Meta call with the account's stored token. Never returns the token. */
async function withWabaToken<T>(
  ctx: ActionCtx,
  account: Account,
  call: (auth: { accessToken: string; appSecret: string }) => Promise<T>,
): Promise<T> {
  const appSecret = configuredSecret(process.env[WHATSAPP_ENV.appSecret]);
  if (appSecret === null) {
    throw apiError("PROVIDER_ERROR", "WhatsApp is not set up on this service.", {
      reason: "not_configured",
    });
  }
  let result: { value: T } | null;
  try {
    result = await withConnectionCredential(ctx, account.connectionId, async (credential) => {
      const parsed = parseCredential(credential);
      return parsed === null
        ? null
        : { value: await call({ accessToken: parsed.accessToken, appSecret }) };
    });
  } catch {
    result = null;
  }
  if (result === null) {
    throw apiError("INTERNAL", "The stored WhatsApp connection could not be read.", {
      reason: "credential_unavailable",
    });
  }
  return result.value;
}

/** A Meta failure as the refusal the caller sees; a refused token needs a new signup. */
async function metaRefusal(
  ctx: ActionCtx,
  tenant: Tenant,
  account: Account,
  failure: GraphFailure,
  message: string,
): Promise<never> {
  if (tokenRefused(failure)) {
    await ctx.runMutation(internal.whatsapp.outbound.markTokenRefused, {
      orgId: tenant.orgId,
      connectionId: account.connectionId,
      actorSubject: tenant.subject,
    });
    throw apiError("CONFLICT", "Meta no longer accepts this connection. Connect WhatsApp again.", {
      reason: "reconnect_required",
    });
  }
  const reason =
    failure.kind === "http" && failure.metaCode !== undefined && failure.metaSubcode !== undefined
      ? `meta_${failure.metaCode}_${failure.metaSubcode}`
      : failureReason(failure);
  // Meta answered and refused (4xx): the request itself. Anything else may be retried.
  if (failure.kind === "http" && (failure.status ?? 0) < 500) {
    throw apiError("CONFLICT", message, { reason, retryable: false });
  }
  throw apiError("PROVIDER_ERROR", "Meta did not answer as expected. Try again.", {
    reason,
    retryable: true,
  });
}

/** v1/whatsapp:listAccountTemplates. Every template of the account, of every status. */
export async function listAccountTemplatesFor(
  ctx: ActionCtx,
  tenant: Tenant,
  accountId: string,
): Promise<{ templates: ParsedTemplate[]; complete: boolean }> {
  const account = await requireAccount(ctx, tenant, accountId);
  const result = await withWabaToken(ctx, account, (auth) =>
    listMessageTemplates(account.wabaId, auth),
  );
  if (!result.ok) {
    return await metaRefusal(ctx, tenant, account, result.failure, "Meta refused the listing.");
  }
  return {
    templates: result.templates.map(parseTemplate).filter((t): t is ParsedTemplate => t !== null),
    complete: result.complete,
  };
}

/** v1/whatsapp:createTemplate. Checks the draft, then submits it for Meta's review. */
export async function createTemplateFor(
  ctx: ActionCtx,
  tenant: Tenant,
  args: { accountId: string; draft: TemplateDraft },
): Promise<CreatedTemplate & { name: string; language: string }> {
  const account = await requireAccount(ctx, tenant, args.accountId);
  const built = buildTemplateRequest(args.draft);
  if (!built.ok) {
    throw apiError("INVALID_ARGUMENT", "The template does not follow WhatsApp's rules.", {
      field: built.field,
      reason: built.reason,
    });
  }
  const name = built.request.name as string;
  const result = await withWabaToken(ctx, account, (auth) =>
    createMessageTemplate(account.wabaId, built.request, auth),
  );
  if (!result.ok) {
    return await metaRefusal(ctx, tenant, account, result.failure, "Meta refused this template.");
  }
  await ctx.runMutation(internal.whatsapp.templateAdmin.recordTemplateChange, {
    orgId: tenant.orgId,
    issuer: tenant.issuer,
    actorSubject: tenant.subject,
    accountId: account.accountId,
    change: "created",
    templateId: result.template.id,
    name,
    language: args.draft.language,
    category: result.template.category ?? args.draft.category,
  });
  return { ...result.template, name, language: args.draft.language };
}

/** v1/whatsapp:deleteTemplate. Deletes one template in one language at Meta. */
export async function deleteTemplateFor(
  ctx: ActionCtx,
  tenant: Tenant,
  args: { accountId: string; templateId: string; name: string; language?: string },
): Promise<void> {
  if (!TEMPLATE_ID.test(args.templateId)) {
    throw apiError("INVALID_ARGUMENT", "templateId is not a template id.", {
      field: "templateId",
    });
  }
  if (!TEMPLATE_NAME.test(args.name)) {
    throw apiError("INVALID_ARGUMENT", "name is not a template name.", { field: "name" });
  }
  const account = await requireAccount(ctx, tenant, args.accountId);
  const result = await withWabaToken(ctx, account, (auth) =>
    deleteMessageTemplate(account.wabaId, { id: args.templateId, name: args.name }, auth),
  );
  if (!result.ok) {
    return await metaRefusal(ctx, tenant, account, result.failure, "Meta refused the deletion.");
  }
  if (!isSuccess(result.body)) {
    throw apiError("PROVIDER_ERROR", "Meta did not confirm the deletion. Check the list.", {
      reason: "unexpected_response",
      retryable: true,
    });
  }
  await ctx.runMutation(internal.whatsapp.templateAdmin.recordTemplateChange, {
    orgId: tenant.orgId,
    issuer: tenant.issuer,
    actorSubject: tenant.subject,
    accountId: account.accountId,
    change: "deleted",
    templateId: args.templateId,
    name: args.name,
    ...(args.language !== undefined ? { language: args.language } : {}),
  });
}
