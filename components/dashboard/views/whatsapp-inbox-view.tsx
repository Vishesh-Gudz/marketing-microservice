"use client";

import { usePaginatedQuery } from "convex/react";
import { Settings } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { businessNumberLabel, contactLabel, isReplyWindowOpen, useNow } from "@/lib/whatsapp/inbox";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
import { PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";

/** Conversations loaded per page, newest activity first. */
const CONVERSATIONS_PER_PAGE = 25;

function SettingsLink() {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href="/whatsapp/settings">
        <Settings aria-hidden="true" />
        WhatsApp settings
      </Link>
    </Button>
  );
}

function ConversationList() {
  const { timezone } = useOrg();
  const now = useNow();
  const { results, status, loadMore } = usePaginatedQuery(
    api.v1.whatsapp.listConversations,
    {},
    { initialNumItems: CONVERSATIONS_PER_PAGE },
  );

  if (status === "LoadingFirstPage") {
    return <Skeleton className="h-40 w-full" role="status" aria-label="Loading conversations" />;
  }
  if (results.length === 0) {
    return (
      <EmptyState title="No conversations yet" action={<SettingsLink />}>
        Messages your customers send to your connected WhatsApp number appear here. Connect a number
        in the WhatsApp settings.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Conversations" className="flex flex-col divide-y rounded-lg border">
        {results.map((conversation) => {
          const open = isReplyWindowOpen(conversation.serviceWindowExpiresAt, now);
          return (
            <li key={conversation.id}>
              <Link
                href={`/whatsapp/conversations/${conversation.id}`}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-accent focus-visible:bg-accent"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{contactLabel(conversation)}</span>
                  <span className="text-xs text-muted-foreground">
                    To {businessNumberLabel(conversation)}
                  </span>
                </span>
                <span className="flex items-center gap-3 text-xs text-muted-foreground">
                  <Badge variant={open ? "secondary" : "outline"}>
                    {open ? "Reply window open" : "Templates only"}
                  </Badge>
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
 * WhatsApp inbox (ADR 0013): the org's conversations, most recent activity first, each opening
 * its thread. Every member may read; replying comes from the thread. Connection management is
 * on /whatsapp/settings.
 */
export function WhatsAppInboxView() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="WhatsApp"
        description="Conversations with your customers on your connected WhatsApp numbers."
      >
        <div className="pt-2">
          <SettingsLink />
        </div>
      </PageHeader>
      <QueryBoundary resetKey="whatsapp-conversations" title="WhatsApp conversations">
        <ConversationList />
      </QueryBoundary>
    </div>
  );
}
