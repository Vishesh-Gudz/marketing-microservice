import type { Id } from "../_generated/dataModel";

/**
 * Resolves external ids (within ONE ad account) to stored Convex ids. Phase 5
 * builds it from org-scoped index lookups; tests build it from maps.
 * Undefined = not stored yet (surfaced as unresolved, never silently dropped).
 */
export type EntityRefResolver = {
  campaign(externalId: string): Id<"campaigns"> | undefined;
  adGroup(
    externalId: string,
  ): { adGroupId: Id<"adGroups">; campaignId: Id<"campaigns"> } | undefined;
  ad(
    externalId: string,
  ): { adId: Id<"ads">; campaignId: Id<"campaigns">; adGroupId?: Id<"adGroups"> } | undefined;
  creative(externalId: string): Id<"creatives"> | undefined;
};

export type ResolverMaps = {
  campaigns?: ReadonlyMap<string, Id<"campaigns">>;
  adGroups?: ReadonlyMap<string, { adGroupId: Id<"adGroups">; campaignId: Id<"campaigns"> }>;
  ads?: ReadonlyMap<
    string,
    { adId: Id<"ads">; campaignId: Id<"campaigns">; adGroupId?: Id<"adGroups"> }
  >;
  creatives?: ReadonlyMap<string, Id<"creatives">>;
};

export function resolverFromMaps(maps: ResolverMaps): EntityRefResolver {
  return {
    campaign: (id) => maps.campaigns?.get(id),
    adGroup: (id) => maps.adGroups?.get(id),
    ad: (id) => maps.ads?.get(id),
    creative: (id) => maps.creatives?.get(id),
  };
}
