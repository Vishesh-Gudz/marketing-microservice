"use client";

import { usePaginatedQuery } from "convex/react";
import { useId } from "react";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
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
      <p className="text-sm text-muted-foreground">
        <Badge variant="secondary">Reply window open</Badge> Free-form replies are possible until{" "}
        {formatInstant(expiresAt, timezone)}.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      <Badge variant="outline">Templates only</Badge>{" "}
      {expiresAt === undefined
        ? "The customer has not written yet: only approved templates can be sent."
        : "The customer last wrote more than 24 hours ago: only approved templates can be sent."}
    </p>
  );
}

function MessageBubble({ message, contact }: { message: WhatsAppMessage; contact: string }) {
  const { timezone } = useOrg();
  const outbound = message.direction === "outbound";
  const content = messageContent(message);
  const status = outboundStatusLabel(message.status);
  const problem = outbound ? deliveryProblemText(message) : null;
  return (
    <li className={cn("flex flex-col gap-1", outbound ? "items-end" : "items-start")}>
      <span className="text-xs text-muted-foreground">
        {outbound ? "You" : contact} ·{" "}
        <time dateTime={message.at}>{formatInstant(message.at, timezone)}</time>
      </span>
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-3 py-2 text-sm",
          outbound ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {message.template && (
          <p className="mb-1 text-xs opacity-80">Template: {message.template.name}</p>
        )}
        <p
          className={cn(
            "break-words whitespace-pre-wrap",
            content.kind === "placeholder" && "italic",
          )}
        >
          {content.text}
        </p>
      </div>
      {status && <span className="text-xs text-muted-foreground">{status}</span>}
      {problem && (
        <span className="max-w-[80%] text-right text-xs text-destructive">{problem}</span>
      )}
    </li>
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
      <ol aria-label="Messages" className="flex flex-col gap-4">
        {oldestFirst.map((message) => (
          <MessageBubble key={message.id} message={message} contact={contact} />
        ))}
      </ol>
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
    <section aria-labelledby={headingId} className="flex flex-col gap-4 rounded-lg border p-4">
      <h2 id={headingId} className="text-lg font-semibold">
        Reply
      </h2>
      {open ? (
        <ReplyBox conversationId={conversation.id} />
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
        title={contact}
        description={`WhatsApp conversation on ${businessNumberLabel(conversation)}`}
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
