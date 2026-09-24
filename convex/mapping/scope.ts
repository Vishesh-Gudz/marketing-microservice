import type { Doc, Id } from "../_generated/dataModel";
import type { AdPlatform } from "../domain/types";
import type { Tenant } from "../lib/tenancy";

/**
 * Branded mapping scopes: the ONLY way tenant identity enters the
 * provider -> canonical boundary. They cannot be written as object literals
 * (the brand is a type-only unique symbol), only derived from:
 *   - the authenticated tenant (OrgScope), or
 *   - a stored, org-owned adAccounts document (AccountScope).
 * Provider code never sees either.
 */
declare const SCOPE_BRAND: unique symbol;

export type OrgScope = Readonly<{ orgId: Id<"organizations"> }> & {
  readonly [SCOPE_BRAND]: "OrgScope";
};

export type AccountScope = Readonly<{
  orgId: Id<"organizations">;
  adAccountId: Id<"adAccounts">;
  platform: AdPlatform;
  externalId: string;
  currency: string;
  timezone: string;
}> & { readonly [SCOPE_BRAND]: "AccountScope" };

/** From `ctx.tenant` (resolved from the verified JWT by the tenancy wrappers). */
export function orgScopeFromTenant(tenant: Tenant): OrgScope {
  return Object.freeze({ orgId: tenant.orgId }) as OrgScope;
}

/** From a stored ad account; orgId comes from the persisted row, never from a caller. */
export function accountScopeFromDoc(account: Doc<"adAccounts">): AccountScope {
  return Object.freeze({
    orgId: account.orgId,
    adAccountId: account._id,
    platform: account.platform,
    externalId: account.externalId,
    currency: account.currency,
    timezone: account.timezone,
  }) as AccountScope;
}
