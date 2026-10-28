"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { formatDateKey } from "@/lib/analytics/chart-data";
import { humanize } from "@/lib/analytics/labels";
import { useOrg } from "@/lib/analytics/org-context";
import { parseSocialParams } from "@/lib/analytics/organic-filters";
import type { SocialAccount } from "@/lib/analytics/organic-types";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { useAnalyticsScope, useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import type { YouTubeChannelDaysArgs } from "@/lib/analytics/youtube-types";
import { EmptyState } from "../empty-state";
import { FilterBar } from "../filter-bar";
import { formatInstant } from "../freshness-note";
import { Notice } from "../notices";
import { SocialAccountPicker } from "../organic/social-account-picker";
import { YouTubeChannelDays } from "../organic/youtube-channel-days";
import { YouTubeVideosTable } from "../organic/youtube-videos-table";
import { PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";

/** The selected channel's identity, source, link state and freshness (v1/socialAccounts:get). */
function ChannelSummary({ channel }: { channel: SocialAccount }) {
  const { timezone } = useOrg();
  return (
    <div className="flex flex-col gap-1" data-testid="youtube-channel-summary">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{channel.name}</span>
        {channel.username !== undefined && (
          <span className="text-muted-foreground">@{channel.username}</span>
        )}
        <Badge variant="secondary">Source: YouTube</Badge>
        <Badge variant="outline">{humanize(channel.accountType)}</Badge>
        {!channel.linked && <Badge variant="outline">Unlinked — history only</Badge>}
      </div>
      <p className="text-xs text-muted-foreground" data-testid="youtube-freshness">
        {channel.lastSyncedAt === undefined && channel.coverage === undefined
          ? "History loading: the first sync of this channel has not finished yet."
          : [
              channel.coverage
                ? `Channel days synced through ${formatDateKey(channel.coverage.through)} (Pacific Time)`
                : "",
              channel.lastSyncedAt
                ? `last synced ${formatInstant(channel.lastSyncedAt, timezone)} (${timezone})`
                : "",
            ]
              .filter(Boolean)
              .join(" · ")}
      </p>
    </div>
  );
}

/**
 * YouTube organic (ADR 0016, Checkpoint 5): ONE channel at a time, separate from Instagram and
 * paid analytics. Channel days are YouTube's Pacific Time days (presets resolve against today
 * in Pacific Time); videos are filtered by publish day in the org timezone and show lifetime
 * statistics. Every value comes from v1/youtubeAnalytics exactly as YouTube reported it: no
 * total, average, rate, change, score or cross-channel / cross-platform figure is computed.
 */
export function YouTubeView({ switcher }: { switcher?: ReactNode }) {
  const { searchParams, setParams } = useDashboardFilters();
  const social = parseSocialParams(new URLSearchParams(searchParams.toString()));
  const scope = useAnalyticsScope({ dayBasis: "pacific" });
  const accounts = useAnalyticsQuery(api.v1.socialAccounts.list, {
    paginationOpts: { numItems: 100, cursor: null },
  });

  const header = (
    <>
      <PageHeader
        title="YouTube (organic)"
        description="Daily channel metrics and video statistics exactly as YouTube reports them — separate from Instagram and paid ads. Channel days are Pacific Time days."
      />
      {switcher}
    </>
  );

  if (accounts.isLoading || !accounts.data) {
    return (
      <>
        {header}
        <Skeleton className="h-16 w-full" role="status" aria-label="Loading YouTube channels" />
      </>
    );
  }
  const channels = accounts.data.page.filter((account) => account.platform === "youtube");
  if (channels.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          title="No YouTube channel connected"
          action={
            <Link href="/connections" className="text-sm font-medium underline underline-offset-4">
              Connect YouTube on the Connections page
            </Link>
          }
        >
          YouTube analytics needs a YouTube channel that is connected and linked. Once its first
          sync finishes, its daily metrics and video statistics appear here.
        </EmptyState>
      </>
    );
  }

  const selectedId = social.account ?? channels[0]!.id;
  const selected = channels.find((channel) => channel.id === selectedId);
  const picker = (
    <SocialAccountPicker
      accounts={channels}
      selectedId={selectedId}
      onSelect={(accountId) => setParams({ account: accountId })}
      truncated={!accounts.data.isDone}
      label="YouTube channel"
    />
  );
  if (selected === undefined) {
    return (
      <>
        {header}
        {picker}
        <EmptyState title="This YouTube channel is not available">
          The channel in the link does not exist, was deleted, or is not visible to your
          organization. Choose one of your channels above.
        </EmptyState>
      </>
    );
  }
  if (selected.status === "disconnected") {
    // ADR 0016: the channel was disconnected or unlinked; its stored data is being deleted.
    return (
      <>
        {header}
        {picker}
        <div role="status">
          <Notice tone="info" label="Deleting stored data">
            <p className="font-medium">This channel&apos;s stored YouTube data is being deleted</p>
            <p>
              It was disconnected or unlinked, so its daily metrics and video statistics are being
              removed. This channel disappears from the list once the deletion is complete.
            </p>
          </Notice>
        </div>
      </>
    );
  }

  const daysArgs: YouTubeChannelDaysArgs = { socialAccountId: selectedId, range: scope.range };
  return (
    <>
      {header}
      <div className="flex flex-wrap items-end justify-between gap-3">
        {picker}
        <ChannelSummary channel={selected} />
      </div>
      <FilterBar dayBasis="pacific" accounts={false} compare={false} />
      <QueryBoundary resetKey={JSON.stringify(daysArgs)} title="Channel days">
        <YouTubeChannelDays args={daysArgs} />
      </QueryBoundary>
      <QueryBoundary
        resetKey={JSON.stringify([selectedId, scope.range, social.postOrder])}
        title="Videos"
      >
        <YouTubeVideosTable
          socialAccountId={selectedId}
          range={scope.range}
          order={social.postOrder}
        />
      </QueryBoundary>
      <p className="text-xs text-muted-foreground">
        To delete this channel&apos;s stored YouTube data, disconnect YouTube on the{" "}
        <Link href="/connections" className="underline underline-offset-4">
          Connections
        </Link>{" "}
        page.
      </p>
    </>
  );
}
