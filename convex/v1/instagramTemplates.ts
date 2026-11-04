import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import {
  checkInstagramTemplate,
  instagramTemplateInputValidator,
  MAX_INSTAGRAM_TEMPLATES,
  type InstagramTemplateInput,
} from "../instagram/messaging/templates";
import { apiError } from "../lib/errors";
import { getOwned, orgMutation, orgQuery } from "../lib/tenancy";
import { instagramTemplateDto, toInstagramTemplateDto as toDto } from "./dto/instagramTemplates";

/**
 * Instagram templates (ADR 0022): the org's reusable button messages and cards for Instagram
 * DMs, sent from a conversation with v1/instagramMessaging:sendTemplate. Stored here only (no
 * Meta review). Every member may read them; editors and admins (who reply) create, change and
 * delete them. Tenant-scoped through the verified JWT: an org-first index with
 * ctx.tenant.orgId, and client ids through getOwned (another org's template is NOT_FOUND).
 * Refusals are INVALID_ARGUMENT with `field` and `reason` (convex/instagram/messaging/
 * templates.ts), or CONFLICT (`name_in_use`, `limit_reached`). Not audited (business content,
 * like saved replies).
 */

async function templatesOf(db: DatabaseReader, orgId: Id<"organizations">) {
  return await db
    .query("instagramTemplates")
    .withIndex("by_org_name", (q) => q.eq("orgId", orgId))
    .take(MAX_INSTAGRAM_TEMPLATES + 1);
}

function checked(input: InstagramTemplateInput) {
  const result = checkInstagramTemplate(input);
  if (!result.ok) {
    throw apiError("INVALID_ARGUMENT", "The Instagram template is not valid.", {
      field: result.field,
      reason: result.reason,
    });
  }
  return result.value;
}

function nameInUse() {
  return apiError("CONFLICT", "Another Instagram template has this name.", {
    reason: "name_in_use",
  });
}

/** Every member: the org's Instagram templates by name. */
export const list = orgQuery({
  args: {},
  returns: v.array(instagramTemplateDto),
  handler: async (ctx) => {
    const templates = await templatesOf(ctx.db, ctx.tenant.orgId);
    return templates.slice(0, MAX_INSTAGRAM_TEMPLATES).map(toDto);
  },
});

/** Editors and admins: adds a template (at most MAX_INSTAGRAM_TEMPLATES per org). */
export const create = orgMutation({
  args: instagramTemplateInputValidator,
  returns: instagramTemplateDto,
  handler: async (ctx, args) => {
    const value = checked(args);
    const existing = await templatesOf(ctx.db, ctx.tenant.orgId);
    if (existing.length >= MAX_INSTAGRAM_TEMPLATES) {
      throw apiError("CONFLICT", `At most ${MAX_INSTAGRAM_TEMPLATES} Instagram templates.`, {
        reason: "limit_reached",
      });
    }
    if (existing.some((template) => template.name === value.name)) throw nameInUse();
    const now = Date.now();
    const id = await ctx.db.insert("instagramTemplates", {
      orgId: ctx.tenant.orgId,
      ...value,
      createdBySubject: ctx.tenant.subject,
      updatedBySubject: ctx.tenant.subject,
      createdAt: now,
      updatedAt: now,
    });
    return toDto((await ctx.db.get(id))!);
  },
});

/** Editors and admins: replaces one of the org's templates (messages already sent keep theirs). */
export const update = orgMutation({
  args: { templateId: v.string(), ...instagramTemplateInputValidator },
  returns: instagramTemplateDto,
  handler: async (ctx, { templateId, ...input }) => {
    const template = await getOwned(ctx, "instagramTemplates", templateId);
    const value = checked(input);
    const clash = await ctx.db
      .query("instagramTemplates")
      .withIndex("by_org_name", (q) => q.eq("orgId", ctx.tenant.orgId).eq("name", value.name))
      .first();
    if (clash !== null && clash._id !== template._id) throw nameInUse();
    await ctx.db.replace(template._id, {
      orgId: template.orgId,
      ...value,
      createdBySubject: template.createdBySubject,
      updatedBySubject: ctx.tenant.subject,
      createdAt: template.createdAt,
      updatedAt: Date.now(),
    });
    return toDto((await ctx.db.get(template._id))!);
  },
});

/** Editors and admins: deletes one of the org's templates. */
export const remove = orgMutation({
  args: { templateId: v.string() },
  returns: v.null(),
  handler: async (ctx, { templateId }) => {
    const template = await getOwned(ctx, "instagramTemplates", templateId);
    await ctx.db.delete(template._id);
    return null;
  },
});
