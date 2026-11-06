"use client";

import { usePaginatedQuery } from "convex/react";
import { FileText, Settings } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { accountLabel, contactLabel } from "@/lib/instagram/messages";
import { isReplyWindowOpen, useNow } from "@/lib/whatsapp/inbox";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
import { ThreadList, ThreadListSkeleton } from "../messaging/thread-list";
import { PageHeader } from "../page-header";
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
      <EmptyState title="No conversations yet" action={<SettingsLink />}>
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
          atText: formatInstant(conversation.lastMessageAt, timezone),
        };
      })}
      canLoadMore={status !== "Exhausted"}
      loadingMore={status === "LoadingMore"}
      onLoadMore={() => loadMore(CONVERSATIONS_PER_PAGE)}
    />
  );
}

/**
 * Instagram direct messages (ADR 0017, IM5): the org's conversations, most recent activity
 * first, each opening its thread. Every member may read; replying comes from the thread.
 * Turning direct messages on and off is on /instagram/messages/settings.
 */
export function InstagramInboxView() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Instagram DMs"
        description="Direct messages from your customers on your Instagram accounts."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/instagram/messages/templates">
                <FileText aria-hidden="true" />
                Templates
              </Link>
            </Button>
            <SettingsLink />
          </div>
        }
      />
      <QueryBoundary resetKey="instagram-conversations" title="Instagram conversations">
        <ConversationList />
      </QueryBoundary>
    </div>
  );
}
