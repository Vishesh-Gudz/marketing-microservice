"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { filterParamsOnly } from "@/lib/analytics/filters";
import { humanize } from "@/lib/analytics/labels";
import { postSnapshotRows } from "@/lib/analytics/organic-chart-data";
import { useOrg } from "@/lib/analytics/org-context";
import { POST_DATA_STATE_DESCRIPTION } from "@/lib/analytics/organic-states";
import {
  POST_VALUE_KEYS,
  postLabel,
  postValueView,
  type PostValueKey,
} from "@/lib/analytics/organic-values";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import { cn } from "@/lib/utils";
import { DataStateBadge } from "../data-state-badge";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
import { InstagramLink } from "../organic/instagram-link";
import { MediaTile, POST_TYPE_ICON } from "../organic/media-tile";
import { OrganicSeriesChart } from "../organic/organic-series-chart";
import { Breadcrumbs, PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";
import { KPI_CELL, KPI_STRIP, SECTION_HEADING, SURFACE } from "../surface";
import { ValueText } from "../value-text";

const METRICS = POST_VALUE_KEYS.map((value) => ({ value, label: postLabel(value) }));

function PostDetail({ postId }: { postId: string }) {
  const org = useOrg();
  const { searchParams } = useDashboardFilters();
  const [metric, setMetric] = useState<PostValueKey>("views");
  const { data } = useAnalyticsQuery(api.v1.socialPosts.get, { postId });
  const back = filterParamsOnly(new URLSearchParams(searchParams.toString()));
  const account = searchParams.get("account");
  if (account !== null) back.set("account", account);
  const organicHref = back.toString() ? `/social?${back.toString()}` : "/social";

  if (!data) {
    return (
      <>
        <Breadcrumbs items={[{ label: "Organic", href: organicHref }, { label: "Post" }]} />
        <Skeleton className="h-40 w-full rounded-[14px]" role="status" aria-label="Loading post" />
      </>
    );
  }
  const latest = data.latest;
  return (
    <>
      <Breadcrumbs items={[{ label: "Organic", href: organicHref }, { label: "Post" }]} />
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <MediaTile icon={POST_TYPE_ICON[data.type]} />
            {humanize(data.type)} post
          </span>
        }
        description={`Published ${formatInstant(data.publishedAt, org.timezone)} (${org.timezone})`}
      >
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {data.removedAt && <Badge variant="outline">Removed from Instagram</Badge>}
          <span title={POST_DATA_STATE_DESCRIPTION[data.dataState]}>
            <DataStateBadge state={data.dataState} showReported />
          </span>
          <InstagramLink permalink={data.permalink} className="text-blue-deep" />
        </div>
      </PageHeader>
      {data.caption !== undefined && (
        <section aria-labelledby="caption-heading" className={cn(SURFACE, "px-4 py-3.5")}>
          <h2 id="caption-heading" className="mb-1 text-[13px] font-medium text-muted-foreground">
            Caption
          </h2>
          <p className="text-sm whitespace-pre-line text-ink">{data.caption}</p>
        </section>
      )}
      <section aria-labelledby="latest-heading" className="flex flex-col gap-3">
        <h2 id="latest-heading" className={SECTION_HEADING}>
          Lifetime totals
          {latest ? ` as of ${latest.capturedDate} (UTC capture day)` : ""}
        </h2>
        {latest === undefined ? (
          <EmptyState title="Not captured yet">
            {POST_DATA_STATE_DESCRIPTION.unknown} Values are never shown as zero before a capture.
          </EmptyState>
        ) : (
          // Eight totals fill 2 or 4 columns.
          <div className={cn(KPI_STRIP, "grid-cols-2 sm:grid-cols-4")}>
            {POST_VALUE_KEYS.map((key) => (
              <div key={key} className={KPI_CELL} data-kpi={key}>
                <h3 className="text-[13px] font-medium text-muted-foreground">{postLabel(key)}</h3>
                <ValueText
                  view={postValueView(key, latest)}
                  className="text-2xl leading-tight font-medium tracking-[-0.02em]"
                />
              </div>
            ))}
          </div>
        )}
      </section>
      {data.snapshots.length > 0 && (
        <div className={cn(SURFACE, "p-4")} data-testid="post-snapshots">
          <OrganicSeriesChart
            title="Lifetime totals at each capture"
            heading={`${postLabel(metric)}: lifetime total at each capture (UTC)`}
            rows={postSnapshotRows(data.snapshots, metric)}
            granularity="day"
            metric={metric}
            metrics={METRICS}
            onMetricChange={setMetric}
            note="Each point is the post's lifetime total at a capture (UTC day), not daily performance. Gaps are captures without a value."
          />
        </div>
      )}
    </>
  );
}

/** One organic post: caption, lifetime totals and its captures. Unknown or foreign -> not found. */
export function SocialPostDetailView({ postId }: { postId: string }) {
  return (
    <QueryBoundary resetKey={postId} title="Post" notFoundAsPage>
      <PostDetail postId={postId} />
    </QueryBoundary>
  );
}
