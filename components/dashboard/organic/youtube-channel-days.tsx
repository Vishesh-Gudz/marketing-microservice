"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/convex/_generated/api";
import { formatDateKey, formatRange } from "@/lib/analytics/chart-data";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import type { YouTubeChannelDays, YouTubeChannelDaysArgs } from "@/lib/analytics/youtube-types";
import {
  YOUTUBE_DATA_STATE_DESCRIPTION,
  YOUTUBE_DAY_COLUMNS,
  YOUTUBE_DAY_LABEL,
  YOUTUBE_DAY_STATUS_DESCRIPTION,
  YOUTUBE_DAY_STATUS_LABEL,
  youtubeAccessNotice,
  youtubeDayValueView,
} from "@/lib/analytics/youtube-values";
import { cn } from "@/lib/utils";
import { Notice } from "../notices";
import { SECTION_HEADING, SURFACE, TABLE_EDGES } from "../surface";
import { UpdatingIndicator } from "../updating-indicator";
import { ValueText } from "../value-text";
import { YouTubeDayChart } from "./youtube-day-chart";
import { YouTubeKpiStrip, YouTubeKpiStripSkeleton } from "./youtube-kpi-strip";

const STATUS_BADGE = {
  reported: "secondary",
  not_reported: "outline",
  unknown: "outline",
} as const;

/** Access (scope, re-auth, link) and coverage of the range, as the API states them. */
function ChannelNotices({ data }: { data: YouTubeChannelDays }) {
  const access = youtubeAccessNotice(data.analyticsAccess);
  const { syncedDays, unsyncedDays } = data.coverage;
  return (
    <>
      {access && (
        <Notice tone={access.tone} label={access.title}>
          <p className="font-medium">{access.title}</p>
          <p>{access.message}</p>
          {(data.analyticsAccess === "scope_missing" ||
            data.analyticsAccess === "reauth_required") && (
            <p>
              <Link href="/connections" className="font-medium underline underline-offset-4">
                Go to Connections
              </Link>
            </p>
          )}
        </Notice>
      )}
      {data.dataState === "unknown" && (
        <Notice tone="warning" label="Data not synced">
          No channel day of this range is synced yet. YouTube reports days about{" "}
          {data.reportingDelayDays} days late; missing values are never shown as zero.
        </Notice>
      )}
      {data.dataState === "partial" && (
        <Notice tone="warning" label="Partial data">
          Partial: {unsyncedDays} Pacific Time {unsyncedDays === 1 ? "day" : "days"} of this range
          not synced yet ({syncedDays} synced). YouTube reports days about {data.reportingDelayDays}{" "}
          days late, so the newest days are always unknown.
        </Notice>
      )}
    </>
  );
}

/** What the key metrics cover: the range's reported days (the server's totals). */
function totalsCoverage(data: YouTubeChannelDays): string {
  const days = data.totals.reportedDays;
  const covered =
    days === 0
      ? `No Pacific Time day of ${formatRange(data.range)} is reported yet.`
      : `Totals over the ${days} reported Pacific Time ${days === 1 ? "day" : "days"} of ${formatRange(data.range)}.`;
  return `${covered} Subscribers is the latest count, rounded by YouTube.`;
}

/** The range's key metrics, with the access and coverage notices that explain them. */
function KeyMetrics({ data, isUpdating }: { data: YouTubeChannelDays; isUpdating: boolean }) {
  return (
    <section
      aria-labelledby="youtube-key-metrics"
      className={cn("flex flex-col gap-3", isUpdating && "opacity-60")}
      aria-busy={isUpdating}
      data-testid="youtube-totals"
    >
      <div>
        <div className="flex items-center gap-2">
          <h2 id="youtube-key-metrics" className={SECTION_HEADING}>
            Key metrics
          </h2>
          <UpdatingIndicator active={isUpdating} />
        </div>
        <p className="text-xs text-muted-foreground">{totalsCoverage(data)}</p>
      </div>
      <ChannelNotices data={data} />
      <YouTubeKpiStrip data={data} />
    </section>
  );
}

/**
 * One YouTube channel over the selected Pacific Time range (v1/youtubeAnalytics:channelDays):
 * the key metrics (the server's range totals and the current subscriber count, Checkpoint 8),
 * a daily chart, and every day newest first with its status and the values YouTube reported
 * for it, under YouTube's own names. The table has no total row; the dashboard computes nothing.
 */
