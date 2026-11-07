"use client";

import { usePaginatedQuery } from "convex/react";
import Link from "next/link";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { timeLeft } from "@/lib/inbox/conversation-time";
import {
  businessNumberLabel,
  contactLabel,
  isReplyWindowOpen,
  messageContent,
  outboundStatusLabel,
  useNow,
} from "@/lib/whatsapp/inbox";
import { deliveryProblemText, SEND_ERROR_MESSAGES } from "@/lib/whatsapp/messages";
import { numberSendBlocker, type NumberSendBlocker } from "@/lib/whatsapp/sendability";
import type { WhatsAppConversation, WhatsAppMessage } from "@/lib/whatsapp/types";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
import {
  Bubble,
  ComposerNotice,
  ConversationPane,
  ConversationPaneSkeleton,
  DetailsList,
  MessageItem,
  MessageList,
  MessageMeta,
  MessagesSkeleton,
  NOTICE_LINK,
  MessageTimeline,
  ReplyHeading,
  ReplyWindowChip,
} from "../messaging/conversation";
import { QueryBoundary } from "../query-boundary";
import { ReplyBox } from "../whatsapp/reply-box";
import { TemplatePicker } from "../whatsapp/template-picker";

/** Messages loaded per page; the thread shows the newest, oldest at the top. */
const MESSAGES_PER_PAGE = 30;

/** Why only a template can be sent, by whether the customer has ever written. */
function closedText(conversation: WhatsAppConversation): string {
  return conversation.serviceWindowExpiresAt === undefined
    ? "The customer has not written yet: only approved templates can be sent."
    : "The customer last wrote more than 24 hours ago: only approved templates can be sent.";
}

/**
 * D-M3: why this conversation's business number cannot send, from the org's accounts (the same
 * checks as the server); undefined while they load, when it can, or when they do not settle it.
 */
function useSendBlocker(conversation: WhatsAppConversation): NumberSendBlocker | undefined {
  const { data: accounts } = useAnalyticsQuery(api.v1.whatsapp.listAccounts, {});
  return accounts === undefined
    ? undefined
    : numberSendBlocker(accounts, conversation.phoneNumberId);
}

/** The header chip: replies unavailable, the window open (with time left), or templates only. */
function ReplyWindow({
  conversation,
  blocker,
}: {
  conversation: WhatsAppConversation;
  blocker: NumberSendBlocker | undefined;
}) {
  const { timezone } = useOrg();
  const now = useNow();
  const expiresAt = conversation.serviceWindowExpiresAt;
  if (blocker !== undefined) {
    return (
      <ReplyWindowChip
        tone="unavailable"
        label="Replies unavailable"
        title={SEND_ERROR_MESSAGES[blocker]!.message}
      />
    );
  }
  if (expiresAt !== undefined && isReplyWindowOpen(expiresAt, now)) {
    return (
      <ReplyWindowChip
        tone="open"
        label="Reply window open"
        left={timeLeft(expiresAt, now)}
        title={`Free-form replies are possible until ${formatInstant(expiresAt, timezone)}.`}
      />
    );
  }
  return <ReplyWindowChip tone="closed" label="Templates only" title={closedText(conversation)} />;
}

/** Coexistence (ADR 0019): where a message came from, when not this app. */
const ORIGIN_LABELS: Readonly<Record<NonNullable<WhatsAppMessage["origin"]>, string>> = {
  business_app: "sent from the WhatsApp Business app",
  history: "imported",
};

function MessageBubble({
  message,
  contact,
  continued,
}: {
  message: WhatsAppMessage;
  contact: string;
  continued: boolean;
}) {
  const outbound = message.direction === "outbound";
  const content = messageContent(message);
  const status = outboundStatusLabel(message.status);
  const problem = outbound ? deliveryProblemText(message) : null;
  return (
    <MessageItem
      outbound={outbound}
      continued={continued}
      meta={
        <MessageMeta
          sender={outbound ? "You" : contact}
          at={message.at}
          note={message.origin && ORIGIN_LABELS[message.origin]}
          continued={continued}
        />
      }
    >
      <Bubble
        outbound={outbound}
        placeholder={content.kind === "placeholder"}
        {...(message.template ? { label: `Template: ${message.template.name}` } : {})}
      >
        {content.text}
      </Bubble>
      {status && <span className="px-1 text-xs text-muted-foreground">{status}</span>}
      {problem && (
        <span className="max-w-[80%] px-1 text-right text-xs text-destructive">{problem}</span>
      )}
    </MessageItem>
  );
}

