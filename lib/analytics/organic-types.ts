import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

// Organic (Instagram) dashboard types, derived from the PUBLIC v1 API only (the generated
// `api` references), never from internal modules. Type-only imports (D23).

type Organic = typeof api.v1.organicAnalytics;

export type OrganicOverviewArgs = FunctionArgs<Organic["overview"]>;
export type OrganicOverview = FunctionReturnType<Organic["overview"]>;
export type OrganicSeriesArgs = FunctionArgs<Organic["accountSeries"]>;
export type OrganicSeries = FunctionReturnType<Organic["accountSeries"]>;
export type OrganicSeriesPoint = OrganicSeries["points"][number];

export type OrganicAggregate = OrganicOverview["totals"];
export type OrganicMetrics = OrganicAggregate["metrics"];
export type OrganicKpis = OrganicAggregate["kpis"];
export type OrganicDataState = OrganicAggregate["dataState"];
export type OrganicComparison = NonNullable<OrganicOverview["comparison"]>;
export type OrganicDeltas = OrganicComparison["deltas"];
export type OrganicCoverage = OrganicOverview["coverage"];

/** Account metric names an unavailable entry may carry (includes deprecated ones). */
export type OrganicMetricName = OrganicMetrics["unavailableMetrics"][number]["metric"];
export type OrganicMetricReason = OrganicMetrics["unavailableMetrics"][number]["reason"];
export type OrganicKpiReason = OrganicKpis["unavailableKpis"][number]["reason"];

export type SocialAccount = FunctionReturnType<typeof api.v1.socialAccounts.get>;
export type SocialAccountsPage = FunctionReturnType<typeof api.v1.socialAccounts.list>;

export type SocialPostsArgs = FunctionArgs<typeof api.v1.socialPosts.list>;
export type SocialPostsPage = FunctionReturnType<typeof api.v1.socialPosts.list>;
export type SocialPost = SocialPostsPage["page"][number];
export type SocialPostDetail = FunctionReturnType<typeof api.v1.socialPosts.get>;
/** One lifetime capture of a post (lifetime totals, never per-day values). */
export type PostSnapshot = SocialPostDetail["snapshots"][number];
export type PostMetricName = PostSnapshot["metrics"]["unavailableMetrics"][number]["metric"];
