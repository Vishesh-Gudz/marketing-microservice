"use client";

import Link from "next/link";
import type { ComponentType } from "react";
import { InstagramLogo, WhatsAppLogo } from "@/components/brand/channel-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { InboxChannel } from "@/lib/inbox/threads";
import { cn } from "@/lib/utils";
import { SURFACE } from "../surface";

/** Each channel's colour logo, as in the sidebar (WhatsApp, Instagram DMs). */
export const CHANNEL_ICON: Readonly<
  Record<InboxChannel, ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>>
> = {
  whatsapp: WhatsAppLogo,
  instagram: InstagramLogo,
};

/** How a reply state reads: open is good news, unavailable is a warning, closed is neutral. */
export type ReplyTone = "open" | "closed" | "unavailable";

const TONE_CLASS: Readonly<Record<ReplyTone, string>> = {
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

/** A round contact mark with the channel glyph in its corner (decorative). */
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
          "flex items-center justify-center rounded-full border border-line bg-canvas font-medium text-ink-2",
          size === "lg" ? "size-11 text-base" : "size-9 text-sm",
        )}
      >
        {initial ?? <Icon className="size-4" />}
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
  /** Shown before the account in the unified inbox, where channels mix. */
  channelLabel?: string;
  state: { tone: ReplyTone; label: string };
  at: string;
  atText: string;
};

/**
 * A conversation list: one line per contact with the time, one line with the account and the
 * reply state, never wrapping. Each view keeps its own query, paging and links.
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
  return (
    <div className="flex flex-col gap-3">
      <ul
        aria-label="Conversations"
        className={cn(SURFACE, "divide-y divide-line overflow-hidden")}
      >
        {rows.map((row) => (
          <li key={row.id}>
            <Link
              href={row.href}
              className="flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-canvas focus-visible:bg-canvas focus-visible:outline-none"
            >
              <ContactMark label={row.contact} channel={row.channel} />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="truncate font-medium text-ink">{row.contact}</span>
                  <time
                    dateTime={row.at}
                    className="shrink-0 text-xs text-muted-foreground tabular-nums"
                  >
                    {row.atText}
                  </time>
                </span>
                <span className="flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="truncate">
                    {row.channelLabel !== undefined && (
                      <span className="font-medium text-ink-2">{row.channelLabel} · </span>
                    )}
                    {row.account}
                  </span>
                  <ReplyStateTag tone={row.state.tone}>{row.state.label}</ReplyStateTag>
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {canLoadMore && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
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
    <div
      className={cn(SURFACE, "divide-y divide-line overflow-hidden")}
      role="status"
      aria-label="Loading conversations"
    >
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3" aria-hidden="true">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
      ))}
    </div>
  );
}
