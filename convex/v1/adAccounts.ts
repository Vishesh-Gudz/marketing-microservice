import { v } from "convex/values";
import { orgQuery } from "../lib/tenancy";
import { adAccountDto, toAdAccountDto } from "./dto/adAccount";

/** The caller's ad accounts (linked and unlinked). */
export const list = orgQuery({
  args: {},
  returns: v.array(adAccountDto),
  handler: async (ctx) => {
    const accounts = await ctx.db
      .query("adAccounts")
      .withIndex("by_org_platform_external", (q) => q.eq("orgId", ctx.tenant.orgId))
      .take(500);
    return accounts.map(toAdAccountDto);
  },
});
