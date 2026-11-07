"use client";

import { BookmarkPlus } from "lucide-react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { CHANNEL_LABELS, REPLY_STATE_LABELS, replyStateAt, threadHref } from "@/lib/inbox/threads";
import { shortTime } from "@/lib/inbox/short-time";
import { useNow } from "@/lib/whatsapp/inbox";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
import {
  ListColumnHeader,
  ListHeaderAction,
  ThreadList,
  ThreadListSkeleton,
} from "../messaging/thread-list";
import { QueryBoundary } from "../query-boundary";

/** Conversations loaded per page, newest activity first. */
const THREADS_PER_PAGE = 25;

function Threads() {
  const { timezone } = useOrg();
  const now = useNow();
  const { results, status, loadMore } = usePaginatedQuery(
    api.v1.inbox.listThreads,
    {},
    { initialNumItems: THREADS_PER_PAGE },
  );

  if (status === "LoadingFirstPage") return <ThreadListSkeleton />;
  if (results.length === 0) {
    return (
      <EmptyState title="No conversations yet" className="mx-3">
        Conversations from your WhatsApp numbers and Instagram accounts appear here as customers
        write to you.
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
          atText: shortTime(thread.lastMessageAt, now, timezone),
          atTitle: formatInstant(thread.lastMessageAt, timezone),
        };
      })}
      canLoadMore={status !== "Exhausted"}
      loadingMore={status === "LoadingMore"}
      onLoadMore={() => loadMore(THREADS_PER_PAGE)}
    />
  );
}

/**
 * The unified inbox (ADR 0018, IM7.4), as the inbox workspace's list column: the org's WhatsApp
 * and Instagram conversations, most recent activity first, each opening the channel's own
 * conversation beside the list. Every member may read. The workspace rail switches to the
 * per-channel lists.
 */
export function InboxView({ headingLevel = 1 }: { headingLevel?: 1 | 2 }) {
  return (
    <div className="flex flex-col">
      <ListColumnHeader
        title="Inbox"
        description="WhatsApp and Instagram, newest first."
        headingLevel={headingLevel}
        actions={
          <ListHeaderAction href="/inbox/saved-replies" label="Saved replies" icon={BookmarkPlus} />
        }
      />
      <QueryBoundary resetKey="inbox" title="Conversations">
        <Threads />
      </QueryBoundary>
    </div>
  );
}