function Thread({ conversation }: { conversation: WhatsAppConversation }) {
  const contact = contactLabel(conversation);
  const { results, status, loadMore } = usePaginatedQuery(
    api.v1.whatsapp.listMessages,
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
 * Replying, for editors and admins: a text reply while the reply window is open (the server
 * decides again), and an approved template at any time. Viewers read only. When the number
 * cannot send (D-M3) neither is offered. The reply box stays in place when the window closes,
 * so a typed draft is kept (D-M5).
 */
function Composer({
  conversation,
  blocker,
}: {
  conversation: WhatsAppConversation;
  blocker: NumberSendBlocker | undefined;
}) {
  const { role } = useOrg();
  const now = useNow();
  const headingId = useId();
  if (role !== "admin" && role !== "editor") {
    return <p className="text-sm text-muted-foreground">Only editors and admins can reply.</p>;
  }
  const open = isReplyWindowOpen(conversation.serviceWindowExpiresAt, now);
  const refusal = blocker !== undefined ? SEND_ERROR_MESSAGES[blocker]! : undefined;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <ReplyHeading id={headingId} />
      {refusal !== undefined ? (
        <ComposerNotice
          tone="unavailable"
          title={refusal.title}
          action={
            <Link href="/whatsapp/settings" className={NOTICE_LINK}>
              Open the WhatsApp settings
            </Link>
          }
        >
          {refusal.message}
        </ComposerNotice>
      ) : (
        !open && (
          <ComposerNotice
            tone="closed"
            title={
              conversation.serviceWindowExpiresAt === undefined
                ? "Waiting for the customer to write"
                : "The 24-hour reply window is closed"
            }
          >
            {closedText(conversation)}
          </ComposerNotice>
        )
      )}
      <ReplyBox
        conversationId={conversation.id}
        {...(conversation.contactName !== undefined
          ? { contactName: conversation.contactName }
          : {})}
        closed={!open || refusal !== undefined}
      />
      {refusal === undefined && (
        <TemplatePicker conversationId={conversation.id} prominent={!open} />
      )}
    </section>
  );
}

function Conversation({ conversationId }: { conversationId: string }) {
  const { data: conversation } = useAnalyticsQuery(api.v1.whatsapp.getConversation, {
    conversationId,
  });
  if (conversation === undefined) return <ConversationPaneSkeleton />;
  return <OpenConversation conversation={conversation} />;
}

function OpenConversation({ conversation }: { conversation: WhatsAppConversation }) {
  const blocker = useSendBlocker(conversation);
  return (
    <ConversationPane
      channel="whatsapp"
      contact={contactLabel(conversation)}
      description={`WhatsApp conversation on ${businessNumberLabel(conversation)}`}
      status={<ReplyWindow conversation={conversation} blocker={blocker} />}
      history={<Thread conversation={conversation} />}
      reply={<Composer conversation={conversation} blocker={blocker} />}
      details={<Details conversation={conversation} />}
    />
  );
}

/** The conversation's own facts (v1/whatsapp:getConversation) and the channel's tools. */
function Details({ conversation }: { conversation: WhatsAppConversation }) {
  const { timezone } = useOrg();
  const now = useNow();
  const expiresAt = conversation.serviceWindowExpiresAt;
  return (
    <DetailsList
      facts={[
        ...(conversation.contactName !== undefined
          ? ([["Name", conversation.contactName]] as const)
          : []),
        ["WhatsApp number", `+${conversation.contactWaId}`],
        ["Your number", businessNumberLabel(conversation)],
        ["Last message", formatInstant(conversation.lastMessageAt, timezone)],
        ...(conversation.lastInboundAt !== undefined
          ? ([
              ["Customer last wrote", formatInstant(conversation.lastInboundAt, timezone)],
            ] as const)
          : []),
        ...(expiresAt !== undefined && isReplyWindowOpen(expiresAt, now)
          ? ([["Free-form replies until", formatInstant(expiresAt, timezone)]] as const)
          : []),
      ]}
      links={[
        { href: "/whatsapp/templates", label: "WhatsApp templates" },
        { href: "/inbox/saved-replies", label: "Saved replies" },
        { href: "/whatsapp/settings", label: "WhatsApp settings" },
      ]}
    />
  );
}

/**
 * One WhatsApp conversation (ADR 0013): its messages, oldest at the top, with each outbound
 * message's delivery status (and why one failed), the customer's reply window, and replying for
 * editors and admins. An unknown or another org's conversation id renders the not-found page (the
 * API answers NOT_FOUND).
 */
export function WhatsAppConversationView({ conversationId }: { conversationId: string }) {
  return (
    <div className="flex flex-col lg:h-full">
      <QueryBoundary resetKey={conversationId} title="WhatsApp conversation" notFoundAsPage>
        <Conversation conversationId={conversationId} />
      </QueryBoundary>
    </div>
  );
}
