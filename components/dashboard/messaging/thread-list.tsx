"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { InstagramLogo, WhatsAppLogo } from "@/components/brand/channel-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { InboxChannel } from "@/lib/inbox/threads";
import { cn } from "@/lib/utils";

/** Each channel's colour logo, as in the sidebar (WhatsApp, Instagram DMs). */
export const CHANNEL_ICON: Readonly<
  Record<InboxChannel, ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>>
> = {
  whatsapp: WhatsAppLogo,
  instagram: InstagramLogo,
};

/** How a reply state reads: open is good news, unavailable is a warning, closed is neutral. */
export type ReplyTone = "open" | "closed" | "unavailable";

export const TONE_CLASS: Readonly<Record<ReplyTone, string>> = {
  open: "bg-ok-tint text-ok-ink",
  closed: "bg-canvas text-ink-2",
  unavailable: "border-amber-line bg-amber-tint text-amber-ink",
};

/** A reply-window tag ("Reply window open", "Templates only", "Replies unavailable"). */
export function ReplyStateTag({ tone, children }: { tone: ReplyTone; children: string }) {
  return (
    <Badge variant="secondary" className={TONE_CLASS[tone]}>
      {children}
    </Badge>
  );
}

/** The first letter of a contact's name or handle; phone numbers and ids get no letter. */
function initialOf(label: string): string | undefined {
  const first = label.replace(/^@/, "").charAt(0);
  return /\p{L}/u.test(first) ? first.toUpperCase() : undefined;
}

/** Soft avatar tints (background, letter), so people in a list are told apart at a glance. */
const AVATAR_TINTS: readonly string[] = [
  "bg-blue-50 text-blue-deep",
  "bg-ok-tint text-ok-ink",
  "bg-amber-tint text-amber-ink",
  "bg-danger-tint text-danger-ink",
  "bg-[#f1edfd] text-[#5b3fc4]",
  "bg-[#e3f6f4] text-[#0f6b63]",
];

/** The same contact always gets the same tint. */
function tintOf(label: string): string {
  let hash = 0;
  for (const char of label) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return AVATAR_TINTS[hash % AVATAR_TINTS.length]!;
}

/** A round contact mark with the channel's logo in its corner (decorative). */
export function ContactMark({
  label,
  channel,
  size = "md",
}: {
  label: string;
  channel: InboxChannel;
  size?: "md" | "lg";
}) {
  const initial = initialOf(label);
  const Icon = CHANNEL_ICON[channel];
  return (
    <span aria-hidden="true" className="relative shrink-0">
      <span
        className={cn(
          "flex items-center justify-center rounded-full font-medium",
          initial !== undefined ? tintOf(label) : "border border-line bg-paper",
          size === "lg" ? "size-11 text-base" : "size-10 text-sm",
        )}
      >
        {initial ?? <Icon className="size-5" />}
      </span>
      {initial !== undefined && (
        <span className="absolute -right-1 -bottom-1 flex size-[18px] items-center justify-center rounded-full bg-paper shadow-[0_0_0_1px_var(--color-line)]">
          <Icon className="size-3" />
        </span>
      )}
    </span>
  );
}

/** One conversation row, as each list maps it from its own API. */
export type ThreadRow = {
  id: string;
  href: string;
  channel: InboxChannel;
  contact: string;
  /** "To +1 555…" / "To @shop". */
  account: string;
  /** Read before the account in the unified inbox, where channels mix (the badge shows it). */
  channelLabel?: string;
  state: { tone: ReplyTone; label: string };
  at: string;
  /** The short time shown ("5m", "Yesterday"); `atTitle` is the full date and time. */
  atText: string;
  atTitle?: string;
};

/**
 * A conversation list (the inbox workspace's middle column): one line per contact with a short
 * time, one line with the account and the reply state, never wrapping. The open conversation's
 * row is selected and kept in view. Each view keeps its own query, paging and links.
 */
export function ThreadList({
  rows,
  canLoadMore,
  loadingMore,
  onLoadMore,
}: {
  rows: readonly ThreadRow[];
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const pathname = usePathname();
  const selectedRef = useRef<HTMLAnchorElement>(null);
  // Keep the open conversation's row in view when it changes (it may be far down the list).
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [pathname]);
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label="Conversations" className="flex flex-col gap-0.5">
        {rows.map((row) => {
          const selected = pathname === row.href;
          return (
            <li key={row.id}>
              <Link
                href={row.href}
                ref={selected ? selectedRef : undefined}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "flex min-w-0 items-center gap-3 rounded-[12px] px-3 py-2.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  selected
                    ? "bg-paper shadow-soft ring-1 ring-line"
                    : "hover:bg-paper/70 active:bg-paper",
                )}
              >
                <ContactMark label={row.contact} channel={row.channel} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex min-w-0 items-baseline justify-between gap-3">
                    <span className="truncate font-medium text-ink">{row.contact}</span>
                    <time
                      dateTime={row.at}
                      title={row.atTitle}
                      className="shrink-0 text-xs text-muted-foreground tabular-nums"
                    >
                      {row.atText}
                    </time>
                  </span>
                  <span className="flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span className="truncate">
                      {/* The avatar's logo badge shows the channel; screen readers hear its name. */}
                      {row.channelLabel !== undefined && (
                        <span className="sr-only">{row.channelLabel}: </span>
                      )}
                      {row.account}
                    </span>
                    <ReplyStateTag tone={row.state.tone}>{row.state.label}</ReplyStateTag>
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {canLoadMore && (
        <Button
          variant="outline"
          size="sm"
          className="mx-3 self-stretch"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? "Loading…" : "Show more conversations"}
        </Button>
      )}
    </div>
  );
}

/** The list's loading placeholder: row shapes, announced once. */
export function ThreadListSkeleton() {
  return (
    <div className="flex flex-col gap-0.5" role="status" aria-label="Loading conversations">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5" aria-hidden="true">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A small icon link in a list header (Saved replies, Templates, Settings); its name is the label. */
export function ListHeaderAction({
  href,
  label,
  icon: Icon,
}: {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className="grid size-8 place-items-center rounded-[8px] text-muted-foreground transition-colors hover:bg-paper hover:text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Icon className="size-4" aria-hidden="true" />
    </Link>
  );
}

/**
 * The header of the workspace's list column: the list's name (the page heading on a list page;
 * a level-2 heading while a conversation is open beside it), one line on what it holds, and its
 * icon links.
 */
export function ListColumnHeader({
  title,
  description,
  headingLevel = 1,
  actions,
}: {
  title: string;
  description: string;
  headingLevel?: 1 | 2;
  actions?: ReactNode;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <div className="flex items-start justify-between gap-2 px-3 pt-1 pb-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Heading className="text-lg font-semibold tracking-tight text-ink">{title}</Heading>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}
