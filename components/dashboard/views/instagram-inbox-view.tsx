"use client";

import { usePaginatedQuery } from "convex/react";
import { Settings } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { accountLabel, contactLabel } from "@/lib/instagram/messages";
import { isReplyWindowOpen, useNow } from "@/lib/whatsapp/inbox";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
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

  if (status === "LoadingFirstPage") {
    return <Skeleton className="h-40 w-full" role="status" aria-label="Loading conversations" />;
  }
  if (results.length === 0) {
    return (
      <EmptyState title="No conversations yet" action={<SettingsLink />}>
        Direct messages your customers send to your Instagram account appear here once direct
        messages are on for it. Turn them on in the Instagram DM settings.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Conversations" className="flex flex-col divide-y rounded-lg border">
        {results.map((conversation) => {
          const open = isReplyWindowOpen(conversation.replyWindowExpiresAt, now);
          return (
            <li key={conversation.id}>
              <Link
                href={`/instagram/messages/conversations/${conversation.id}`}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-accent focus-visible:bg-accent"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{contactLabel(conversation)}</span>
                  <span className="text-xs text-muted-foreground">
                    To {accountLabel(conversation.accountUsername)}
                  </span>
                </span>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                  {conversation.replyBlocker !== undefined ? (
                    <Badge variant="outline">Replies unavailable</Badge>
                  ) : (
                    <Badge variant={open ? "secondary" : "outline"}>
                      {open ? "Reply window open" : "Reply window closed"}
                    </Badge>
                  )}
                  <time dateTime={conversation.lastMessageAt}>
                    {formatInstant(conversation.lastMessageAt, timezone)}
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
          onClick={() => loadMore(CONVERSATIONS_PER_PAGE)}
        >
          {status === "LoadingMore" ? "Loading…" : "Show more conversations"}
        </Button>
      )}
    </div>
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
      >
        <div className="pt-2">
          <SettingsLink />
        </div>
      </PageHeader>
      <QueryBoundary resetKey="instagram-conversations" title="Instagram conversations">
        <ConversationList />
      </QueryBoundary>
    </div>
  );
}
