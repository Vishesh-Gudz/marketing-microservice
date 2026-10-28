"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import type { DateRange } from "@/convex/analytics/periods";
import { formatRange } from "@/lib/analytics/chart-data";
import {
  postPublishFilter,
  SOCIAL_POST_PAGE_SIZES,
  type PostOrder,
} from "@/lib/analytics/organic-filters";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import {
  YOUTUBE_VIDEO_COLUMNS,
  YOUTUBE_VIDEO_LABEL,
  YOUTUBE_VIDEO_STATE_DESCRIPTION,
  youtubeVideoValueView,
} from "@/lib/analytics/youtube-values";
import { cn } from "@/lib/utils";
import { DataStateBadge } from "../data-state-badge";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
import { UpdatingIndicator } from "../updating-indicator";
import { ValueText } from "../value-text";
import { YouTubeLink } from "./youtube-link";

/**
 * The selected channel's videos published in the selected range (publish days in the
 * ORGANIZATION timezone, as for Instagram posts) with the LIFETIME views, likes and comments
 * of each video's latest capture (v1/youtubeAnalytics:videos): cumulative values, not daily
 * performance, never added up. Server-side order by publish time and cursor pagination only
 * (the cursor stack restarts when the arguments change).
 */
export function YouTubeVideosTable({
  socialAccountId,
  range,
  order,
}: {
  socialAccountId: string;
  range: DateRange;
  order: PostOrder;
}) {
  const pageSizeLabelId = useId();
  const org = useOrg();
  const { setParams } = useDashboardFilters();
  const [numItems, setNumItems] = useState<number>(SOCIAL_POST_PAGE_SIZES[0]);
  const baseArgs = {
    socialAccountId,
    ...postPublishFilter(range),
    sort: { by: "publishedAt" as const, dir: order },
  };
  const argsKey = JSON.stringify([baseArgs, numItems]);
  const [paging, setPaging] = useState({ key: argsKey, cursors: [null] as (string | null)[] });
  if (paging.key !== argsKey) setPaging({ key: argsKey, cursors: [null] });
  const cursors = paging.key === argsKey ? paging.cursors : [null];
  const cursor = cursors[cursors.length - 1] ?? null;
  const { data, isLoading, isUpdating } = useAnalyticsQuery(api.v1.youtubeAnalytics.videos, {
    ...baseArgs,
    paginationOpts: { numItems, cursor },
  });
  const pageNumber = cursors.length;
  const SortIcon = order === "asc" ? ArrowUp : ArrowDown;
  const columns = YOUTUBE_VIDEO_COLUMNS.length + 3;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="videos-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="videos-heading" className="text-base font-semibold">
            Videos — lifetime statistics
          </h2>
          <p className="text-xs text-muted-foreground">
            Source: YouTube. Published {formatRange(range)} in {org.timezone}. Each value is the
            video&apos;s lifetime count at its latest capture (UTC capture day), not daily
            performance.
          </p>
        </div>
        <UpdatingIndicator active={isUpdating} />
      </div>
      <div
        className={cn("overflow-x-auto rounded-md border", isUpdating && "opacity-60")}
        aria-busy={isLoading || isUpdating}
      >
        <Table>
          <TableCaption className="sr-only">
            YouTube videos published {formatRange(range)} ({org.timezone}), with lifetime statistics
            at their latest capture
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead
                scope="col"
                aria-sort={order === "asc" ? "ascending" : "descending"}
                className="sticky left-0 z-10 min-w-64 bg-background"
              >
                <button
                  type="button"
                  onClick={() => setParams({ pdir: order === "asc" ? undefined : "asc" })}
                  className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  Video (published)
                  <SortIcon className="size-3.5" aria-hidden="true" />
                  <span className="sr-only">
                    , sorted {order === "asc" ? "oldest first" : "newest first"}
                  </span>
                </button>
              </TableHead>
              {YOUTUBE_VIDEO_COLUMNS.map((metric) => (
                <TableHead key={metric} scope="col" className="text-right">
                  {YOUTUBE_VIDEO_LABEL[metric]}
                </TableHead>
              ))}
              <TableHead scope="col">As of (UTC)</TableHead>
              <TableHead scope="col">
                <span className="sr-only">YouTube link</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 5 }, (_, i) => (
                <TableRow key={i} aria-hidden="true">
                  <TableCell colSpan={columns}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {data?.page.map((video) => {
              const title = video.title ?? "Untitled video";
              return (
                <TableRow key={video.id} data-video-id={video.id}>
                  <TableCell className="sticky left-0 z-10 bg-background whitespace-normal">
                    <div className="flex max-w-80 flex-col gap-1">
                      <span className="line-clamp-2 font-medium">{title}</span>
                      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        <span>{formatInstant(video.publishedAt, org.timezone)}</span>
                        {video.removedAt && <Badge variant="outline">Removed</Badge>}
                        <span title={YOUTUBE_VIDEO_STATE_DESCRIPTION[video.dataState]}>
                          <DataStateBadge state={video.dataState} />
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  {YOUTUBE_VIDEO_COLUMNS.map((metric) => (
                    <TableCell key={metric} className="text-right align-top">
                      <ValueText view={youtubeVideoValueView(video.latest, metric)} />
                    </TableCell>
                  ))}
                  <TableCell className="align-top text-muted-foreground">
                    {video.latest?.capturedDate ?? "—"}
                  </TableCell>
                  <TableCell className="align-top">
                    <YouTubeLink
                      permalink={video.permalink}
                      title={title}
                      className="whitespace-nowrap"
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {data && data.page.length === 0 && (
          <EmptyState className="m-4" title="No videos published in this range">
            No video of this channel was published {formatRange(range)} ({org.timezone}), or none
            has been synced yet.
          </EmptyState>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex items-center gap-2">
          <span id={pageSizeLabelId} className="text-muted-foreground">
            Rows per page
          </span>
          <Select value={String(numItems)} onValueChange={(value) => setNumItems(Number(value))}>
            <SelectTrigger size="sm" aria-labelledby={pageSizeLabelId} className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOCIAL_POST_PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground" aria-live="polite">
            Page {pageNumber}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pageNumber === 1}
            onClick={() => setPaging({ key: argsKey, cursors: cursors.slice(0, -1) })}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!data || data.isDone || isUpdating}
            onClick={() =>
              data && setPaging({ key: argsKey, cursors: [...cursors, data.continueCursor] })
            }
          >
            Next
          </Button>
        </div>
      </div>
    </section>
  );
}
