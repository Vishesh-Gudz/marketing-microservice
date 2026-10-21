import { v } from "convex/values";
import { orgQuery } from "../lib/tenancy";
import { toPublicSyncStatus } from "../sync/publicStatus";
import { adAccountDto, toAdAccountDto } from "./dto/adAccount";

/**
 * The caller's ad accounts (linked and unlinked), each with its read-only sync state
 * (state, schedule, coverage, last run status, allowlisted error reason). Org-first
 * indexes only; a sync run of another org is never read.
 */
export const list = orgQuery({
  args: {},
  returns: v.array(adAccountDto),
  handler: async (ctx) => {
    const orgId = ctx.tenant.orgId;
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_org_platform_external", (q) => q.eq("orgId", orgId))
      .take(500);
    return await Promise.all(
      accounts.map(async (account) => {
        const state = await ctx.db
          .query("syncAccounts")
          .withIndex("by_org_account", (q) => q.eq("orgId", orgId).eq("adAccountId", account._id))
          .unique();
        if (state === null) return toAdAccountDto(account);
        const lastRun = state.lastRunId !== undefined ? await ctx.db.get(state.lastRunId) : null;
        return toAdAccountDto(
          account,
          toPublicSyncStatus(state, lastRun !== null && lastRun.orgId === orgId ? lastRun : null),
        );
      }),
    );
  },
});
