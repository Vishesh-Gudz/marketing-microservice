"use client";

import { BookmarkPlus } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import {
  fillSavedReply,
  type SavedReply,
  type SavedReplyChannel,
} from "@/lib/messaging/saved-replies";

/**
 * "Saved replies" in a reply box (ADR 0021): lists the org's saved replies for this channel
 * (loaded only once opened) and inserts the chosen one, with the customer's first name in place
 * of `{{customer_name}}`, into the box, where it can be edited before sending. Instagram ones
 * also bring their quick-reply buttons.
 */
export function SavedReplyPicker({
  channel,
  contactName,
  disabled,
  onPick,
}: {
  channel: SavedReplyChannel;
  contactName?: string;
  disabled?: boolean;
  onPick: (reply: { text: string; quickReplies: string[] }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const panelId = useId();
  const searchId = useId();
  const { data: replies } = useAnalyticsQuery(
    api.v1.savedReplies.list,
    open ? { channel } : "skip",
  );
  const term = search.trim().toLowerCase();
  const shown = (replies ?? []).filter(
    (reply: SavedReply) =>
      term === "" ||
      reply.title.toLowerCase().includes(term) ||
      reply.text.toLowerCase().includes(term),
  );

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <BookmarkPlus aria-hidden="true" />
        Saved replies
      </Button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Saved replies"
          className="flex flex-col gap-2 rounded-md border p-3"
        >
          <label htmlFor={searchId} className="sr-only">
            Search saved replies
          </label>
          <Input
            id={searchId}
            value={search}
            placeholder="Search saved replies"
            onChange={(e) => setSearch(e.target.value)}
          />
          {replies === undefined ? (
            <Skeleton className="h-16 w-full" role="status" aria-label="Loading saved replies" />
          ) : shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {replies.length === 0 ? "No saved replies yet. " : "No saved reply matches. "}
              <Link href="/inbox/saved-replies" className="underline underline-offset-4">
                Manage saved replies
              </Link>
            </p>
          ) : (
            <ul
              aria-label="Saved replies for this channel"
              className="flex max-h-64 flex-col gap-1 overflow-y-auto"
            >
              {shown.map((reply) => (
                <li key={reply.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                    onClick={() => {
                      onPick({
                        text: fillSavedReply(reply.text, contactName),
                        quickReplies: channel === "instagram" ? (reply.quickReplies ?? []) : [],
                      });
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <span className="font-medium">{reply.title}</span>
                    <span className="line-clamp-2 text-muted-foreground">{reply.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
