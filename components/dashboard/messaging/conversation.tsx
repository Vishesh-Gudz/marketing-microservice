"use client";

import { ArrowLeft, ArrowRight, Clock, PanelRight, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChannelLogo } from "@/components/brand/channel-logo";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrg } from "@/lib/analytics/org-context";
import { clockTime, continuesPrevious, dayLabel } from "@/lib/inbox/conversation-time";
import { dayKey } from "@/lib/inbox/short-time";
import type { InboxChannel } from "@/lib/inbox/threads";
import { cn } from "@/lib/utils";
import { useNow } from "@/lib/whatsapp/inbox";
import { formatInstant } from "../freshness-note";
import { SECTION_HEADING } from "../surface";
import { useBackToList } from "./inbox-context";
import { CONVERSATION_PANE_SIZE } from "./pane";
import { ContactMark, TONE_CLASS, type ReplyTone } from "./thread-list";

// The open conversation (Kinso K3-K4), shared by WhatsApp and Instagram: a header bar with the
// reply-window chip, the history filling the pane with day breaks, the composer pinned at the
// bottom as a card, and the details beside it (≥1536 px) or in a sheet (from the bottom on
// phones). Each channel's view keeps its own queries, reply rules and send logic, and only fills
// these frames.

/** Which side the details sheet opens from: the bottom on phones, the right from 768 px. */
function sheetSide(): "bottom" | "right" {
  return window.matchMedia?.("(min-width: 768px)").matches ? "right" : "bottom";
}

/**
 * The conversation pane. It fills the inbox workspace's pane, and on phones and tablets the
 * screen between the top bar and the dock (CONVERSATION_PANE_SIZE): the history scrolls on its
 * own and the composer stays at the bottom. The back arrow (below 1024 px, where the list is not
 * beside it) returns to the list the conversation was opened from.
 */
