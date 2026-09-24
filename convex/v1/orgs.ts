import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { AUDIT_ACTIONS, writeAudit } from "../lib/audit";
import { apiError } from "../lib/errors";
import { authedMutation, orgAdminMutation, orgQuery, type Tenant } from "../lib/tenancy";
import {
  isValidCurrency,
  isValidTimezone,
  normalizeDisplayName,
  type AuditChanges,
} from "../lib/validation";
import { orgDto, toOrgDto } from "./dto/org";

async function loadOrg(ctx: { db: DatabaseReader; tenant: Tenant }): Promise<Doc<"organizations">> {
  const org = await ctx.db.get(ctx.tenant.orgId);
  if (org === null) throw apiError("INTERNAL", "Resolved organization is missing.");
  return org;
}

/**
 * Idempotently provisions the caller's organization (from the token's
 * issuer + org_id) and returns it. Safe to call on every app load; any role.
 */
export const ensure = authedMutation({
  args: {},
  returns: orgDto,
  handler: async (ctx) => toOrgDto(await loadOrg(ctx), ctx.tenant.role),
});

/** The caller's organization. Throws ORG_NOT_PROVISIONED before `ensure`. */
export const me = orgQuery({
  args: {},
  returns: orgDto,
  handler: async (ctx) => toOrgDto(await loadOrg(ctx), ctx.tenant.role),
});

/** Admin only. Omitted fields are left unchanged. */
export const updateSettings = orgAdminMutation({
  args: {
    displayName: v.optional(v.string()),
    reportingCurrency: v.optional(v.string()),
    timezone: v.optional(v.string()),
  },
  returns: orgDto,
  handler: async (ctx, args) => {
    const patch: Partial<
      Pick<Doc<"organizations">, "displayName" | "reportingCurrency" | "timezone">
    > = {};

    if (args.displayName !== undefined) {
      const name = normalizeDisplayName(args.displayName);
      if (name === null) {
        throw apiError("INVALID_ARGUMENT", "displayName must be 1-120 characters.", {
          field: "displayName",
        });
      }
      patch.displayName = name;
    }
    if (args.reportingCurrency !== undefined) {
      if (!isValidCurrency(args.reportingCurrency)) {
        throw apiError("INVALID_ARGUMENT", "reportingCurrency must be an ISO 4217 code.", {
          field: "reportingCurrency",
        });
      }
      patch.reportingCurrency = args.reportingCurrency;
    }
    if (args.timezone !== undefined) {
      if (!isValidTimezone(args.timezone)) {
        throw apiError("INVALID_ARGUMENT", "timezone must be an IANA time zone name.", {
          field: "timezone",
        });
      }
      patch.timezone = args.timezone;
    }
    if (Object.keys(patch).length === 0) {
      throw apiError("INVALID_ARGUMENT", "Provide at least one setting to update.");
    }

    const org = await loadOrg(ctx);
    const changes: AuditChanges = {};
    for (const [key, value] of Object.entries(patch) as [keyof typeof patch, string][]) {
      if (org[key] !== value) changes[key] = { from: org[key], to: value };
    }

    if (Object.keys(changes).length > 0) {
      await ctx.db.patch(org._id, { ...patch, updatedAt: Date.now() });
      await writeAudit(ctx.db, ctx.tenant, {
        action: AUDIT_ACTIONS.orgSettingsUpdated,
        targetType: "organization",
        targetId: org._id,
        changes,
      });
    }
    return toOrgDto(await loadOrg(ctx), ctx.tenant.role);
  },
});
