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

/**
 * Fields a provider record may NEVER carry (Phase 10 Stage B), on top of the tenant,
 * lifecycle and internal-id fields:
 * - URLs other than the post permalink [F1]: profilePictureUrl, mediaUrl, thumbnailUrl
 * - fields Instagram Login does not provide: linkedPageExternalId, commentsEnabled
 * - engine-owned provenance and the profile column group [F7]: syncedAt,
 *   followersCapturedAt, insightsSyncedAt, followers (captured from the preflight)
 * - deprecated metrics that are never populated [F19]: videoViews, profileViews,
 *   websiteClicks
 * - post extras [F5]
 * The validators (./validate.ts) drop exactly these fields, so a record carrying one is
 * rejected at the boundary.
 */
export const SOCIAL_RECORD_DROPPED_FIELDS = {
  discoveredSocialAccount: ["connectionId", "discoveredAt"],
  socialAccount: ["connectionId", "linkedAt", "profilePictureUrl", "linkedPageExternalId"],
  socialPost: ["socialAccountId", "mediaUrl", "thumbnailUrl", "commentsEnabled"],
  socialPostSnapshot: ["socialAccountId", "postId", "videoViews", "extras"],
  socialAccountDay: [
    "socialAccountId",
    "syncedAt",
    "followers",
    "followersCapturedAt",
    "insightsSyncedAt",
    "profileViews",
    "websiteClicks",
  ],
} as const;

type Dropped<K extends keyof typeof SOCIAL_RECORD_DROPPED_FIELDS> =
  (typeof SOCIAL_RECORD_DROPPED_FIELDS)[K][number];

/** Sync preflight record (account metadata). Connection linkage is internal state. */
export type ProviderSocialAccount = Canonical<"socialAccounts", Dropped<"socialAccount">>;

export type ProviderSocialPost = Canonical<"socialPosts", Dropped<"socialPost">> & {
  accountExternalId: string;
};

/** One lifetime snapshot of a post, captured now (capturedDate = UTC day of capturedAt). */
export type ProviderSocialPostSnapshot = Canonical<
  "socialPostMetricSnapshots",
  Dropped<"socialPostSnapshot">
> & {
  accountExternalId: string;
  postExternalId: string;
};

/**
 * One UTC day of account insights: ONLY the insights column group. The provider emits one
 * record for EVERY requested day, also when the platform reported nothing (all metrics
 * absent), so a synced empty day stays distinguishable from a day never synced.
 */
export type ProviderSocialAccountDay = Canonical<
  "socialAccountMetricsDaily",
  Dropped<"socialAccountDay">
> & {
  accountExternalId: string;
};

/**
 * A page of social records. `unresolved` counts platform items the provider could not map
 * and did NOT emit (e.g. media without a product type, a post deleted mid-page); the engine
 * adds it to the run's unresolved count, which also blocks removal marking. Items excluded
 * by scope (ad or story media) are never counted.
 */
export type SocialProviderPage<T> = ProviderPage<T> & { unresolved?: number };

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
  /** Newest first. */
  listPosts(
    ctx: ProviderContext<TCredential>,
    request: SocialPostsRequest,
  ): Promise<SocialProviderPage<ProviderSocialPost>>;
  /**
   * Lifetime (cumulative) values as of now, one snapshot per post published on or after
   * `publishedFrom`. Self-contained: the provider lists the posts itself (newest first) and
   * ends the listing at the first older post.
   */
  fetchPostMetrics(
    ctx: ProviderContext<TCredential>,
    request: SocialPostMetricsRequest,
  ): Promise<SocialProviderPage<ProviderSocialPostSnapshot>>;
  fetchAccountMetrics(
    ctx: ProviderContext<TCredential>,
    request: SocialAccountMetricsRequest,
  ): Promise<ProviderPage<ProviderSocialAccountDay>>;
}