export function ConversationPane({
  channel,
  contact,
  description,
  status,
  history,
  reply,
  details,
}: {
  channel: InboxChannel;
  contact: string;
  /** "WhatsApp conversation on +1 555…". */
  description: string;
  /** The reply-window chip. */
  status: ReactNode;
  history: ReactNode;
  reply: ReactNode;
  details: ReactNode;
}) {
  const back = useBackToList(channel);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [sheet, setSheet] = useState<{ open: boolean; side: "bottom" | "right" }>({
    open: false,
    side: "right",
  });
  const detailsId = useId();
  return (
    <div
      data-conversation-pane=""
      className={cn("relative flex flex-col lg:flex-row", CONVERSATION_PANE_SIZE)}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-paper px-4 py-3 md:px-6">
          <Link
            href={back.href}
            aria-label={`Back to ${back.label}`}
            title={`Back to ${back.label}`}
            className="-ml-1.5 grid size-9 shrink-0 place-items-center rounded-[10px] text-ink-2 transition-colors hover:bg-canvas hover:text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.97] lg:hidden"
          >
            <ArrowLeft aria-hidden="true" className="size-5" />
          </Link>
          <ContactMark label={contact} channel={channel} />
          <div className="min-w-0 flex-1 basis-40">
            <h1 className="truncate text-base leading-tight font-semibold text-ink">{contact}</h1>
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <ChannelLogo channel={channel} className="size-3.5 shrink-0" />
              <span className="truncate">{description}</span>
            </p>
          </div>
          {/* Phones: the chip takes its own line under the name. */}
          <div className="flex shrink-0 max-sm:order-last max-sm:basis-full">{status}</div>
          {/* ≥1536 px: shows or hides the details column. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="hidden shrink-0 2xl:inline-flex"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            <PanelRight aria-hidden="true" />
            Details
          </Button>
          {/* Below: opens the details in a sheet (its label only for screen readers on phones). */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 max-sm:size-9 max-sm:px-0 2xl:hidden"
            aria-haspopup="dialog"
            onClick={() => setSheet({ open: true, side: sheetSide() })}
          >
            <PanelRight aria-hidden="true" />
            <span className="max-sm:sr-only">Details</span>
          </Button>
        </header>
        <section
          aria-label="Conversation"
          // Focusable so keyboard users can scroll the history.
          tabIndex={0}
          data-thread-scroller=""
          className="relative min-h-0 flex-1 overflow-y-auto bg-canvas/50 px-4 py-5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset md:px-6"
        >
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end">
            {history}
          </div>
        </section>
        <div className="relative max-h-[60%] shrink-0 overflow-y-auto bg-canvas/50 px-3 pb-3 md:px-6 md:pb-4 lg:max-h-[min(34rem,62%)]">
          <div className="mx-auto w-full max-w-3xl rounded-[14px] border border-line bg-paper p-3 shadow-soft">
            {reply}
          </div>
        </div>
      </div>
      <aside
        id={detailsId}
        aria-label="Conversation details"
        className={cn(
          "hidden w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-paper p-5",
          detailsOpen && "2xl:flex",
        )}
      >
        <h2 className={SECTION_HEADING}>Details</h2>
        {details}
      </aside>
      <Sheet open={sheet.open} onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}>
        <SheetContent
          side={sheet.side}
          className={cn(
            "gap-0 overflow-y-auto p-0",
            sheet.side === "right"
              ? "w-[min(22rem,100vw)]"
              : "max-h-[85dvh] rounded-t-[16px] pb-[env(safe-area-inset-bottom)]",
          )}
        >
          <SheetHeader className="border-b border-line px-5 py-4">
            <SheetTitle>Details</SheetTitle>
            <SheetDescription className="sr-only">
              Facts about this conversation and links to the channel&apos;s tools.
            </SheetDescription>
          </SheetHeader>
          <div className="p-5">{details}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** The pane while the conversation loads, shaped like it. */
export function ConversationPaneSkeleton() {
  return (
    <div
      data-conversation-pane=""
      role="status"
      aria-label="Loading conversation"
      className={cn("flex flex-col", CONVERSATION_PANE_SIZE)}
    >
      <div className="flex items-center gap-3 border-b border-line px-4 py-3 md:px-6">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56 max-w-full" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col bg-canvas/50 px-4 py-5 md:px-6">
        <div className="mx-auto mt-auto flex w-full max-w-3xl flex-col gap-3">
          <BubbleSkeletons />
        </div>
      </div>
      <div className="bg-canvas/50 px-3 pb-3 md:px-6 md:pb-4">
        <Skeleton className="mx-auto h-32 w-full max-w-3xl rounded-[14px]" />
      </div>
    </div>
  );
}

function BubbleSkeletons() {
  return (
    <>
      <Skeleton className="h-12 w-3/5 rounded-[16px]" />
      <Skeleton className="ml-auto h-12 w-1/2 rounded-[16px]" />
      <Skeleton className="h-16 w-2/3 rounded-[16px]" />
    </>
  );
}

/** The history while its first messages load. */
export function MessagesSkeleton() {
  return (
    <div role="status" aria-label="Loading messages" className="flex flex-col gap-3">
      <BubbleSkeletons />
    </div>
  );
}

/**
 * The reply-window chip in the header: the state in a tint, and for an open window how long it
 * has left (from `useNow`). The exact end time is in its title and in the details.
 */
export function ReplyWindowChip({
  tone,
  label,
  left,
  title,
}: {
  tone: ReplyTone;
  label: string;
  /** "21h left". */
  left?: string | undefined;
  title?: string | undefined;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border border-transparent px-2.5 text-xs font-medium whitespace-nowrap",
        TONE_CLASS[tone],
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current opacity-70" />
      {label}
      {left !== undefined && <span className="font-normal tabular-nums">· {left}</span>}
    </span>
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
      <ol ref={ref} aria-label="Messages" className="flex flex-col">
        {children}
      </ol>
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="new-message">
        {live}
      </div>
    </>
  );
}

/**
 * The messages with a day break ("Today", "Yesterday", "Nov 3") before each new day, in the
 * organization's time zone. `render` gets whether a message continues the one before it (same
 * side, within five minutes), so the sender is not repeated. The breaks are visual only: every
 * message's time says its full date to screen readers.
 */
export function MessageTimeline<T extends { id: string; at: string; direction: string }>({
  messages,
  render,
}: {
  messages: readonly T[];
  render: (message: T, continued: boolean) => ReactNode;
}) {
  const { timezone } = useOrg();
  const now = useNow(60_000);
  const items: ReactNode[] = [];
  let day: string | undefined;
  let previous: { outbound: boolean; at: string } | undefined;
  for (const message of messages) {
    const key = dayKey(Date.parse(message.at), timezone);
    const current = { outbound: message.direction === "outbound", at: message.at };
    if (key !== day) {
      items.push(<DayBreak key={`day:${key}`} label={dayLabel(message.at, now, timezone)} />);
      day = key;
    }
    items.push(
      <Fragment key={message.id}>
        {render(message, continuesPrevious(previous, current, timezone))}
      </Fragment>,
    );
    previous = current;
  }
  return <>{items}</>;
}

function DayBreak({ label }: { label: string }) {
  return (
    <li
      aria-hidden="true"
      className="flex items-center gap-3 pt-6 pb-1 text-xs font-medium text-muted-foreground first:pt-0"
    >
      <span className="h-px flex-1 bg-line" />
      {label}
      <span className="h-px flex-1 bg-line" />
    </li>
  );
}

/** One message: who and when, the content, then status lines under it. */
export function MessageItem({
  outbound,
  continued = false,
  meta,
  children,
}: {
  outbound: boolean;
  /** Continues the message before it: sits closer to it. */
  continued?: boolean;
  meta: ReactNode;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex flex-col gap-1",
        outbound ? "items-end" : "items-start",
        continued ? "pt-1.5" : "pt-4",
      )}
    >
      <span className="px-1 text-xs text-muted-foreground">{meta}</span>
      {children}
    </li>
  );
}

