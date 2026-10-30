"use client";

import { usePaginatedQuery } from "convex/react";
import Link from "next/link";
import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import {
  accountLabel,
  contactLabel,
  deliveryProblemText,
  messageContent,
  messageNotes,
  outboundStatusLabel,
  REPLY_BLOCKED_TEXT,
  senderLabel,
} from "@/lib/instagram/messages";
import type { InstagramConversation, InstagramMessage } from "@/lib/instagram/types";
import { cn } from "@/lib/utils";
import { isReplyWindowOpen, useNow } from "@/lib/whatsapp/inbox";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
import { ReplyBox } from "../instagram/reply-box";
import { Breadcrumbs, PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";

/** Messages loaded per page; the thread shows the newest, oldest at the top. */
const MESSAGES_PER_PAGE = 30;

/** Why no reply can be sent right now, or null when one can (the server decides again). */
function replyBlockedText(conversation: InstagramConversation, now: number): string | null {
  if (conversation.replyBlocker !== undefined) return REPLY_BLOCKED_TEXT[conversation.replyBlocker];
  if (conversation.replyWindowExpiresAt === undefined) return REPLY_BLOCKED_TEXT.window_unopened;
  return isReplyWindowOpen(conversation.replyWindowExpiresAt, now)
    ? null
    : REPLY_BLOCKED_TEXT.window_closed;
}

function ReplyWindow({ conversation }: { conversation: InstagramConversation }) {
  const { timezone } = useOrg();
  const now = useNow();
  const expiresAt = conversation.replyWindowExpiresAt;
  // The account cannot send at all: an open window would promise a reply that is refused.
  if (conversation.replyBlocker !== undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        <Badge variant="outline">Replies unavailable</Badge>{" "}
        {REPLY_BLOCKED_TEXT[conversation.replyBlocker]}
      </p>
    );
  }
  if (expiresAt !== undefined && isReplyWindowOpen(expiresAt, now)) {
    return (
      <p className="text-sm text-muted-foreground">
        <Badge variant="secondary">Reply window open</Badge> Replies are possible until{" "}
        {formatInstant(expiresAt, timezone)}.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      <Badge variant="outline">Reply window closed</Badge>{" "}
      {expiresAt === undefined
        ? REPLY_BLOCKED_TEXT.window_unopened
        : REPLY_BLOCKED_TEXT.window_closed}
    </p>
  );
}

function MessageBubble({ message, contact }: { message: InstagramMessage; contact: string }) {
  const { timezone } = useOrg();
  const outbound = message.direction === "outbound";
  const content = messageContent(message);
  const status = outbound ? outboundStatusLabel(message.status) : undefined;
  const problem = outbound ? deliveryProblemText(message) : null;
  const notes = messageNotes(message);
  return (
    <li className={cn("flex flex-col gap-1", outbound ? "items-end" : "items-start")}>
      <span className="text-xs text-muted-foreground">
        {senderLabel(message, contact)} ·{" "}
        <time dateTime={message.at}>{formatInstant(message.at, timezone)}</time>
      </span>
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-3 py-2 text-sm",
          outbound ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        <p
          className={cn(
            "break-words whitespace-pre-wrap",
            content.kind === "placeholder" && "italic",
          )}
        >
          {content.text}
        </p>
      </div>
      {notes.length > 0 && (
        <span className="text-xs text-muted-foreground">{notes.join(" · ")}</span>
      )}
      {status && <span className="text-xs text-muted-foreground">{status}</span>}
      {problem && (
        <span className="max-w-[80%] text-right text-xs text-destructive">{problem}</span>
      )}
    </li>
  );
}

function Thread({ conversation }: { conversation: InstagramConversation }) {
  const contact = contactLabel(conversation);
  const { results, status, loadMore } = usePaginatedQuery(
    api.v1.instagramMessaging.listMessages,
    { conversationId: conversation.id },
    { initialNumItems: MESSAGES_PER_PAGE },
  );
  if (status === "LoadingFirstPage") {
    return <Skeleton className="h-60 w-full" role="status" aria-label="Loading messages" />;
  }
  if (results.length === 0) return <EmptyState title="No messages in this conversation yet" />;
  // The API lists newest first; a thread reads from the top down.
  const oldestFirst = [...results].reverse();
  return (
    <div className="flex flex-col gap-3">
      {status !== "Exhausted" && (
        <Button
          variant="outline"
          size="sm"
          className="self-center"
          disabled={status === "LoadingMore"}
          onClick={() => loadMore(MESSAGES_PER_PAGE)}
        >
          {status === "LoadingMore" ? "Loading…" : "Show older messages"}
        </Button>
      )}
      <ol aria-label="Messages" className="flex flex-col gap-4">
        {oldestFirst.map((message) => (
          <MessageBubble key={message.id} message={message} contact={contact} />
        ))}
      </ol>
    </div>
  );
}

/**
 * Replying, for editors and admins, only when the server would accept a reply now: the account
 * can send (no `replyBlocker`) and the customer's 24-hour window is open (re-checked every 30
 * seconds; the server decides again). Viewers read only.
 */
function Composer({ conversation }: { conversation: InstagramConversation }) {
  const { role } = useOrg();
  const now = useNow();
  const headingId = useId();
  if (role !== "admin" && role !== "editor") {
    return <p className="text-sm text-muted-foreground">Only editors and admins can reply.</p>;
  }
  const blocked = replyBlockedText(conversation, now);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4 rounded-lg border p-4">
      <h2 id={headingId} className="text-lg font-semibold">
        Reply
      </h2>
      {blocked === null ? (
        <ReplyBox accountId={conversation.messagingAccountId} conversationId={conversation.id} />
      ) : (
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>{blocked}</p>
          {conversation.replyBlocker !== undefined && (
            <Link
              href="/instagram/messages/settings"
              className="self-start underline-offset-4 hover:underline"
            >
              Open the Instagram DM settings
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

function Conversation({ conversationId }: { conversationId: string }) {
  const { data: conversation } = useAnalyticsQuery(api.v1.instagramMessaging.getConversation, {
    conversationId,
  });
  const crumbs = (label: string) => (
    <Breadcrumbs items={[{ label: "Instagram DMs", href: "/instagram/messages" }, { label }]} />
  );
  if (conversation === undefined) {
    return (
      <>
        {crumbs("Conversation")}
        <Skeleton className="h-40 w-full" role="status" aria-label="Loading conversation" />
      </>
    );
  }
  const contact = contactLabel(conversation);
  return (
    <>
      {crumbs(contact)}
      <PageHeader
        title={contact}
        description={`Instagram conversation on ${accountLabel(conversation.accountUsername)}`}
      >
        <ReplyWindow conversation={conversation} />
      </PageHeader>
      <section aria-label="Conversation" className="flex flex-col gap-4">
        <Thread conversation={conversation} />
      </section>
      <Composer conversation={conversation} />
    </>
  );
}

/**
 * One Instagram conversation (ADR 0017, IM5): its messages, oldest at the top, with each reply's
 * status (and why one failed or is not confirmed, never resent automatically), the customer's
 * reply window, and replying for editors and admins. An unknown or another org's conversation id
 * renders the not-found page (the API answers NOT_FOUND).
 */
export function InstagramConversationView({ conversationId }: { conversationId: string }) {
  return (
    <div className="flex flex-col gap-6">
      <QueryBoundary resetKey={conversationId} title="Instagram conversation" notFoundAsPage>
        <Conversation conversationId={conversationId} />
      </QueryBoundary>
    </div>
  );
}
