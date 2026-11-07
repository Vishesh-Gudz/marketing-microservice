"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SECTION_HEADING, SURFACE } from "../surface";

// The visual parts of a conversation page, shared by WhatsApp and Instagram. Each channel's view
// keeps its own queries, reply rules and send logic, and only fills these frames.

/**
 * The conversation (message history that scrolls on its own, the reply area right under it) and
 * the details panel beside it when its pane is at least 56rem wide (a container query), below it
 * otherwise.
 */
export function ConversationLayout({
  history,
  reply,
  details,
}: {
  history: ReactNode;
  reply: ReactNode;
  details: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 @4xl:grid @4xl:grid-cols-[minmax(0,1fr)_17rem] @4xl:items-start">
      <div className={cn(SURFACE, "flex min-w-0 flex-col overflow-hidden")}>
        <section
          aria-label="Conversation"
          // Focusable so keyboard users can scroll the history.
          tabIndex={0}
          data-thread-scroller=""
          className="max-h-[min(40rem,calc(100dvh-20rem))] min-h-64 overflow-y-auto bg-canvas/60 px-4 py-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
        >
          {history}
        </section>
        <div className="border-t border-line bg-paper px-4 py-4">{reply}</div>
      </div>
      {details}
    </div>
  );
}

/**
 * The messages, oldest at the top. Opens scrolled to the newest message and follows new ones;
 * loading older messages does not jump back to the bottom. A message that arrives while the
 * conversation is open is read out by screen readers (`announcement`, polite); the messages
 * already there when it opens, and the business's own replies, are not.
 */
export function MessageList({
  newestId,
  announcement,
  children,
}: {
  newestId: string;
  /** What to announce if `newestId` is a message that just arrived (undefined: say nothing). */
  announcement?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLOListElement>(null);
  const [seenId, setSeenId] = useState(newestId);
  const [live, setLive] = useState("");
  // A newer message than the last one seen: announce it (state adjusted while rendering).
  if (newestId !== seenId) {
    setSeenId(newestId);
    setLive(announcement ?? "");
  }
  useEffect(() => {
    const scroller = ref.current?.closest<HTMLElement>("[data-thread-scroller]");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [newestId]);
  return (
    <>
      <ol ref={ref} aria-label="Messages" className="flex flex-col gap-4">
        {children}
      </ol>
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="new-message">
        {live}
      </div>
    </>
  );
}

/** One message: who and when, the content, then status lines under it. */
export function MessageItem({
  outbound,
  meta,
  children,
}: {
  outbound: boolean;
  meta: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className={cn("flex flex-col gap-1", outbound ? "items-end" : "items-start")}>
      <span className="text-xs text-muted-foreground">{meta}</span>
      {children}
    </li>
  );
}

/** A text bubble: the business's replies in the brand colour, the customer's on paper. */
export function Bubble({
  outbound,
  placeholder = false,
  label,
  children,
}: {
  outbound: boolean;
  /** The text stands in for content the API does not return (shown in italics). */
  placeholder?: boolean;
  /** A small line above the text, e.g. "Template: order_update". */
  label?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "max-w-[80%] rounded-[14px] px-3.5 py-2 text-sm",
        outbound
          ? "rounded-br-[4px] bg-primary text-primary-foreground"
          : "rounded-bl-[4px] border border-line bg-paper text-ink",
      )}
    >
      {label !== undefined && (
        <p className={cn("mb-1 text-xs", outbound ? "font-medium" : "text-muted-foreground")}>
          {label}
        </p>
      )}
      <p className={cn("break-words whitespace-pre-wrap", placeholder && "italic")}>{children}</p>
    </div>
  );
}

/** The heading of the reply area ("Reply"), with its id for the section's name. */
export function ReplyHeading({ id }: { id: string }) {
  return (
    <h2 id={id} className={SECTION_HEADING}>
      Reply
    </h2>
  );
}

/**
 * Facts about the conversation from its own API record, and links to the channel's tools.
 * Nothing here is computed beyond formatting.
 */
export function DetailsPanel({
  facts,
  links,
}: {
  facts: readonly (readonly [string, ReactNode])[];
  links: readonly { href: string; label: string }[];
}) {
  return (
    <aside aria-label="Conversation details" className={cn(SURFACE, "flex flex-col gap-4 p-4")}>
      <h2 className={SECTION_HEADING}>Details</h2>
      <dl className="flex flex-col gap-3 text-sm">
        {facts.map(([term, value]) => (
          <div key={term} className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">{term}</dt>
            <dd className="break-words text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <ul className="flex flex-col gap-1 border-t border-line pt-3 text-sm">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="inline-flex items-center gap-1 text-blue-deep underline-offset-4 hover:underline"
            >
              {link.label}
              <ArrowRight aria-hidden="true" className="size-3.5" />
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}
