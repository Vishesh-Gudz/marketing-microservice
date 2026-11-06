"use client";

import { usePaginatedQuery } from "convex/react";
import Link from "next/link";
import { useId } from "react";
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
  HUMAN_AGENT_TEXT,
  REPLY_BLOCKED_TEXT,
  senderLabel,
} from "@/lib/instagram/messages";
import type { InstagramConversation, InstagramMessage } from "@/lib/instagram/types";
import { cn } from "@/lib/utils";
import { isReplyWindowOpen, useNow } from "@/lib/whatsapp/inbox";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
import { ReplyBox } from "../instagram/reply-box";
import { TemplatePreview } from "../instagram/template-preview";
import {
  Bubble,
  ConversationLayout,
  DetailsPanel,
  MessageItem,
  MessageList,
  ReplyHeading,
} from "../messaging/conversation";
import { ContactMark, ReplyStateTag } from "../messaging/thread-list";
import { Breadcrumbs, PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";

/** Messages loaded per page; the thread shows the newest, oldest at the top. */
const MESSAGES_PER_PAGE = 30;

/**
 * Whether a reply can be sent right now and how (the server decides again): within the 24-hour
 * window, or (ADR 0021, only while Human Agent replies are on) as a human agent within 7 days.
 */
function replyModeOf(
  conversation: InstagramConversation,
  now: number,
): { mode: "standard" | "human_agent" } | { blocked: string } {
  if (conversation.replyBlocker !== undefined) {
    return { blocked: REPLY_BLOCKED_TEXT[conversation.replyBlocker] };
  }
  if (conversation.replyWindowExpiresAt === undefined) {
    return { blocked: REPLY_BLOCKED_TEXT.window_unopened };
  }
  if (isReplyWindowOpen(conversation.replyWindowExpiresAt, now)) return { mode: "standard" };
  if (
    conversation.humanAgentWindowExpiresAt !== undefined &&
    isReplyWindowOpen(conversation.humanAgentWindowExpiresAt, now)
  ) {
    return { mode: "human_agent" };
  }
  return { blocked: REPLY_BLOCKED_TEXT.window_closed };
}

function ReplyWindow({ conversation }: { conversation: InstagramConversation }) {
  const { timezone } = useOrg();
  const now = useNow();
  const expiresAt = conversation.replyWindowExpiresAt;
  // The account cannot send at all: an open window would promise a reply that is refused.
  if (conversation.replyBlocker !== undefined) {
    return (
      <p className="mt-1 text-sm text-muted-foreground">
        <ReplyStateTag tone="unavailable">Replies unavailable</ReplyStateTag>{" "}
        {REPLY_BLOCKED_TEXT[conversation.replyBlocker]}
      </p>
    );
  }
  if (expiresAt !== undefined && isReplyWindowOpen(expiresAt, now)) {
    return (
      <p className="mt-1 text-sm text-muted-foreground">
        <ReplyStateTag tone="open">Reply window open</ReplyStateTag> Replies are possible until{" "}
        {formatInstant(expiresAt, timezone)}.
      </p>
    );
  }
  const humanUntil = conversation.humanAgentWindowExpiresAt;
  if (humanUntil !== undefined && isReplyWindowOpen(humanUntil, now)) {
    return (
      <p className="mt-1 text-sm text-muted-foreground">
        <ReplyStateTag tone="open">Human agent window</ReplyStateTag> {HUMAN_AGENT_TEXT} Until{" "}
        {formatInstant(humanUntil, timezone)}.
      </p>
    );
  }
  return (
    <p className="mt-1 text-sm text-muted-foreground">
      <ReplyStateTag tone="closed">Reply window closed</ReplyStateTag>{" "}
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
    <MessageItem
      outbound={outbound}
      meta={
        <>
          {senderLabel(message, contact)} ·{" "}
          <time dateTime={message.at}>{formatInstant(message.at, timezone)}</time>
        </>
      }
    >
      {message.template !== undefined && message.deletedAt === undefined ? (
        <TemplatePreview
          content={message.template}
          label="Template sent"
          className={cn("max-w-[80%]", outbound && "justify-end")}
        />
      ) : (
        <Bubble outbound={outbound} placeholder={content.kind === "placeholder"}>
          {content.text}
        </Bubble>
      )}
      {message.quickReplies !== undefined && message.quickReplies.length > 0 && (
        <ul
          aria-label="Quick-reply buttons sent"
          className="flex max-w-[80%] flex-wrap justify-end gap-1"
        >
          {message.quickReplies.map((title) => (
            <li
              key={title}
              className="rounded-full border border-line bg-paper px-2.5 py-0.5 text-xs text-ink"
            >
              {title}
            </li>
          ))}
        </ul>
      )}
      {notes.length > 0 && (
        <span className="text-xs text-muted-foreground">{notes.join(" · ")}</span>
      )}
      {status && <span className="text-xs text-muted-foreground">{status}</span>}
      {problem && (
        <span className="max-w-[80%] text-right text-xs text-destructive">{problem}</span>
      )}
    </MessageItem>
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
      <MessageList newestId={results[0]!.id}>
        {oldestFirst.map((message) => (
          <MessageBubble key={message.id} message={message} contact={contact} />
        ))}
      </MessageList>
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
  const reply = replyModeOf(conversation, now);
  const contactName = conversation.contactName ?? conversation.contactUsername;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <ReplyHeading id={headingId} />
      {"mode" in reply ? (
        <ReplyBox
          accountId={conversation.messagingAccountId}
          conversationId={conversation.id}
          {...(contactName !== undefined ? { contactName } : {})}
          humanAgent={reply.mode === "human_agent"}
        />
      ) : (
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>{reply.blocked}</p>
          {conversation.replyBlocker !== undefined && (
            <Link
              href="/instagram/messages/settings"
              className="self-start text-blue-deep underline-offset-4 hover:underline"
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
        title={
          <span className="flex items-center gap-3">
            <ContactMark label={contact} channel="instagram" size="lg" />
            {contact}
          </span>
        }
        description={`Instagram conversation on ${accountLabel(conversation.accountUsername)}`}
      >
        <ReplyWindow conversation={conversation} />
      </PageHeader>
      <ConversationLayout
        history={<Thread conversation={conversation} />}
        reply={<Composer conversation={conversation} />}
        details={<Details conversation={conversation} />}
      />
    </>
  );
}

/** The conversation's own facts (v1/instagramMessaging:getConversation) and the channel's tools. */
function Details({ conversation }: { conversation: InstagramConversation }) {
  const { timezone } = useOrg();
  return (
    <DetailsPanel
      facts={[
        ...(conversation.contactName !== undefined
          ? ([["Name", conversation.contactName]] as const)
          : []),
        ...(conversation.contactUsername !== undefined
          ? ([["Instagram", `@${conversation.contactUsername}`]] as const)
          : []),
        ["Your account", accountLabel(conversation.accountUsername)],
        ["Last message", formatInstant(conversation.lastMessageAt, timezone)],
        ...(conversation.lastInboundAt !== undefined
          ? ([
              ["Customer last wrote", formatInstant(conversation.lastInboundAt, timezone)],
            ] as const)
          : []),
      ]}
      links={[
        { href: "/instagram/messages/templates", label: "Instagram templates" },
        { href: "/inbox/saved-replies", label: "Saved replies" },
        { href: "/instagram/messages/settings", label: "Instagram DM settings" },
      ]}
    />
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
