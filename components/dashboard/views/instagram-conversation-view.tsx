"use client";

import { usePaginatedQuery } from "convex/react";
import Link from "next/link";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { lastWrote, timeLeft } from "@/lib/inbox/conversation-time";
import {
  accountLabel,
  contactLabel,
  deliveryProblemText,
  messageContent,
  messageNotes,
  outboundStatusLabel,
  HUMAN_AGENT_TEXT,
  REPLY_BLOCKED_TEXT,
  replyBlockerTitle,
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
  ComposerNotice,
  ConversationPane,
  ConversationPaneSkeleton,
  DetailsList,
  LockedComposer,
  MessageItem,
  MessageList,
  MessageMeta,
  MessagesSkeleton,
  NOTICE_LINK,
  MessageTimeline,
  ReplyHeading,
  ReplyWindowChip,
  type ReplyLock,
} from "../messaging/conversation";
import { QueryBoundary } from "../query-boundary";

/** Messages loaded per page; the thread shows the newest, oldest at the top. */
const MESSAGES_PER_PAGE = 30;

/**
 * The locked composer's words (L1) when the customer's window has closed or never opened: why
 * typing is paused and that it opens again as soon as they write (the conversation is live, so
 * the field comes back by itself). The 7-day Human Agent limit is named only while that switch is
 * on (the API then carries `humanAgentWindowExpiresAt`).
 */
function replyLock(conversation: InstagramConversation, now: number, timeZone: string): ReplyLock {
  const contact = contactLabel(conversation);
  if (conversation.replyWindowExpiresAt === undefined) {
    return {
      title: "Waiting for the customer to write",
      detail: `You can type here once ${contact} messages this account. Instagram allows a reply only after they do.`,
    };
  }
  const when =
    conversation.lastInboundAt !== undefined
      ? `${contact} last wrote ${lastWrote(conversation.lastInboundAt, now, timeZone)}.`
      : "The customer last wrote more than 24 hours ago.";
  const limit =
    conversation.humanAgentWindowExpiresAt !== undefined
      ? "Instagram allows replies only within 24 hours of the customer's last message, or 7 days for a human agent reply."
      : "Instagram allows replies only within 24 hours of the customer's last message.";
  return {
    title: "The 24-hour reply window is closed",
    detail: `${when} You can type here again as soon as they write. ${limit}`,
  };
}

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

/**
 * The header chip: replies unavailable (the account cannot send, whatever the window), the window
 * open or the Human Agent window (with time left), or closed.
 */
function ReplyWindow({ conversation }: { conversation: InstagramConversation }) {
  const { timezone } = useOrg();
  const now = useNow();
  const expiresAt = conversation.replyWindowExpiresAt;
  // The account cannot send at all: an open window would promise a reply that is refused.
  if (conversation.replyBlocker !== undefined) {
    return (
      <ReplyWindowChip
        tone="unavailable"
        label="Replies unavailable"
        title={REPLY_BLOCKED_TEXT[conversation.replyBlocker]}
      />
    );
  }
  if (expiresAt !== undefined && isReplyWindowOpen(expiresAt, now)) {
    return (
      <ReplyWindowChip
        tone="open"
        label="Reply window open"
        left={timeLeft(expiresAt, now)}
        title={`Replies are possible until ${formatInstant(expiresAt, timezone)}.`}
      />
    );
  }
  const humanUntil = conversation.humanAgentWindowExpiresAt;
  if (humanUntil !== undefined && isReplyWindowOpen(humanUntil, now)) {
    return (
      <ReplyWindowChip
        tone="open"
        label="Human agent window"
        left={timeLeft(humanUntil, now)}
        title={`${HUMAN_AGENT_TEXT} Until ${formatInstant(humanUntil, timezone)}.`}
      />
    );
  }
  return (
    <ReplyWindowChip
      tone="closed"
      label="Reply window closed"
      title={
        expiresAt === undefined
          ? REPLY_BLOCKED_TEXT.window_unopened
          : REPLY_BLOCKED_TEXT.window_closed
      }
    />
  );
}

