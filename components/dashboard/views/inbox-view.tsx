"use client";

import { BookmarkPlus } from "lucide-react";
import { usePaginatedQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChannelLogo } from "@/components/brand/channel-logo";
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
import { ThreadList, ThreadListSkeleton } from "../messaging/thread-list";
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
      <span id="inbox-channel-label" className="sr-only">
        Channel
      </span>
      <ToggleGroup
        type="single"
        size="sm"
        spacing={0.5}
        role="group"
        aria-labelledby="inbox-channel-label"
        value={value}
        // A single toggle group can be cleared by clicking the selected item: keep a choice.
        onValueChange={(next) => next !== "" && onChange(next as Filter)}
        className="rounded-[10px] border border-line bg-canvas p-0.5"
      >
        {FILTERS.map((filter) => (
          <ToggleGroupItem
            key={filter}
            value={filter}
            className="h-8 rounded-[8px] px-3.5 text-muted-foreground hover:bg-transparent hover:text-ink data-[state=on]:bg-paper data-[state=on]:text-ink data-[state=on]:shadow-soft"
          >
            {filter !== "all" && <ChannelLogo channel={filter} className="size-3.5" />}
            {FILTER_LABELS[filter]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

function Threads({ filter }: { filter: Filter }) {
  const { timezone } = useOrg();
  const now = useNow();
  const { results, status, loadMore } = usePaginatedQuery(
    api.v1.inbox.listThreads,
    filter === "all" ? {} : { channel: filter },
    { initialNumItems: THREADS_PER_PAGE },
  );

  if (status === "LoadingFirstPage") return <ThreadListSkeleton />;
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
    <ThreadList
      rows={results.map((thread) => {
        const state = replyStateAt(thread, now);
        return {
          id: thread.id,
          href: threadHref(thread),
          channel: thread.channel,
          channelLabel: CHANNEL_LABELS[thread.channel],
          contact: thread.contactLabel,
          account: `To ${thread.accountLabel}`,
          state: { tone: state, label: REPLY_STATE_LABELS[state] },
          at: thread.lastMessageAt,
          atText: formatInstant(thread.lastMessageAt, timezone),
        };
      })}
      canLoadMore={status !== "Exhausted"}
      loadingMore={status === "LoadingMore"}
      onLoadMore={() => loadMore(THREADS_PER_PAGE)}
    />
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
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/inbox/saved-replies">
              <BookmarkPlus aria-hidden="true" />
              Saved replies
            </Link>
          </Button>
        }
      />
      <div className="flex flex-col gap-3">
        <ChannelFilter value={filter} onChange={setFilter} />
        <QueryBoundary resetKey={`inbox-${filter}`} title="Conversations">
          <Threads filter={filter} />
        </QueryBoundary>
      </div>
    </div>
  );
}