/**
 * A message's meta line: who (only to screen readers when it continues the one before), the
 * clock time (the full date and time in its title and to screen readers), and any note.
 */
export function MessageMeta({
  sender,
  at,
  note,
  continued,
}: {
  sender: string;
  at: string;
  note?: string | undefined;
  continued: boolean;
}) {
  const { timezone } = useOrg();
  const full = formatInstant(at, timezone);
  return (
    <>
      {continued ? <span className="sr-only">{sender} · </span> : `${sender} · `}
      <time dateTime={at} title={full} className="tabular-nums">
        <span aria-hidden="true">{clockTime(at, timezone)}</span>
        <span className="sr-only">{full}</span>
      </time>
      {note !== undefined && ` · ${note}`}
    </>
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
        "max-w-[min(80%,36rem)] rounded-[16px] px-3.5 py-2 text-sm leading-relaxed",
        outbound
          ? "rounded-br-[6px] bg-primary text-primary-foreground"
          : "rounded-bl-[6px] bg-paper text-ink shadow-soft ring-1 ring-line",
      )}
    >
      {label !== undefined && (
        <p className={cn("mb-1 text-xs", outbound ? "font-medium" : "text-muted-foreground")}>
          {label}
        </p>
      )}
      <p className={cn("break-words whitespace-pre-wrap text-pretty", placeholder && "italic")}>
        {children}
      </p>
    </div>
  );
}

/** The composer's text field, borderless inside the composer card (it keeps its focus outline). */
export const COMPOSER_FIELD = "min-h-20 resize-none border-0 bg-transparent px-1 py-1 md:text-sm";

/** The heading of the reply area ("Reply", for screen readers), with its id for its name. */
export function ReplyHeading({ id }: { id: string }) {
  return (
    <h2 id={id} className="sr-only">
      Reply
    </h2>
  );
}

/** A link inside a composer notice (dark on the amber tint: 4.5:1 or more). */
export const NOTICE_LINK =
  "self-start font-medium text-ink underline underline-offset-4 hover:text-blue-deep";

/**
 * A notice at the top of the composer when no text reply can be sent: the window has closed
 * (neutral) or the account cannot send (a warning). `action` is the way forward.
 */
export function ComposerNotice({
  tone,
  title,
  children,
  action,
}: {
  tone: "closed" | "unavailable";
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const Icon = tone === "unavailable" ? TriangleAlert : Clock;
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-[10px] px-3 py-2.5 text-sm",
        tone === "unavailable" ? "bg-amber-tint" : "bg-canvas",
      )}
    >
      <p
        className={cn(
          "flex items-center gap-2 font-medium",
          tone === "unavailable" ? "text-amber-ink" : "text-ink",
        )}
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {title}
      </p>
      <div className={tone === "unavailable" ? "text-ink-2" : "text-muted-foreground"}>
        {children}
      </div>
      {action}
    </div>
  );
}

/**
 * Facts about the conversation from its own API record, and links to the channel's tools.
 * Nothing here is computed beyond formatting. Shown in the details column or sheet.
 */
export function DetailsList({
  facts,
  links,
}: {
  facts: readonly (readonly [string, ReactNode])[];
  links: readonly { href: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-4">
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
    </div>
  );
}
