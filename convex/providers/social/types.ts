import type { Doc, TableNames } from "../../_generated/dataModel";
import type { SocialConnectionProvider, SocialPlatform } from "../../domain/types";
import type { DateKey } from "../../lib/dates";
import type { PageRequest, ProviderContext, ProviderPage } from "../types";
import type { SocialProviderCapabilities } from "./capabilities";

/**
 * The organic social provider contract (Phase 10), parallel to AdsProvider (ADR 0004).
 *
 * - Tenant-free and database-free: providers see a credential, an attempt number and
 *   EXTERNAL ids only; never an orgId or a Convex id.
 * - Every method returns ONE page; the sync engine owns iteration and cursor persistence.
 * - Records are canonical (Phase 2 social tables minus tenant/lifecycle/internal-id fields)
 *   and validated at the boundary against the real table validators (./validate.ts).
 * - Failures are ProviderErrors. Nothing platform- or SDK-specific (SDK types, SDK errors,
 *   SDK cursors, raw Graph payloads) crosses this interface.
 *
 * Two halves, split by runtime:
 * - SocialAccountDiscovery: SDK-free, runs in the DEFAULT Convex runtime inside the OAuth
 *   callback (discovery from the OAuth identity; no Node hop, Stage 0 decision).
 * - SocialProvider: the sync operations. The Instagram implementation wraps
 *   @opencoredev/social-sdk and therefore exists ONLY in "use node" modules
 *   (convex/providers/instagram/node/**, resolved by convex/providers/social/nodeRegistry.ts).
 */

type TenantAndLifecycleFields =
  "_id" | "_creationTime" | "orgId" | "createdAt" | "updatedAt" | "lastSeenAt" | "removedAt";

type Canonical<T extends TableNames, Drop extends string = never> = Omit<
  Doc<T>,
  TenantAndLifecycleFields | Drop
>;

/** Discovery record: the minimum identity of an account a connection can access. */
export type ProviderDiscoveredSocialAccount = Canonical<
  "discoveredSocialAccounts",
  "connectionId" | "discoveredAt"
>;

/** Sync preflight record (account metadata). Connection linkage is internal state. */
export type ProviderSocialAccount = Canonical<"socialAccounts", "connectionId" | "linkedAt">;

export type ProviderSocialPost = Canonical<"socialPosts", "socialAccountId"> & {
  accountExternalId: string;
};

export type ProviderSocialPostSnapshot = Canonical<
  "socialPostMetricSnapshots",
  "socialAccountId" | "postId"
> & {
  accountExternalId: string;
  postExternalId: string;
};

export type ProviderSocialAccountDay = Canonical<
  "socialAccountMetricsDaily",
  "socialAccountId" | "syncedAt"
> & {
  accountExternalId: string;
};

export type SocialRecordKind =
  | "discoveredSocialAccount"
  | "socialAccount"
  | "socialPost"
  | "socialPostSnapshot"
  | "socialAccountDay";

export type SocialRecordByKind = {
  discoveredSocialAccount: ProviderDiscoveredSocialAccount;
  socialAccount: ProviderSocialAccount;
  socialPost: ProviderSocialPost;
  socialPostSnapshot: ProviderSocialPostSnapshot;
  socialAccountDay: ProviderSocialAccountDay;
};

// ---------------------------------------------------------------------------
// Requests (external ids and UTC days only)
// ---------------------------------------------------------------------------

export type SocialAccountRequest = {
  /** Canonical account external id (socialAccounts.externalId). */
  accountExternalId: string;
};

export type SocialPostsRequest = PageRequest & SocialAccountRequest;

export type SocialPostMetricsRequest = PageRequest &
  SocialAccountRequest & {
    /** Only posts published on or after this UTC day get a snapshot (the snapshot window). */
    publishedFrom: DateKey;
  };

export type SocialAccountMetricsRequest = PageRequest &
  SocialAccountRequest & {
    /** Inclusive UTC days. */
    from: DateKey;
    to: DateKey;
  };

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Default-runtime (SDK-free) discovery of the accounts a connection can access. */
export interface SocialAccountDiscovery<TCredential = unknown> {
  readonly platform: SocialConnectionProvider;
  readonly providerId: string;
  listAccounts(
    ctx: ProviderContext<TCredential>,
    request: PageRequest,
  ): Promise<ProviderPage<ProviderDiscoveredSocialAccount>>;
}

/** Sync operations for one social platform. Unsupported operations throw ProviderErrors. */
export interface SocialProvider<TCredential = unknown> {
  readonly platform: SocialPlatform;
  /** Implementation id, e.g. "mock-social", "instagram-login/v25.0". Run metadata only. */
  readonly providerId: string;
  readonly capabilities: SocialProviderCapabilities;

  /** Sync preflight: verifies access and returns the account's current metadata. */
  getAccount(
    ctx: ProviderContext<TCredential>,
    request: SocialAccountRequest,
  ): Promise<ProviderSocialAccount>;
  listPosts(
    ctx: ProviderContext<TCredential>,
    request: SocialPostsRequest,
  ): Promise<ProviderPage<ProviderSocialPost>>;
  /** Lifetime (cumulative) values as of now, one snapshot per post. */
  fetchPostMetrics(
    ctx: ProviderContext<TCredential>,
    request: SocialPostMetricsRequest,
  ): Promise<ProviderPage<ProviderSocialPostSnapshot>>;
  fetchAccountMetrics(
    ctx: ProviderContext<TCredential>,
    request: SocialAccountMetricsRequest,
  ): Promise<ProviderPage<ProviderSocialAccountDay>>;
}
