import type { Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { resolverFromMaps, type EntityRefResolver } from "../mapping/resolver";
import type { AccountScope } from "../mapping/scope";

/**
 * Builds the (synchronous) mapping resolver for one page: every external id
 * the page references is looked up ONCE through the org-scoped natural-key
 * index of the scope's ad account. Missing ids stay unresolved.
 */
export type PageRefs = {
  campaigns?: Iterable<string>;
  adGroups?: Iterable<string>;
  ads?: Iterable<string>;
  creatives?: Iterable<string>;
};

export async function buildResolver(
  db: DatabaseReader,
  scope: AccountScope,
  refs: PageRefs,
): Promise<EntityRefResolver> {
  const campaigns = new Map<string, Id<"campaigns">>();
  const adGroups = new Map<string, { adGroupId: Id<"adGroups">; campaignId: Id<"campaigns"> }>();
  const ads = new Map<
    string,
    { adId: Id<"ads">; campaignId: Id<"campaigns">; adGroupId?: Id<"adGroups"> }
  >();
  const creatives = new Map<string, Id<"creatives">>();

  for (const externalId of new Set(refs.campaigns ?? [])) {
    const row = await db
      .query("campaigns")
      .withIndex("by_org_account_external", (q) =>
        q
          .eq("orgId", scope.orgId)
          .eq("adAccountId", scope.adAccountId)
          .eq("externalId", externalId),
      )
      .first();
    if (row) campaigns.set(externalId, row._id);
  }
  for (const externalId of new Set(refs.adGroups ?? [])) {
    const row = await db
      .query("adGroups")
      .withIndex("by_org_account_external", (q) =>
        q
          .eq("orgId", scope.orgId)
          .eq("adAccountId", scope.adAccountId)
          .eq("externalId", externalId),
      )
      .first();
    if (row) adGroups.set(externalId, { adGroupId: row._id, campaignId: row.campaignId });
  }
  for (const externalId of new Set(refs.ads ?? [])) {
    const row = await db
      .query("ads")
      .withIndex("by_org_account_external", (q) =>
        q
          .eq("orgId", scope.orgId)
          .eq("adAccountId", scope.adAccountId)
          .eq("externalId", externalId),
      )
      .first();
    if (row) {
      ads.set(externalId, {
        adId: row._id,
        campaignId: row.campaignId,
        ...(row.adGroupId !== undefined ? { adGroupId: row.adGroupId } : {}),
      });
    }
  }
  for (const externalId of new Set(refs.creatives ?? [])) {
    const row = await db
      .query("creatives")
      .withIndex("by_org_account_external", (q) =>
        q
          .eq("orgId", scope.orgId)
          .eq("adAccountId", scope.adAccountId)
          .eq("externalId", externalId),
      )
      .first();
    if (row) creatives.set(externalId, row._id);
  }
  return resolverFromMaps({ campaigns, adGroups, ads, creatives });
}
