"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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
import type { DateRange } from "@/convex/analytics/periods";
import { formatRange } from "@/lib/analytics/chart-data";
import {
  postPublishFilter,
  SOCIAL_POST_PAGE_SIZES,
  youtubeVideoHref,
  type PostOrder,
  type VideoWindow,
} from "@/lib/analytics/organic-filters";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import {
  YOUTUBE_VIDEO_WINDOWS,
  YOUTUBE_WINDOW_COLUMNS,
  YOUTUBE_WINDOW_LABEL,
  YOUTUBE_WINDOW_NAME,
  YOUTUBE_WINDOW_STATE_DESCRIPTION,
  YOUTUBE_WINDOW_STATE_TEXT,
  youtubeWindowState,
  youtubeWindowValueView,
} from "@/lib/analytics/youtube-values";
import { cn } from "@/lib/utils";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
import { SEGMENT, SEGMENTED } from "../library";
import { SECTION_HEADING, SURFACE, TABLE_EDGES } from "../surface";
import { TablePager } from "../table-pager";
import { UpdatingIndicator } from "../updating-indicator";
import { ValueText } from "../value-text";
import { MediaTile, VIDEO_ICON } from "./media-tile";
import { YouTubeLink } from "./youtube-link";

/** Last 28 days | Lifetime: which of YouTube's per-video periods the columns show (URL state). */
function WindowSwitch({
  value,
  onChange,
}: {
  value: VideoWindow;
  onChange: (next: VideoWindow) => void;
}) {
  return (
    <div role="group" aria-label="Video analytics period" className={SEGMENTED}>
      {YOUTUBE_VIDEO_WINDOWS.map((option) => (
        <button
          key={option}
          type="button"
          className={SEGMENT}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {YOUTUBE_WINDOW_NAME[option]}
        </button>
      ))}
    </div>
  );
}

/**
 * The selected channel's videos published in the selected range (publish days in the
 * ORGANIZATION timezone, as for Instagram posts) with YouTube Analytics' values for ONE period
 * of each video (ADR 0016 Checkpoint 8): the last 28 days or the lifetime, exactly as YouTube
 * reported them for its top 200 videos of that period. A video outside the top 200 or not
 * synced yet says so instead of showing values; nothing is added up. The public counts and
 * their captures are on the video's page. Server-side order by publish time and cursor
 * pagination only (the cursor stack restarts when the arguments change).
 */
export function YouTubeVideosTable({
  socialAccountId,
  range,
  order,
  videoWindow,
}: {
  socialAccountId: string;
  range: DateRange;
  order: PostOrder;
  videoWindow: VideoWindow;
}) {
  const org = useOrg();
  const { searchParams, setParams } = useDashboardFilters();
  const params = new URLSearchParams(searchParams.toString());
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
  const columns = YOUTUBE_WINDOW_COLUMNS.length + 2;
  // Every video of the channel shares the period's days; any synced one names them.
  const period = data?.page
    .map((video) => video.analytics[videoWindow])
    .find((value) => value !== undefined);
  const periodText = `${YOUTUBE_WINDOW_NAME[videoWindow]}${period ? `: ${formatRange(period)} (Pacific Time)` : ""}`;

  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="videos-heading"
      data-testid="youtube-videos"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-80 flex-col gap-0.5">
          <h2 id="videos-heading" className={SECTION_HEADING}>
            Videos
          </h2>
          <p className="text-xs text-muted-foreground">
            Published {formatRange(range)} in {org.timezone}. {periodText}, from YouTube Analytics,
            which reports per-video values for the channel&apos;s 200 most-viewed videos of a
            period. Open a video for its public counts.
          </p>
        </div>
        <WindowSwitch
          value={videoWindow}
          onChange={(next) => setParams({ vwin: next === "lifetime" ? next : undefined })}
        />
      </div>
      <div className="relative">
        <UpdatingIndicator active={isUpdating} overlay />
        <div
          className={cn(SURFACE, "overflow-x-auto", isUpdating && "opacity-60")}
          aria-busy={isLoading || isUpdating}
        >
          <Table className={TABLE_EDGES}>
            <TableCaption className="sr-only">
              YouTube videos published {formatRange(range)} ({org.timezone}), with YouTube Analytics
              values for {periodText}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead
                  scope="col"
                  aria-sort={order === "asc" ? "ascending" : "descending"}
                  className="sticky left-0 z-10 min-w-56 bg-paper sm:min-w-72"
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
                {YOUTUBE_WINDOW_COLUMNS.map((metric) => (
                  <TableHead key={metric} scope="col" className="text-right">
                    {YOUTUBE_WINDOW_LABEL[metric]}
                  </TableHead>
                ))}
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
                const values = video.analytics[videoWindow];
                const state = youtubeWindowState(values);
                return (
                  <TableRow key={video.id} data-video-id={video.id} data-window-state={state}>
                    <TableCell className="sticky left-0 z-10 bg-paper whitespace-normal group-hover/row:bg-canvas">
                      <div className="flex max-w-80 items-start gap-3">
                        <MediaTile icon={VIDEO_ICON} />
                        <div className="flex min-w-0 flex-col gap-1">
                          <Link
                            href={youtubeVideoHref(video, params)}
                            className="line-clamp-2 font-medium underline-offset-4 hover:underline"
                          >
                            {title}
                          </Link>
                          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                            <span>{formatInstant(video.publishedAt, org.timezone)}</span>
                            {video.removedAt && <Badge variant="outline">Removed</Badge>}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    {state === "reported" ? (
                      YOUTUBE_WINDOW_COLUMNS.map((metric) => (
                        <TableCell key={metric} className="text-right align-top">
                          <ValueText view={youtubeWindowValueView(values, metric)} />
                        </TableCell>
                      ))
                    ) : (
                      // One cell says why the whole period has no values (never a row of 0s).
                      <TableCell
                        colSpan={YOUTUBE_WINDOW_COLUMNS.length}
                        className="align-top text-muted-foreground"
                        title={YOUTUBE_WINDOW_STATE_DESCRIPTION[state]}
                      >
                        {YOUTUBE_WINDOW_STATE_TEXT[state]}
                      </TableCell>
                    )}
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
      </div>
      <TablePager
        sizes={SOCIAL_POST_PAGE_SIZES}
        numItems={numItems}
        onNumItemsChange={setNumItems}
        pageNumber={pageNumber}
        onPrevious={() => setPaging({ key: argsKey, cursors: cursors.slice(0, -1) })}
        onNext={() =>
          data && setPaging({ key: argsKey, cursors: [...cursors, data.continueCursor] })
        }
        nextDisabled={!data || data.isDone || isUpdating}
      />
    </section>
  );
}