export function YouTubeChannelDays({ args }: { args: YouTubeChannelDaysArgs }) {
  const { data, isLoading, isUpdating } = useAnalyticsQuery(
    api.v1.youtubeAnalytics.channelDays,
    args,
  );
  if (isLoading || !data) {
    return (
      <>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-32" role="status" aria-label="Loading channel metrics" />
          <YouTubeKpiStripSkeleton />
        </div>
        <Skeleton className="h-80 w-full rounded-[14px]" aria-hidden="true" />
        <Skeleton className="h-64 w-full rounded-[14px]" aria-hidden="true" />
      </>
    );
  }
  return (
    <>
      <KeyMetrics data={data} isUpdating={isUpdating} />
      <div className="relative">
        <UpdatingIndicator active={isUpdating} overlay />
        <div
          className={cn(SURFACE, "p-4", isUpdating && "opacity-60")}
          aria-busy={isUpdating}
          data-testid="youtube-series"
        >
          <YouTubeDayChart days={data.days} reportingDelayDays={data.reportingDelayDays} />
        </div>
      </div>
      <DayTable data={data} isUpdating={isUpdating} />
    </>
  );
}

/** Every day of the range, newest first: the full data view of the chart. */
function DayTable({ data, isUpdating }: { data: YouTubeChannelDays; isUpdating: boolean }) {
  const days = [...data.days].reverse();
  const caption = `YouTube channel days ${formatRange(data.range)} (Pacific Time), as reported by YouTube`;
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="youtube-days-heading"
      aria-busy={isUpdating}
      data-testid="youtube-channel-days"
    >
      <div>
        <h2 id="youtube-days-heading" className={SECTION_HEADING}>
          Daily channel metrics (Pacific Time)
        </h2>
        <p className="text-xs text-muted-foreground">
          Source: YouTube Analytics. One row per Pacific Time day, exactly as YouTube reported it.{" "}
          {YOUTUBE_DATA_STATE_DESCRIPTION[data.dataState]}
          {data.coverage.covered &&
            ` Synced through ${formatDateKey(data.coverage.covered.through)}.`}
        </p>
      </div>
      <div className="relative">
        <UpdatingIndicator active={isUpdating} overlay />
        <div
          role="region"
          aria-label="Channel days table"
          // Focusable so keyboard users can scroll the days (they hold no other tab stop). The
          // table's own wrapper does not scroll, so this one surface scrolls both ways and the
          // header row stays in view.
          tabIndex={0}
          className={cn(
            SURFACE,
            "max-h-[32rem] overflow-auto focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&>[data-slot=table-container]]:overflow-visible",
            isUpdating && "opacity-60",
          )}
        >
          <Table className={TABLE_EDGES}>
            <TableCaption className="sr-only">{caption}</TableCaption>
            <TableHeader className="sticky top-0 z-10 bg-paper">
              <TableRow>
                <TableHead scope="col">Day (PT)</TableHead>
                <TableHead scope="col">Status</TableHead>
                {YOUTUBE_DAY_COLUMNS.map((metric) => (
                  <TableHead key={metric} scope="col" className="text-right">
                    {YOUTUBE_DAY_LABEL[metric]}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {days.map((day) => (
                <TableRow key={day.date} data-day={day.date} data-status={day.status}>
                  <TableCell className="font-medium whitespace-nowrap">
                    {formatDateKey(day.date)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={STATUS_BADGE[day.status]}
                      title={YOUTUBE_DAY_STATUS_DESCRIPTION[day.status]}
                    >
                      {YOUTUBE_DAY_STATUS_LABEL[day.status]}
                    </Badge>
                  </TableCell>
                  {YOUTUBE_DAY_COLUMNS.map((metric) => (
                    <TableCell key={metric} className="text-right">
                      {day.status === "reported" ? (
                        <ValueText view={youtubeDayValueView(day, metric)} />
                      ) : (
                        // The status cell explains the whole row: no per-cell tooltip (no 3,200
                        // extra tab stops on a 400-day range).
                        <span className="text-muted-foreground">
                          <span aria-hidden="true">—</span>
                          <span className="sr-only">no value</span>
                        </span>
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </section>
  );
}
