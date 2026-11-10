"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { formatRange } from "@/lib/analytics/chart-data";
import { youtubeListHref } from "@/lib/analytics/organic-filters";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import type {
  YouTubeVideoMetric,
  YouTubeVideoWindow,
  YouTubeVideoWindowName,
} from "@/lib/analytics/youtube-types";
import {
  YOUTUBE_VIDEO_COLUMNS,
  YOUTUBE_VIDEO_LABEL,
  YOUTUBE_VIDEO_STATE_DESCRIPTION,
  YOUTUBE_VIDEO_WINDOWS,
  YOUTUBE_WINDOW_LABEL,
  YOUTUBE_WINDOW_METRICS,
  YOUTUBE_WINDOW_NAME,
  YOUTUBE_WINDOW_STATE_DESCRIPTION,
  YOUTUBE_WINDOW_STATE_TEXT,
  youtubeCaptureRows,
  youtubeVideoValueView,
  youtubeWindowState,
  youtubeWindowValueView,
} from "@/lib/analytics/youtube-values";
import { cn } from "@/lib/utils";
import { DataStateBadge } from "../data-state-badge";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
import { MediaTile, VIDEO_ICON } from "../organic/media-tile";
import { OrganicSeriesChart } from "../organic/organic-series-chart";
import { YouTubeLink } from "../organic/youtube-link";
import { Breadcrumbs, PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";
import { KPI_CELL, KPI_STRIP, SECTION_HEADING, SURFACE } from "../surface";
import { ValueText } from "../value-text";

// Nine window values and three public counts fill 2 columns on phones, 3 from 640 px.
const GRID = cn(KPI_STRIP, "grid-cols-2 sm:grid-cols-3");
const CELL = cn(KPI_CELL, "min-h-22 py-3");
const VALUE = "text-lg leading-tight font-medium tracking-[-0.01em]";

const CAPTURE_METRICS = YOUTUBE_VIDEO_COLUMNS.map((value) => ({
  value,
  label: YOUTUBE_VIDEO_LABEL[value],
}));

/** One of YouTube's per-video periods: its nine values, or why it has none (never zeros). */
function WindowCard({
  name,
  values,
}: {
  name: YouTubeVideoWindowName;
  values: YouTubeVideoWindow | undefined;
}) {
  const state = youtubeWindowState(values);
  const headingId = `youtube-window-${name}`;
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2"
      data-window={name}
      data-window-state={state}
    >
      <div>
        <h3 id={headingId} className="text-sm font-medium text-ink">
          {YOUTUBE_WINDOW_NAME[name]}
        </h3>
        <p className="text-xs text-muted-foreground">
          {values ? `${formatRange(values)} (Pacific Time)` : "Pacific Time days"}
        </p>
      </div>
      {state === "reported" ? (
        <div className={GRID}>
          {YOUTUBE_WINDOW_METRICS.map((metric) => (
            <div key={metric} className={CELL} data-metric={metric}>
              <h4 className="text-[13px] font-medium text-muted-foreground">
                {YOUTUBE_WINDOW_LABEL[metric]}
              </h4>
              <ValueText view={youtubeWindowValueView(values, metric)} className={VALUE} />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-[14px] border border-dashed border-line-strong bg-paper p-6 text-center">
          <p className="text-[15px] font-medium text-ink">{YOUTUBE_WINDOW_STATE_TEXT[state]}</p>
          <p className="max-w-prose text-sm text-muted-foreground">
            {YOUTUBE_WINDOW_STATE_DESCRIPTION[state]}
          </p>
        </div>
      )}
    </section>
  );
}

function VideoDetail({ videoId }: { videoId: string }) {
  const org = useOrg();
  const { searchParams } = useDashboardFilters();
  const [metric, setMetric] = useState<YouTubeVideoMetric>("views");
  const { data } = useAnalyticsQuery(api.v1.youtubeAnalytics.video, { videoId });
  const crumbs = [
    { label: "YouTube", href: youtubeListHref(new URLSearchParams(searchParams.toString())) },
    { label: "Video" },
  ];

  if (!data) {
    return (
      <>
        <Breadcrumbs items={crumbs} />
        <Skeleton className="h-40 w-full rounded-[14px]" role="status" aria-label="Loading video" />
      </>
    );
  }
  const title = data.title ?? "Untitled video";
  const latest = data.latest;
  return (
    <>
      <Breadcrumbs items={crumbs} />
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <MediaTile icon={VIDEO_ICON} />
            <span className="min-w-0 break-words">{title}</span>
          </span>
        }
        description={`Published ${formatInstant(data.publishedAt, org.timezone)} (${org.timezone})`}
      >
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {data.removedAt && <Badge variant="outline">Removed from YouTube</Badge>}
          <YouTubeLink permalink={data.permalink} title={title} className="text-blue-deep" />
        </div>
      </PageHeader>

      <section
        aria-labelledby="youtube-analytics-heading"
        className="flex flex-col gap-3"
        data-testid="youtube-video-windows"
      >
        <div>
          <h2 id="youtube-analytics-heading" className={SECTION_HEADING}>
            YouTube Analytics
          </h2>
          <p className="text-xs text-muted-foreground">
            This video&apos;s values for each period, exactly as YouTube reported them. YouTube
            reports per-video values for the channel&apos;s 200 most-viewed videos of a period.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {YOUTUBE_VIDEO_WINDOWS.map((name) => (
            <WindowCard key={name} name={name} values={data.analytics[name]} />
          ))}
        </div>
      </section>

      <section aria-labelledby="youtube-public-counts" className="flex flex-col gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="youtube-public-counts" className={SECTION_HEADING}>
              Public counts
              {latest ? ` as of ${latest.capturedDate} (UTC capture day)` : ""}
            </h2>
            <span title={YOUTUBE_VIDEO_STATE_DESCRIPTION[data.dataState]}>
              <DataStateBadge state={data.dataState} />
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            The lifetime views, likes and comments YouTube shows on the video, not daily
            performance.
          </p>
        </div>
        {latest === undefined ? (
          <EmptyState title="Not captured yet" level={3}>
            {YOUTUBE_VIDEO_STATE_DESCRIPTION.unknown} Values are never shown as zero before a
            capture.
          </EmptyState>
        ) : (
          <div className={GRID}>
            {YOUTUBE_VIDEO_COLUMNS.map((key) => (
              <div key={key} className={CELL} data-public-count={key}>
                <h3 className="text-[13px] font-medium text-muted-foreground">
                  {YOUTUBE_VIDEO_LABEL[key]}
                </h3>
                <ValueText view={youtubeVideoValueView(latest, key)} className={VALUE} />
              </div>
            ))}
          </div>
        )}
      </section>

      {data.captures.length > 0 && (
        <div className={cn(SURFACE, "p-4")} data-testid="youtube-captures">
          <OrganicSeriesChart
            title="Public counts at each capture"
            heading={`${YOUTUBE_VIDEO_LABEL[metric]}: lifetime count at each capture (UTC)`}
            rows={youtubeCaptureRows(data.captures, metric)}
            granularity="day"
            metric={metric}
            metrics={CAPTURE_METRICS}
            onMetricChange={setMetric}
            note="Each point is the video's lifetime count at a capture (UTC day), not daily performance. Gaps are captures without a value."
          />
        </div>
      )}
    </>
  );
}

/**
 * One YouTube video (ADR 0016 Checkpoint 8): YouTube Analytics' values for the last 28 days and
 * the lifetime side by side, its public counts and their captures. Unknown or foreign -> not
 * found.
 */
export function YouTubeVideoDetailView({ videoId }: { videoId: string }) {
  return (
    <QueryBoundary resetKey={videoId} title="Video" notFoundAsPage>
      <VideoDetail videoId={videoId} />
    </QueryBoundary>
  );
}
