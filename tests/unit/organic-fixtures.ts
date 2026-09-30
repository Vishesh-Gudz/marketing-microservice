import type {
  OrganicAggregate,
  OrganicOverview,
  OrganicSeries,
  OrganicSeriesPoint,
  PostSnapshot,
  SocialAccount,
  SocialPost,
  SocialPostDetail,
} from "@/lib/analytics/organic-types";

// DTO-shaped organic test data for dashboard component tests. TEST-ONLY: typed from the
// public v1 return types, never used by the app (the app renders API data only).

const DEPRECATED = [
  { metric: "profileViews", reason: "deprecated_metric" },
  { metric: "websiteClicks", reason: "deprecated_metric" },
] as const;

/** A single-account, multi-day aggregate as the API returns it. */
export function organicAggregate(overrides: Partial<OrganicAggregate> = {}): OrganicAggregate {
  return {
    dataState: "reported",
    metrics: {
      followers: 1_234,
      followerDelta: 12,
      views: 5_400,
      totalInteractions: 310,
      likes: 200,
      comments: 0,
      shares: 14,
      saves: 20,
      replies: 3,
      profileLinksTaps: 9,
      followersCapturedAt: "2026-09-28T12:00:00.000Z",
      unavailableMetrics: [
        { metric: "reach", reason: "non_additive" },
        { metric: "accountsEngaged", reason: "non_additive" },
        ...DEPRECATED,
      ],
      partialMetrics: [],
    },
    kpis: { unavailableKpis: [{ kpi: "engagementRate", reason: "non_additive" }] },
    ...overrides,
  };
}

export const SOCIAL_ACCOUNT_ID = "acct_ig_1";
export const SOCIAL_ACCOUNT_ID_2 = "acct_ig_2";

export function socialAccount(overrides: Partial<SocialAccount> = {}): SocialAccount {
  return {
    id: SOCIAL_ACCOUNT_ID,
    platform: "instagram",
    externalId: "17841400000000101",
    username: "mock_1",
    name: "Mock 1",
    accountType: "business",
    status: "active",
    linked: true,
    connectionId: "conn_ig_1",
    linkedAt: "2026-09-01T00:00:00.000Z",
    followersCount: 1_234,
    lastSyncedAt: "2026-09-28T12:00:00.000Z",
    coverage: { from: "2026-08-30", through: "2026-09-28" },
    ...overrides,
  };
}

export function organicOverview(overrides: Partial<OrganicOverview> = {}): OrganicOverview {
  return {
    timezone: "UTC",
    range: { from: "2026-08-26", to: "2026-09-24" },
    accountCount: 1,
    totals: organicAggregate(),
    coverage: {
      dataState: "reported",
      accounts: [
        {
          accountId: SOCIAL_ACCOUNT_ID,
          syncedDays: 30,
          unsyncedDays: 0,
          lastSyncedAt: "2026-09-28T12:00:00.000Z",
        },
      ],
    },
    ...overrides,
  };
}

export function seriesPoint(
  bucket: string,
  overrides: Partial<OrganicSeriesPoint> = {},
): OrganicSeriesPoint {
  return {
    bucket,
    from: bucket,
    to: bucket,
    partial: false,
    ...organicAggregate({
      metrics: {
        views: 100,
        reach: 80,
        totalInteractions: 8,
        unavailableMetrics: [...DEPRECATED],
        partialMetrics: [],
      },
      kpis: { engagementRate: 0.1, unavailableKpis: [] },
    }),
    ...overrides,
  };
}

export function organicSeries(points: OrganicSeriesPoint[]): OrganicSeries {
  return {
    timezone: "UTC",
    accountId: SOCIAL_ACCOUNT_ID as OrganicSeries["accountId"],
    range: { from: points[0]?.from ?? "2026-09-01", to: points.at(-1)?.to ?? "2026-09-01" },
    granularity: "day",
    dataState: "reported",
    points,
  };
}

export function postSnapshot(overrides: Partial<PostSnapshot> = {}): PostSnapshot {
  return {
    capturedDate: "2026-09-28",
    capturedAt: "2026-09-28T12:00:00.000Z",
    dataState: "reported",
    metrics: {
      views: 900,
      reach: 400,
      likes: 50,
      comments: 5,
      shares: 0,
      saves: 7,
      totalInteractions: 62,
      unavailableMetrics: [{ metric: "videoViews", reason: "deprecated_metric" }],
    },
    kpis: { engagementRate: 0.155, unavailableKpis: [] },
    ...overrides,
  };
}

export function socialPost(overrides: Partial<SocialPost> = {}): SocialPost {
  return {
    id: "post_1",
    socialAccountId: SOCIAL_ACCOUNT_ID,
    platform: "instagram",
    externalId: "17900000000000001",
    type: "image",
    caption: "Hello from the mock account",
    permalink: "https://www.instagram.com/p/mock17900000000000001/",
    publishedAt: "2026-09-27T12:00:00.000Z",
    dataState: "reported",
    latest: postSnapshot(),
    ...overrides,
  };
}

export function socialPostDetail(overrides: Partial<SocialPostDetail> = {}): SocialPostDetail {
  return {
    ...socialPost(),
    snapshots: [
      postSnapshot({
        capturedDate: "2026-09-27",
        capturedAt: "2026-09-27T12:00:00.000Z",
        metrics: {
          views: 500,
          likes: 30,
          unavailableMetrics: [
            { metric: "reach", reason: "not_reported" },
            { metric: "videoViews", reason: "deprecated_metric" },
          ],
        },
        dataState: "partial",
        kpis: { unavailableKpis: [{ kpi: "engagementRate", reason: "denominator_unavailable" }] },
      }),
      postSnapshot(),
    ],
    ...overrides,
  };
}
