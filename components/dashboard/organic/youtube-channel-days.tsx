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
import { UpdatingIndicator } from "../updating-indicator";
import { ValueText } from "../value-text";

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

/**
 * One YouTube channel's days over the selected Pacific Time range
 * (v1/youtubeAnalytics:channelDays), newest first: each day's status and the values YouTube
 * reported for it, under YouTube's own names. No total, average, rate or comparison row: a
 * partial range can never pass for a complete one.
 */
export function YouTubeChannelDays({ args }: { args: YouTubeChannelDaysArgs }) {
  const { data, isLoading, isUpdating } = useAnalyticsQuery(
    api.v1.youtubeAnalytics.channelDays,
    args,
  );
  if (isLoading || !data) {
    return <Skeleton className="h-64 w-full" role="status" aria-label="Loading channel days" />;
  }
  const days = [...data.days].reverse();
  const caption = `YouTube channel days ${formatRange(data.range)} (Pacific Time), as reported by YouTube`;
  return (
    <section
      className={cn("flex flex-col gap-3", isUpdating && "opacity-60")}
      aria-labelledby="youtube-days-heading"
      aria-busy={isUpdating}
      data-testid="youtube-channel-days"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="youtube-days-heading" className="text-base font-semibold">
            Daily channel metrics (Pacific Time)
          </h2>
          <p className="text-xs text-muted-foreground">
            Source: YouTube Analytics. One row per Pacific Time day, exactly as YouTube reported it
            — no totals or averages across days. {YOUTUBE_DATA_STATE_DESCRIPTION[data.dataState]}
            {data.coverage.covered &&
              ` Synced through ${formatDateKey(data.coverage.covered.through)}.`}
          </p>
        </div>
        <UpdatingIndicator active={isUpdating} />
      </div>
      <ChannelNotices data={data} />
      <div className="max-h-[32rem] overflow-auto rounded-md border">
        <Table>
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableHeader className="sticky top-0 z-10 bg-background">
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
    </section>
  );
}
