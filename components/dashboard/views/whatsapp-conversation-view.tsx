"use client";

import { usePaginatedQuery } from "convex/react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import {
  businessNumberLabel,
  contactLabel,
  isReplyWindowOpen,
  messageContent,
  outboundStatusLabel,
  useNow,
} from "@/lib/whatsapp/inbox";
import { deliveryProblemText } from "@/lib/whatsapp/messages";
import type { WhatsAppConversation, WhatsAppMessage } from "@/lib/whatsapp/types";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
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
import { ReplyBox } from "../whatsapp/reply-box";
import { TemplatePicker } from "../whatsapp/template-picker";

/** Messages loaded per page; the thread shows the newest, oldest at the top. */
const MESSAGES_PER_PAGE = 30;

function ReplyWindow({ conversation }: { conversation: WhatsAppConversation }) {
  const { timezone } = useOrg();
  const now = useNow();
  const expiresAt = conversation.serviceWindowExpiresAt;
  if (expiresAt !== undefined && isReplyWindowOpen(expiresAt, now)) {
    return (
      <p className="mt-1 text-sm text-muted-foreground">
        <ReplyStateTag tone="open">Reply window open</ReplyStateTag> Free-form replies are possible
        until {formatInstant(expiresAt, timezone)}.
      </p>
    );
  }
  return (
    <p className="mt-1 text-sm text-muted-foreground">
      <ReplyStateTag tone="closed">Templates only</ReplyStateTag>{" "}
      {expiresAt === undefined
        ? "The customer has not written yet: only approved templates can be sent."
        : "The customer last wrote more than 24 hours ago: only approved templates can be sent."}
    </p>
  );
}

/** Coexistence (ADR 0019): where a message came from, when not this app. */
const ORIGIN_LABELS: Readonly<Record<NonNullable<WhatsAppMessage["origin"]>, string>> = {
  business_app: "sent from the WhatsApp Business app",
  history: "imported",
};

function MessageBubble({ message, contact }: { message: WhatsAppMessage; contact: string }) {
  const { timezone } = useOrg();
  const outbound = message.direction === "outbound";
  const content = messageContent(message);
  const status = outboundStatusLabel(message.status);
  const problem = outbound ? deliveryProblemText(message) : null;
  return (
    <MessageItem
      outbound={outbound}
      meta={
        <>
          {outbound ? "You" : contact} ·{" "}
          <time dateTime={message.at}>{formatInstant(message.at, timezone)}</time>
          {message.origin && ` · ${ORIGIN_LABELS[message.origin]}`}
        </>
      }
    >
      <Bubble
        outbound={outbound}
        placeholder={content.kind === "placeholder"}
        {...(message.template ? { label: `Template: ${message.template.name}` } : {})}
      >
        {content.text}
      </Bubble>
      {status && <span className="text-xs text-muted-foreground">{status}</span>}
      {problem && (
        <span className="max-w-[80%] text-right text-xs text-destructive">{problem}</span>
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
 * Replying, for editors and admins: a text reply while the reply window is open (the server
 * decides again), and an approved template at any time. Viewers read only.
 */
function Composer({ conversation }: { conversation: WhatsAppConversation }) {
  const { role } = useOrg();
  const now = useNow();
  const headingId = useId();
  if (role !== "admin" && role !== "editor") {
    return <p className="text-sm text-muted-foreground">Only editors and admins can reply.</p>;
  }
  const open = isReplyWindowOpen(conversation.serviceWindowExpiresAt, now);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <ReplyHeading id={headingId} />
      {open ? (
        <ReplyBox
          conversationId={conversation.id}
          {...(conversation.contactName !== undefined
            ? { contactName: conversation.contactName }
            : {})}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          The reply window is closed: only an approved template can be sent.
        </p>
      )}
      <TemplatePicker conversationId={conversation.id} />
    </section>
  );
}

function Conversation({ conversationId }: { conversationId: string }) {
  const { data: conversation } = useAnalyticsQuery(api.v1.whatsapp.getConversation, {
    conversationId,
  });
  const crumbs = (label: string) => (
    <Breadcrumbs items={[{ label: "WhatsApp", href: "/whatsapp" }, { label }]} />
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
            <ContactMark label={contact} channel="whatsapp" size="lg" />
            {contact}
          </span>
        }
        description={`WhatsApp conversation on ${businessNumberLabel(conversation)}`}
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

/** The conversation's own facts (v1/whatsapp:getConversation) and the channel's tools. */
function Details({ conversation }: { conversation: WhatsAppConversation }) {
  const { timezone } = useOrg();
  return (
    <DetailsPanel
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
    <div className="flex flex-col gap-6">
      <QueryBoundary resetKey={conversationId} title="WhatsApp conversation" notFoundAsPage>
        <Conversation conversationId={conversationId} />
      </QueryBoundary>
    </div>
  );
}
