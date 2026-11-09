import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { AUDIT_ACTIONS, SYSTEM_ORG_DEFAULTS_SUBJECT, writeAudit } from "../lib/audit";
import { ORG_DEFAULTS, PREVIOUS_ORG_DEFAULTS } from "../lib/tenancy";

/**
 * INTERNAL one-time operator command (C1): organizations still on the defaults from before C1
 * (USD, UTC) that nobody has configured move to the current defaults (INR, Asia/Kolkata).
 *
 *   npx convex run admin/orgDefaults:switchUntouched '{"dryRun":true}'
 *   npx convex run admin/orgDefaults:switchUntouched '{"dryRun":false}'
 *
 * "Nobody has configured" = the organization has no `org.settings.updated` audit entry: an
 * organization deliberately set to USD/UTC through `v1/orgs:updateSettings` is left alone. Each
 * switch is audited as `org.settings.updated` by `system:org-defaults`, with from/to. A dry run
 * changes nothing and returns the same lists. Idempotent: a second run switches nothing.
 * Organizations are read in pages (`cursor`, `batch`) to stay within one transaction's limits.
 */

const DEFAULT_BATCH = 50;
const MAX_BATCH = 200;

const orgRef = v.object({ id: v.id("organizations"), displayName: v.string() });

function onPreviousDefaults(org: Doc<"organizations">): boolean {
  return (
    org.reportingCurrency === PREVIOUS_ORG_DEFAULTS.reportingCurrency &&
    org.timezone === PREVIOUS_ORG_DEFAULTS.timezone
  );
}

async function wasConfigured(ctx: MutationCtx, org: Doc<"organizations">): Promise<boolean> {
  const entry = await ctx.db
    .query("auditLog")
    .withIndex("by_org_at", (q) => q.eq("orgId", org._id))
    .filter((q) => q.eq(q.field("action"), AUDIT_ACTIONS.orgSettingsUpdated))
    .first();
  return entry !== null;
}

export const switchUntouched = internalMutation({
  args: {
    dryRun: v.boolean(),
    cursor: v.optional(v.union(v.string(), v.null())),
    batch: v.optional(v.number()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    checked: v.number(),
    switched: v.array(orgRef),
    keptConfigured: v.array(orgRef),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { dryRun, cursor, batch }) => {
    const size = batch ?? DEFAULT_BATCH;
    if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH) {
      throw new Error(`batch must be an integer from 1 to ${MAX_BATCH}`);
    }
    const page = await ctx.db
      .query("organizations")
      .paginate({ numItems: size, cursor: cursor ?? null });

    const switched: { id: Doc<"organizations">["_id"]; displayName: string }[] = [];
    const keptConfigured: { id: Doc<"organizations">["_id"]; displayName: string }[] = [];
    for (const org of page.page) {
      if (!onPreviousDefaults(org)) continue;
      const ref = { id: org._id, displayName: org.displayName };
      if (await wasConfigured(ctx, org)) {
        keptConfigured.push(ref);
        continue;
      }
      switched.push(ref);
      if (dryRun) continue;
      await ctx.db.patch(org._id, {
        reportingCurrency: ORG_DEFAULTS.reportingCurrency,
        timezone: ORG_DEFAULTS.timezone,
        updatedAt: Date.now(),
      });
      await writeAudit(
        ctx.db,
        { orgId: org._id, issuer: org.issuer, subject: SYSTEM_ORG_DEFAULTS_SUBJECT },
        {
          action: AUDIT_ACTIONS.orgSettingsUpdated,
          targetType: "organization",
          targetId: org._id,
          changes: {
            reportingCurrency: {
              from: PREVIOUS_ORG_DEFAULTS.reportingCurrency,
              to: ORG_DEFAULTS.reportingCurrency,
            },
            timezone: { from: PREVIOUS_ORG_DEFAULTS.timezone, to: ORG_DEFAULTS.timezone },
          },
        },
      );
    }
    return {
      dryRun,
      checked: page.page.length,
      switched,
      keptConfigured,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
