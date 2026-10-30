"use client";

import { usePaginatedQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import {
  CHANNEL_LABELS,
  REPLY_STATE_LABELS,
  replyStateAt,
  threadHref,
  type InboxChannel,
} from "@/lib/inbox/threads";
import { useNow } from "@/lib/whatsapp/inbox";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
import { PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";

/** Conversations loaded per page, newest activity first. */
const THREADS_PER_PAGE = 25;

type Filter = "all" | InboxChannel;
const FILTERS: readonly Filter[] = ["all", "whatsapp", "instagram"];
const FILTER_LABELS: Readonly<Record<Filter, string>> = { all: "All", ...CHANNEL_LABELS };

function ChannelFilter({ value, onChange }: { value: Filter; onChange: (next: Filter) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span id="inbox-channel-label" className="text-sm text-muted-foreground">
        Channel
      </span>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        role="group"
        aria-labelledby="inbox-channel-label"
        value={value}
        // A single toggle group can be cleared by clicking the selected item: keep a choice.
        onValueChange={(next) => next !== "" && onChange(next as Filter)}
      >
        {FILTERS.map((filter) => (
          <ToggleGroupItem key={filter} value={filter} className="px-3">
            {FILTER_LABELS[filter]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function ThreadList({ filter }: { filter: Filter }) {
  const { timezone } = useOrg();
  const now = useNow();
  const { results, status, loadMore } = usePaginatedQuery(
    api.v1.inbox.listThreads,
    filter === "all" ? {} : { channel: filter },
    { initialNumItems: THREADS_PER_PAGE },
  );

  if (status === "LoadingFirstPage") {
    return <Skeleton className="h-40 w-full" role="status" aria-label="Loading conversations" />;
  }
  if (results.length === 0) {
    return (
      <EmptyState title="No conversations yet">
        {filter === "all"
          ? "Conversations from your WhatsApp numbers and Instagram accounts appear here as customers write to you."
          : `Conversations from ${CHANNEL_LABELS[filter]} appear here as customers write to you.`}
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Conversations" className="flex flex-col divide-y rounded-lg border">
        {results.map((thread) => {
          const state = replyStateAt(thread, now);
          return (
            <li key={thread.id}>
              <Link
                href={threadHref(thread)}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-accent focus-visible:bg-accent"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-2">
                    <Badge variant="outline">{CHANNEL_LABELS[thread.channel]}</Badge>
                    <span className="truncate font-medium">{thread.contactLabel}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">To {thread.accountLabel}</span>
                </span>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                  <Badge variant={state === "open" ? "secondary" : "outline"}>
                    {REPLY_STATE_LABELS[state]}
                  </Badge>
                  <time dateTime={thread.lastMessageAt}>
                    {formatInstant(thread.lastMessageAt, timezone)}
                  </time>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {status !== "Exhausted" && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={status === "LoadingMore"}
          onClick={() => loadMore(THREADS_PER_PAGE)}
        >
          {status === "LoadingMore" ? "Loading…" : "Show more conversations"}
        </Button>
      )}
    </div>
  );
}

/**
 * The unified inbox (ADR 0018, IM7.4): the org's WhatsApp and Instagram conversations, most
 * recent activity first, each opening the channel's own conversation page (its history and
 * composer). Every member may read. The per-channel pages stay as they are.
 */
export function InboxView() {
  const [filter, setFilter] = useState<Filter>("all");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Inbox"
        description="Messages from your customers on WhatsApp and Instagram, newest first."
      >
        <div className="pt-2">
          <ChannelFilter value={filter} onChange={setFilter} />
        </div>
      </PageHeader>
      <QueryBoundary resetKey={`inbox-${filter}`} title="Conversations">
        <ThreadList filter={filter} />
      </QueryBoundary>
    </div>
  );
}
