import { internalQuery } from "./_generated/server";
import { resolveForQuery } from "./lib/tenancy";
import { roleValidator } from "./lib/validation";

/**
 * INTERNAL: tenant resolution for orgAction / orgAdminAction. Runs with the
 * calling action's verified identity; throws the same MarketingErrors as the
 * query wrappers (UNAUTHENTICATED, APP_*, FORBIDDEN, ORG_NOT_PROVISIONED).
 */
export const resolve = internalQuery({
  args: { minRole: roleValidator },
  handler: async (ctx, { minRole }) => await resolveForQuery(ctx, minRole),
});
