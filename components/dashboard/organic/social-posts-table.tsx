"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import Link from "next/link";
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
import { filterParamsOnly } from "@/lib/analytics/filters";
import { humanize } from "@/lib/analytics/labels";
import {
  postPublishFilter,
  SOCIAL_POST_PAGE_SIZES,
  type PostOrder,
} from "@/lib/analytics/organic-filters";
import { useOrg } from "@/lib/analytics/org-context";
import { POST_DATA_STATE_DESCRIPTION } from "@/lib/analytics/organic-states";
import type { SocialPost } from "@/lib/analytics/organic-types";
import { postLabel, postValueView, type PostValueKey } from "@/lib/analytics/organic-values";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import { cn } from "@/lib/utils";
import { DataStateBadge } from "../data-state-badge";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
import { UpdatingIndicator } from "../updating-indicator";
import { ValueText } from "../value-text";
import { InstagramLink } from "./instagram-link";

const COLUMNS: readonly PostValueKey[] = [
  "views",
  "reach",
  "likes",
  "comments",
  "shares",
  "saves",
  "totalInteractions",
  "engagementRate",
];

/** Link to a post's page, carrying the global filters and the selected account. */
export function postHref(post: SocialPost, params: URLSearchParams): string {
  const query = filterParamsOnly(params);
  query.set("account", post.socialAccountId);
  return `/social/posts/${post.id}?${query.toString()}`;
}

/**
 * The selected account's posts published in the selected range (publish days in the
 * ORGANIZATION timezone, B2 semantics) with the LIFETIME totals of each post's latest capture:
 * cumulative values, not daily performance. Server-side order by publish time and cursor
 * pagination only (the cursor stack restarts when the arguments change).
 */
export function SocialPostsTable({
  socialAccountId,
  range,
  postOrder,
}: {
  socialAccountId: string;
  range: DateRange;
  postOrder: PostOrder;
}) {
  const pageSizeLabelId = useId();
  const org = useOrg();
  const { searchParams, setParams } = useDashboardFilters();
  const params = new URLSearchParams(searchParams.toString());
  const [numItems, setNumItems] = useState<number>(SOCIAL_POST_PAGE_SIZES[0]);
  const baseArgs = {
    socialAccountId,
    ...postPublishFilter(range),
    sort: { by: "publishedAt" as const, dir: postOrder },
  };
  const argsKey = JSON.stringify([baseArgs, numItems]);
  const [paging, setPaging] = useState({ key: argsKey, cursors: [null] as (string | null)[] });
  if (paging.key !== argsKey) setPaging({ key: argsKey, cursors: [null] });
  const cursors = paging.key === argsKey ? paging.cursors : [null];
  const cursor = cursors[cursors.length - 1] ?? null;
  const { data, isLoading, isUpdating } = useAnalyticsQuery(api.v1.socialPosts.list, {
    ...baseArgs,
    paginationOpts: { numItems, cursor },
  });
  const pageNumber = cursors.length;
  const caption = `Posts published ${formatRange(range)} (${org.timezone}), with lifetime totals at their latest capture`;
  const SortIcon = postOrder === "asc" ? ArrowUp : ArrowDown;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="posts-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="posts-heading" className="text-base font-semibold">
            Posts — lifetime totals
          </h2>
          <p className="text-xs text-muted-foreground">
            Published {formatRange(range)} in {org.timezone}. Each value is the post&apos;s lifetime
            total at its latest capture, not daily performance.
          </p>
        </div>
        <UpdatingIndicator active={isUpdating} />
      </div>
      <div
        className={cn("overflow-x-auto rounded-md border", isUpdating && "opacity-60")}
        aria-busy={isLoading || isUpdating}
      >
        <Table>
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead
                scope="col"
                aria-sort={postOrder === "asc" ? "ascending" : "descending"}
                className="sticky left-0 z-10 min-w-64 bg-background"
              >
                <button
                  type="button"
                  onClick={() => setParams({ pdir: postOrder === "asc" ? undefined : "asc" })}
                  className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  Post (published)
                  <SortIcon className="size-3.5" aria-hidden="true" />
                  <span className="sr-only">
                    , sorted {postOrder === "asc" ? "oldest first" : "newest first"}
                  </span>
                </button>
              </TableHead>
              {COLUMNS.map((key) => (
                <TableHead key={key} scope="col" className="text-right">
                  {postLabel(key)}
                </TableHead>
              ))}
              <TableHead scope="col">As of (UTC)</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Instagram link</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 5 }, (_, i) => (
                <TableRow key={i} aria-hidden="true">
                  <TableCell colSpan={COLUMNS.length + 3}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {data?.page.map((post) => (
              <TableRow key={post.id} data-post-id={post.id}>
                <TableCell className="sticky left-0 z-10 bg-background whitespace-normal">
                  <div className="flex max-w-80 flex-col gap-1">
                    <Link
                      href={postHref(post, params)}
                      className="line-clamp-2 font-medium underline-offset-4 hover:underline"
                    >
                      {post.caption ?? `${humanize(post.type)} post`}
                    </Link>
                    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      <Badge variant="outline">{humanize(post.type)}</Badge>
                      <span>{formatInstant(post.publishedAt, org.timezone)}</span>
                      {post.removedAt && <Badge variant="outline">Removed</Badge>}
                      <span title={POST_DATA_STATE_DESCRIPTION[post.dataState]}>
                        <DataStateBadge state={post.dataState} />
                      </span>
                    </div>
                  </div>
                </TableCell>
                {COLUMNS.map((key) => (
                  <TableCell key={key} className="text-right align-top">
                    <ValueText view={postValueView(key, post.latest)} />
                  </TableCell>
                ))}
                <TableCell className="align-top text-muted-foreground">
                  {post.latest?.capturedDate ?? "—"}
                </TableCell>
                <TableCell className="align-top">
                  <InstagramLink permalink={post.permalink} className="whitespace-nowrap" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {data && data.page.length === 0 && (
          <EmptyState className="m-4" title="No posts published in this range">
            No organic post of this account was published {formatRange(range)} ({org.timezone}), or
            none has been synced yet.
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
