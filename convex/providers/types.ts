import type { Doc, TableNames } from "../_generated/dataModel";
import type { AdPlatform, EntityLevel } from "../domain/types";
import type { DateKey } from "../lib/dates";
import type { AdsProviderCapabilities } from "./capabilities";

// ---------------------------------------------------------------------------
// Call context and requests. Deliberately NO tenant identifiers: providers are
// pure adapters that never know which organization they are working for.
// ---------------------------------------------------------------------------

export type ProviderContext<TCredential = unknown> = {
  /** Opaque platform credential (Phase 4 supplies real ones; tests use MockCredential). */
  readonly credential: TCredential;
  /** 1-based attempt number supplied by the caller; the only input retry behavior may depend on. */
  readonly attempt: number;
};

export type PageRequest = {
  /** Opaque cursor from a previous page of the SAME request. */
  cursor?: string;
  /** Clamped to 1..capabilities.maxPageSize. */
  pageSize?: number;
};

/** One page. Absent `nextCursor` means the result set is complete. */
export type ProviderPage<T> = { items: T[]; nextCursor?: string };

/** Single-account lookup (Phase 5 sync preflight): no pagination. */
export type AccountLookupRequest = {
  /** Canonical account external id (as stored in adAccounts.externalId). */
  accountExternalId: string;
};

export type AccountRequest = PageRequest & AccountLookupRequest;

export type EntityRequest = AccountRequest & {
  /** Only entities updated at/after this instant (epoch ms), if incrementalEntities is supported. */
  updatedSince?: number;
};

/** "none" returns only placement "all" rows; "placement" returns "all" plus breakdown rows. */
export type MetricsBreakdown = "none" | "placement";

export type MetricsRequest = AccountRequest & {
  level: EntityLevel;
  /** Inclusive account-local days. */
  from: DateKey;
  to: DateKey;
  breakdown: MetricsBreakdown;
};

export const PROVIDER_OPERATIONS = [
  "listAccounts",
  "getAccount",
  "listCampaigns",
  "listAdGroups",
  "listAds",
  "listCreatives",
  "fetchDailyMetrics",
  "fetchActionMetrics",
  // OAuth (Phase 4)
  "oauthExchange",
  "oauthRefresh",
  "oauthRevoke",
] as const;
export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number];

// ---------------------------------------------------------------------------
// Provider records: canonical vocabulary (Phase 2 enums, int64 micros, DateKeys,
// canonical external ids) with references expressed as EXTERNAL ids only.
// Derived type-only from the Phase 2 Doc types so they cannot drift from the
// schema. They never carry orgId, Convex ids, or lifecycle timestamps.
// ---------------------------------------------------------------------------

type TenantAndLifecycleFields =
  "_id" | "_creationTime" | "orgId" | "createdAt" | "updatedAt" | "lastSeenAt" | "removedAt";

type Canonical<T extends TableNames, Drop extends string = never> = Omit<
  Doc<T>,
  TenantAndLifecycleFields | Drop
>;

type MetricRefs = "adAccountId" | "entityId" | "campaignId" | "adGroupId" | "adId" | "syncedAt";

/** Connection linkage (Phase 4) is internal state, never part of a provider record. */
export type ProviderAdAccount = Canonical<"adAccounts", "connectionId" | "linkedAt">;

export type ProviderCampaign = Canonical<"campaigns", "adAccountId"> & {
  accountExternalId: string;
};

export type ProviderAdGroup = Canonical<"adGroups", "adAccountId" | "campaignId"> & {
  accountExternalId: string;
  campaignExternalId: string;
};

export type ProviderAd = Canonical<
  "ads",
  "adAccountId" | "campaignId" | "adGroupId" | "creativeId"
> & {
  accountExternalId: string;
  campaignExternalId: string;
  adGroupExternalId?: string;
  creativeExternalId?: string;
};

export type ProviderCreative = Canonical<"creatives", "adAccountId"> & {
  accountExternalId: string;
};

export type ProviderMetricRow = Canonical<"metricsDaily", MetricRefs> & {
  accountExternalId: string;
  entityExternalId: string;
};

export type ProviderActionRow = Canonical<"actionMetricsDaily", MetricRefs> & {
  accountExternalId: string;
  entityExternalId: string;
};

export type ProviderRecordKind =
  "adAccount" | "campaign" | "adGroup" | "ad" | "creative" | "metricRow" | "actionRow";

export type ProviderRecordByKind = {
  adAccount: ProviderAdAccount;
  campaign: ProviderCampaign;
  adGroup: ProviderAdGroup;
  ad: ProviderAd;
  creative: ProviderCreative;
  metricRow: ProviderMetricRow;
  actionRow: ProviderActionRow;
};

// ---------------------------------------------------------------------------
// The paid-ads provider contract. Every method returns ONE page; the caller
// (Phase 5 sync) owns iteration and cursor persistence. Unsupported operations
// throw ProviderError("unsupported"); all failures are ProviderErrors.
// ---------------------------------------------------------------------------

export interface AdsProvider<TCredential = unknown> {
  readonly platform: AdPlatform;
  /** Implementation id, e.g. "mock", later "meta-marketing-api", "google-ads-api". */
  readonly providerId: string;
  readonly capabilities: AdsProviderCapabilities;

  listAccounts(
    ctx: ProviderContext<TCredential>,
    request: PageRequest,
  ): Promise<ProviderPage<ProviderAdAccount>>;
  /**
   * One account by canonical external id (sync preflight: verifies access and
   * refreshes account metadata). Inaccessible accounts fail with "not_found" or
   * "permission"; manager accounts are returned (isManager = true).
   */
  getAccount(
    ctx: ProviderContext<TCredential>,
    request: AccountLookupRequest,
  ): Promise<ProviderAdAccount>;
  listCampaigns(
    ctx: ProviderContext<TCredential>,
    request: EntityRequest,
  ): Promise<ProviderPage<ProviderCampaign>>;
  listAdGroups(
    ctx: ProviderContext<TCredential>,
    request: EntityRequest,
  ): Promise<ProviderPage<ProviderAdGroup>>;
  listAds(
    ctx: ProviderContext<TCredential>,
    request: EntityRequest,
  ): Promise<ProviderPage<ProviderAd>>;
  listCreatives(
    ctx: ProviderContext<TCredential>,
    request: EntityRequest,
  ): Promise<ProviderPage<ProviderCreative>>;
  fetchDailyMetrics(
    ctx: ProviderContext<TCredential>,
    request: MetricsRequest,
  ): Promise<ProviderPage<ProviderMetricRow>>;
  fetchActionMetrics(
    ctx: ProviderContext<TCredential>,
    request: MetricsRequest,
  ): Promise<ProviderPage<ProviderActionRow>>;
}
