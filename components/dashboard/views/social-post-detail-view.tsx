"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { DataStateBadge } from "../data-state-badge";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
import { InstagramLink } from "../organic/instagram-link";
import { OrganicSeriesChart } from "../organic/organic-series-chart";
import { Breadcrumbs, PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";
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
        <Skeleton className="h-40 w-full" role="status" aria-label="Loading post" />
      </>
    );
  }
  const latest = data.latest;
  return (
    <>
      <Breadcrumbs items={[{ label: "Organic", href: organicHref }, { label: "Post" }]} />
      <PageHeader
        title={`${humanize(data.type)} post`}
        description={`Published ${formatInstant(data.publishedAt, org.timezone)} (${org.timezone})`}
      >
        <div className="flex flex-wrap items-center gap-2">
          {data.removedAt && <Badge variant="outline">Removed from Instagram</Badge>}
          <span title={POST_DATA_STATE_DESCRIPTION[data.dataState]}>
            <DataStateBadge state={data.dataState} showReported />
          </span>
          <InstagramLink permalink={data.permalink} />
        </div>
      </PageHeader>
      {data.caption !== undefined && (
        <section aria-labelledby="caption-heading" className="rounded-lg border p-4">
          <h2 id="caption-heading" className="sr-only">
            Caption
          </h2>
          <p className="text-sm whitespace-pre-line">{data.caption}</p>
        </section>
      )}
      <section aria-labelledby="latest-heading" className="flex flex-col gap-2">
        <h2 id="latest-heading" className="text-base font-semibold">
          Lifetime totals
          {latest ? ` as of ${latest.capturedDate} (UTC capture day)` : ""}
        </h2>
        {latest === undefined ? (
          <EmptyState title="Not captured yet">
            {POST_DATA_STATE_DESCRIPTION.unknown} Values are never shown as zero before a capture.
          </EmptyState>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {POST_VALUE_KEYS.map((key) => (
              <Card key={key} className="gap-2 py-4" data-kpi={key}>
                <CardHeader className="px-4">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    <h3>{postLabel(key)}</h3>
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4">
                  <ValueText view={postValueView(key, latest)} className="text-2xl font-semibold" />
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
      {data.snapshots.length > 0 && (
        <div className="rounded-lg border p-4" data-testid="post-snapshots">
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
