import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import type { AdPlatform } from "../domain/types";
import { apiError } from "../lib/errors";
import { getOwned, type Tenant } from "../lib/tenancy";
import { ANALYTICS_LIMITS } from "./config";
import type { ReadBudget } from "./reader";

/**
 * Tenant-scoped resolution of what an analytics query covers. The org is ALWAYS
 * ctx.tenant.orgId; client-supplied ids are loaded with getOwned (another
 * tenant's id is NOT_FOUND). Manager (MCC) accounts are never included.
 * Unlinked and blocked accounts ARE included: their history belongs to the org.
 */

export type TenantCtx = { db: DatabaseReader; tenant: Tenant };

export type AccountFilters = { platforms?: AdPlatform[]; accountIds?: string[] };

/** Account documents are charged to the query's metric read budget (entity documents count). */
export async function scopedAccounts(
  ctx: TenantCtx,
  filters: AccountFilters | undefined,
  budget: ReadBudget,
): Promise<Doc<"adAccounts">[]> {
  const platforms = filters?.platforms === undefined ? undefined : new Set(filters.platforms);
  if (filters?.accountIds !== undefined) {
    const ids = [...new Set(filters.accountIds)];
    if (ids.length === 0 || ids.length > ANALYTICS_LIMITS.maxAccountIds) {
      throw apiError(
        "INVALID_ARGUMENT",
        `Provide 1-${ANALYTICS_LIMITS.maxAccountIds} account ids.`,
        { field: "filters.accountIds" },
      );
    }
    budget.charge(ids.length);
    const accounts: Doc<"adAccounts">[] = [];
    for (const id of ids) {
      const account = await getOwned(ctx, "adAccounts", id);
      if (account.isManager) continue;
      if (platforms !== undefined && !platforms.has(account.platform)) continue;
      accounts.push(account);
    }
    return accounts.sort((a, b) =>
      a.platform === b.platform
        ? a.externalId.localeCompare(b.externalId)
        : a.platform.localeCompare(b.platform),
    );
  }

  const rows = await budget.take(
    ctx.db
      .query("adAccounts")
      .withIndex("by_org_platform_external", (q) => q.eq("orgId", ctx.tenant.orgId)),
  );
  return rows.filter((a) => !a.isManager && (platforms === undefined || platforms.has(a.platform)));
}

export type EntityTable = "adAccounts" | "campaigns" | "adGroups" | "ads";

export const LEVEL_TABLE = {
  account: "adAccounts",
  campaign: "campaigns",
  ad_group: "adGroups",
  ad: "ads",
} as const satisfies Record<string, EntityTable>;

/** Loads an entity of `level` owned by the tenant, plus its ad account. */
export async function ownedEntity(
  ctx: TenantCtx,
  level: keyof typeof LEVEL_TABLE,
  id: string,
): Promise<{ entity: Doc<EntityTable>; account: Doc<"adAccounts"> }> {
  const entity = await getOwned(ctx, LEVEL_TABLE[level], id);
  if (level === "account") {
    return { entity, account: entity as Doc<"adAccounts"> };
  }
  const accountId = (entity as { adAccountId: Id<"adAccounts"> }).adAccountId;
  const account = await getOwned(ctx, "adAccounts", accountId);
  return { entity, account };
}
