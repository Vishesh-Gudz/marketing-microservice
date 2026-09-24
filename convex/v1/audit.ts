import { paginationOptsValidator } from "convex/server";
import { clampPagination, mapPage, paginatedDto } from "../lib/dto";
import { orgQuery } from "../lib/tenancy";
import { auditEntryDto, toAuditEntryDto } from "./dto/audit";

/** Admin only. The caller's organization audit trail, newest first. */
export const list = orgQuery({
  minRole: "admin",
  args: { paginationOpts: paginationOptsValidator },
  returns: paginatedDto(auditEntryDto),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("auditLog")
      .withIndex("by_org_at", (q) => q.eq("orgId", ctx.tenant.orgId))
      .order("desc")
      .paginate(clampPagination(args.paginationOpts));
    return mapPage(result, toAuditEntryDto);
  },
});
