"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { formatCount } from "@/lib/analytics/format";
import { useOrg } from "@/lib/analytics/org-context";
import type { YouTubeChannelDays } from "@/lib/analytics/youtube-types";
import {
  YOUTUBE_KPI_LABEL,
  YOUTUBE_KPIS,
  youtubeKpiValueView,
  type YouTubeKpiKey,
} from "@/lib/analytics/youtube-values";
import { cn } from "@/lib/utils";
import { formatInstant } from "../freshness-note";
import { KPI_CELL, KPI_STRIP } from "../surface";
import { ValueText } from "../value-text";

// Eight key metrics fill 2 or 4 columns.
const STRIP = cn(KPI_STRIP, "grid-cols-2 sm:grid-cols-4");

/** The small line under a value: when the count was captured, or the server's parts of it. */
function kpiNote(key: YouTubeKpiKey, data: YouTubeChannelDays, timezone: string) {
  const totals = data.totals.metrics;
  switch (key) {
    case "subscribers":
      return data.subscribers && `as of ${formatInstant(data.subscribers.capturedAt, timezone)}`;
    case "estimatedMinutesWatched":
      return (
        totals.estimatedMinutesWatched !== undefined &&
        `${formatCount(totals.estimatedMinutesWatched)} est. minutes`
      );
    case "subscribersNet":
      return (
        totals.subscribersGained !== undefined &&
        totals.subscribersLost !== undefined &&
        `${formatCount(totals.subscribersGained)} gained, ${formatCount(totals.subscribersLost)} lost`
      );
    default:
      return undefined;
  }
}

/**
 * The channel's key metrics for the range (ADR 0016 Checkpoint 8): the current subscriber count
 * and the server's totals over the range's reported Pacific Time days. A missing value is "—"
 * with the reason, never 0; a partly synced range marks its totals as partial.
 */
export function YouTubeKpiStrip({ data }: { data: YouTubeChannelDays }) {
  const { timezone } = useOrg();
  return (
    <div className={STRIP}>
      {YOUTUBE_KPIS.map((key) => {
        const view = youtubeKpiValueView(key, data);
        const note = kpiNote(key, data, timezone);
        return (
          <div key={key} className={KPI_CELL} data-kpi={key}>
            <h3 className="text-[13px] font-medium text-muted-foreground">
              {YOUTUBE_KPI_LABEL[key]}
            </h3>
            <ValueText
              view={view}
              className="text-2xl leading-tight font-medium tracking-[-0.02em]"
            />
            {note && view.kind === "value" && (
              <p className="text-xs text-muted-foreground">{note}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function YouTubeKpiStripSkeleton() {
  return (
    <div className={STRIP} aria-hidden="true">
      {YOUTUBE_KPIS.map((key) => (
        <div key={key} className={KPI_CELL}>
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-7 w-24" />
        </div>
      ))}
    </div>
  );
}
