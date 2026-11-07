"use client";

import { usePaginatedQuery } from "convex/react";
import { FileText, Settings } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { shortTime } from "@/lib/inbox/short-time";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { businessNumberLabel, contactLabel, isReplyWindowOpen, useNow } from "@/lib/whatsapp/inbox";
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

  if (status === "LoadingFirstPage") return <ThreadListSkeleton />;
  if (results.length === 0) {
    return (
      <EmptyState title="No conversations yet" action={<SettingsLink />} className="mx-3">
        Messages your customers send to your connected WhatsApp number appear here. Connect a number
        in the WhatsApp settings.
      </EmptyState>
    );
  }
  return (
    <ThreadList
      rows={results.map((conversation) => {
        const open = isReplyWindowOpen(conversation.serviceWindowExpiresAt, now);
        return {
          id: conversation.id,
          href: `/whatsapp/conversations/${conversation.id}`,
          channel: "whatsapp" as const,
          contact: contactLabel(conversation),
          account: `To ${businessNumberLabel(conversation)}`,
          state: open
            ? { tone: "open" as const, label: "Reply window open" }
            : { tone: "closed" as const, label: "Templates only" },
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
 * WhatsApp inbox (ADR 0013), as the inbox workspace's list column: the org's conversations, most
 * recent activity first, each opening its thread beside the list. Every member may read;
 * replying comes from the thread. Connection management is on /whatsapp/settings, templates on
 * /whatsapp/templates.
 */
export function WhatsAppInboxView({ headingLevel = 1 }: { headingLevel?: 1 | 2 }) {
  return (
    <div className="flex flex-col">
      <ListColumnHeader
        title="WhatsApp"
        description="Your connected WhatsApp numbers."
        headingLevel={headingLevel}
        actions={
          <>
            <ListHeaderAction href="/whatsapp/templates" label="Templates" icon={FileText} />
            <ListHeaderAction href="/whatsapp/settings" label="WhatsApp settings" icon={Settings} />
          </>
        }
      />
      <QueryBoundary resetKey="whatsapp-conversations" title="WhatsApp conversations">
        <ConversationList />
      </QueryBoundary>
    </div>
  );
}
