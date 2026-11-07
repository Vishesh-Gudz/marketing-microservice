"use client";

import { usePaginatedQuery } from "convex/react";
import { FileText, Settings } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { accountLabel, contactLabel } from "@/lib/instagram/messages";
import { isReplyWindowOpen, useNow } from "@/lib/whatsapp/inbox";
import { shortTime } from "@/lib/inbox/short-time";
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
const CONVERSATIONS_PER_PAGE = 25;

function SettingsLink() {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href="/instagram/messages/settings">
        <Settings aria-hidden="true" />
        Instagram DM settings
      </Link>
    </Button>
  );
}

function ConversationList() {
  const { timezone } = useOrg();
  const now = useNow();
  const { results, status, loadMore } = usePaginatedQuery(
    api.v1.instagramMessaging.listConversations,
    {},
    { initialNumItems: CONVERSATIONS_PER_PAGE },
  );

  if (status === "LoadingFirstPage") return <ThreadListSkeleton />;
  if (results.length === 0) {
    return (
      <EmptyState title="No conversations yet" action={<SettingsLink />} className="mx-3">
        Direct messages your customers send to your Instagram account appear here once direct
        messages are on for it. Turn them on in the Instagram DM settings.
      </EmptyState>
    );
  }
  return (
    <ThreadList
      rows={results.map((conversation) => {
        const open = isReplyWindowOpen(conversation.replyWindowExpiresAt, now);
        return {
          id: conversation.id,
          href: `/instagram/messages/conversations/${conversation.id}`,
          channel: "instagram" as const,
          contact: contactLabel(conversation),
          account: `To ${accountLabel(conversation.accountUsername)}`,
          state:
            conversation.replyBlocker !== undefined
              ? { tone: "unavailable" as const, label: "Replies unavailable" }
              : open
                ? { tone: "open" as const, label: "Reply window open" }
                : { tone: "closed" as const, label: "Reply window closed" },
          at: conversation.lastMessageAt,
          atText: shortTime(conversation.lastMessageAt, now, timezone),
          atTitle: formatInstant(conversation.lastMessageAt, timezone),
        };
      })}
      canLoadMore={status !== "Exhausted"}
      loadingMore={status === "LoadingMore"}
      onLoadMore={() => loadMore(CONVERSATIONS_PER_PAGE)}
    />
  );
}

/**
 * Instagram direct messages (ADR 0017, IM5), as the inbox workspace's list column: the org's
 * conversations, most recent activity first, each opening its thread beside the list. Every member may read; replying comes from the thread.
 * Turning direct messages on and off is on /instagram/messages/settings.
 */
export function InstagramInboxView({ headingLevel = 1 }: { headingLevel?: 1 | 2 }) {
  return (
    <div className="flex flex-col">
      <ListColumnHeader
        title="Instagram DMs"
        description="Direct messages on your Instagram accounts."
        headingLevel={headingLevel}
        actions={
          <>
            <ListHeaderAction
              href="/instagram/messages/templates"
              label="Templates"
              icon={FileText}
            />
            <ListHeaderAction
              href="/instagram/messages/settings"
              label="Instagram DM settings"
              icon={Settings}
            />
          </>
        }
      />
      <QueryBoundary resetKey="instagram-conversations" title="Instagram conversations">
        <ConversationList />
      </QueryBoundary>
    </div>
  );
}