function MessageBubble({
  message,
  contact,
  continued,
}: {
  message: InstagramMessage;
  contact: string;
  continued: boolean;
}) {
  const outbound = message.direction === "outbound";
  const content = messageContent(message);
  const status = outbound ? outboundStatusLabel(message.status) : undefined;
  const problem = outbound ? deliveryProblemText(message) : null;
  const notes = messageNotes(message);
  return (
    <MessageItem
      outbound={outbound}
      continued={continued}
      meta={
        <MessageMeta sender={senderLabel(message, contact)} at={message.at} continued={continued} />
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
        <span className="px-1 text-xs text-muted-foreground">{notes.join(" · ")}</span>
      )}
      {status && <span className="px-1 text-xs text-muted-foreground">{status}</span>}
      {problem && (
        <span className="max-w-[80%] px-1 text-right text-xs text-destructive">{problem}</span>
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
  if (status === "LoadingFirstPage") return <MessagesSkeleton />;
  if (results.length === 0) return <EmptyState title="No messages in this conversation yet" />;
  // The API lists newest first; a thread reads from the top down.
  const oldestFirst = [...results].reverse();
  const newest = results[0]!;
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
      <MessageList
        newestId={newest.id}
        announcement={
          newest.direction === "inbound"
            ? `New message from ${contact}: ${messageContent(newest).text}`
            : undefined
        }
      >
        <MessageTimeline
          messages={oldestFirst}
          render={(message, continued) => (
            <MessageBubble message={message} contact={contact} continued={continued} />
          )}
        />
      </MessageList>
    </div>
  );
}

/**
 * Replying, for editors and admins, only when the server would accept a reply now: the account
 * can send (no `replyBlocker`) and the customer's 24-hour window is open (re-checked every 30
 * seconds; the server decides again). Viewers read only. While the window is closed the reply
 * box shows as locked (L1); it stays in place when replies stop, so a typed draft is kept (D-M5).
 */
function Composer({ conversation }: { conversation: InstagramConversation }) {
  const { role, timezone } = useOrg();
  const now = useNow();
  const headingId = useId();
  if (role !== "admin" && role !== "editor") {
    return <LockedComposer lock={{ title: "Only editors and admins can reply." }} />;
  }
  const reply = replyModeOf(conversation, now);
  const contactName = conversation.contactName ?? conversation.contactUsername;
  const unavailable = conversation.replyBlocker !== undefined;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <ReplyHeading id={headingId} />
      {conversation.replyBlocker !== undefined && "blocked" in reply && (
        <ComposerNotice
          title={replyBlockerTitle(conversation.replyBlocker)}
          action={
            <Link href="/instagram/messages/settings" className={NOTICE_LINK}>
              Open the Instagram DM settings
            </Link>
          }
        >
          {reply.blocked}
        </ComposerNotice>
      )}
      <ReplyBox
        accountId={conversation.messagingAccountId}
        conversationId={conversation.id}
        {...(contactName !== undefined ? { contactName } : {})}
        humanAgent={"mode" in reply && reply.mode === "human_agent"}
        closed={"blocked" in reply}
        lock={
          "blocked" in reply && !unavailable ? replyLock(conversation, now, timezone) : undefined
        }
      />
    </section>
  );
}

function Conversation({ conversationId }: { conversationId: string }) {
  const { data: conversation } = useAnalyticsQuery(api.v1.instagramMessaging.getConversation, {
    conversationId,
  });
  if (conversation === undefined) return <ConversationPaneSkeleton />;
  return (
    <ConversationPane
      channel="instagram"
      contact={contactLabel(conversation)}
      description={`Instagram conversation on ${accountLabel(conversation.accountUsername)}`}
      status={<ReplyWindow conversation={conversation} />}
      history={<Thread conversation={conversation} />}
      reply={<Composer conversation={conversation} />}
      details={<Details conversation={conversation} />}
    />
  );
}

/** The conversation's own facts (v1/instagramMessaging:getConversation) and the channel's tools. */
function Details({ conversation }: { conversation: InstagramConversation }) {
  const { timezone } = useOrg();
  const now = useNow();
  const reply = replyModeOf(conversation, now);
  const until =
    "mode" in reply
      ? reply.mode === "standard"
        ? conversation.replyWindowExpiresAt
        : conversation.humanAgentWindowExpiresAt
      : undefined;
  return (
    <DetailsList
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
        ...(until !== undefined
          ? ([
              [
                "mode" in reply && reply.mode === "human_agent"
                  ? "Human agent replies until"
                  : "Replies possible until",
                formatInstant(until, timezone),
              ],
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
    <div className="flex flex-col lg:h-full">
      <QueryBoundary resetKey={conversationId} title="Instagram conversation" notFoundAsPage>
        <Conversation conversationId={conversationId} />
      </QueryBoundary>
    </div>
  );
}
