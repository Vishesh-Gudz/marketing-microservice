"use client";

import { useMutation } from "convex/react";
import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import type { Notice } from "@/lib/connections/types";
import {
  CHANNEL_LABELS,
  CUSTOMER_NAME,
  LIMITS,
  savedReplyErrorNotice,
  textTooLong,
  utf8Bytes,
  type SavedReply,
  type SavedReplyChannel,
} from "@/lib/messaging/saved-replies";
import {
  SAVED_REPLY_STARTERS,
  STARTER_GROUP_LABELS,
  type SavedReplyStarter,
} from "@/lib/messaging/saved-reply-starters";
import { cn } from "@/lib/utils";
import { ConnectionNotice } from "../connections/connection-notice";
import { EmptyState } from "../empty-state";
import { Breadcrumbs, PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";

const FIELD =
  "w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20";

type Draft = {
  id?: string;
  title: string;
  text: string;
  channels: SavedReplyChannel[];
  quickReplies: string[];
};

const EMPTY: Draft = { title: "", text: "", channels: ["whatsapp", "instagram"], quickReplies: [] };

function fromStarter(starter: SavedReplyStarter): Draft {
  return {
    title: starter.title,
    text: starter.text,
    channels: starter.channels,
    quickReplies: starter.quickReplies ?? [],
  };
}

function fromReply(reply: SavedReply): Draft {
  return {
    id: reply.id,
    title: reply.title,
    text: reply.text,
    channels: reply.channels,
    quickReplies: reply.quickReplies ?? [],
  };
}

/** Creating or changing one saved reply (editors and admins). */
function SavedReplyForm({
  initial,
  onDone,
  onCancel,
}: {
  initial: Draft;
  onDone: (notice: Notice) => void;
  onCancel: () => void;
}) {
  const create = useMutation(api.v1.savedReplies.create);
  const update = useMutation(api.v1.savedReplies.update);
  const [draft, setDraft] = useState<Draft>(initial);
  const [newQuickReply, setNewQuickReply] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const inFlight = useRef(false);
  const id = useId();
  const instagram = draft.channels.includes("instagram");
  const tooLong = textTooLong(draft.text, draft.channels);
  const label = newQuickReply.trim();
  const ready =
    draft.title.trim() !== "" &&
    draft.title.length <= LIMITS.title &&
    draft.text.trim() !== "" &&
    !tooLong &&
    draft.channels.length > 0;
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !ready) return;
    inFlight.current = true;
    setPending(true);
    setNotice(null);
    const input = {
      title: draft.title,
      text: draft.text,
      channels: draft.channels,
      ...(instagram && draft.quickReplies.length > 0 ? { quickReplies: draft.quickReplies } : {}),
    };
    try {
      const saved =
        draft.id === undefined
          ? await create(input)
          : await update({ savedReplyId: draft.id, ...input });
      onDone({
        tone: "success",
        title: draft.id === undefined ? "Saved reply added" : "Saved reply updated",
        message: `“${saved.title}” can now be inserted in the reply box.`,
      });
    } catch (error) {
      setNotice(savedReplyErrorNotice(error));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <form
      aria-label={draft.id === undefined ? "New saved reply" : "Edit saved reply"}
      className="flex flex-col gap-4 rounded-lg border p-4"
      onSubmit={(event) => void submit(event)}
    >
      {notice && <ConnectionNotice notice={notice} />}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          id={`${id}-title`}
          value={draft.title}
          maxLength={LIMITS.title}
          onChange={(e) => set({ title: e.target.value })}
        />
        <span className="text-xs text-muted-foreground">Only your team sees it.</span>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-sm font-medium">Offer it in</legend>
        <div className="flex flex-wrap gap-4">
          {(["whatsapp", "instagram"] as const).map((channel) => (
            <label key={channel} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.channels.includes(channel)}
                onChange={(e) =>
                  set({
                    channels: e.target.checked
                      ? [...draft.channels, channel]
                      : draft.channels.filter((c) => c !== channel),
                  })
                }
              />
              {CHANNEL_LABELS[channel]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-text`}>Reply</Label>
        <textarea
          id={`${id}-text`}
          rows={5}
          className={FIELD}
          value={draft.text}
          aria-invalid={tooLong || undefined}
          onChange={(e) => set({ text: e.target.value })}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={cn("text-xs", tooLong ? "text-destructive" : "text-muted-foreground")}>
            {instagram
              ? `${utf8Bytes(draft.text)} / ${LIMITS.instagramBytes} bytes (Instagram's limit)`
              : `${draft.text.length} / ${LIMITS.whatsappChars} characters`}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              set({
                text: `${draft.text}${draft.text === "" || draft.text.endsWith(" ") ? "" : " "}${CUSTOMER_NAME}`,
              })
            }
          >
            Insert customer name
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">
          {CUSTOMER_NAME} becomes the customer&apos;s first name when you insert the reply. Edit
          anything in [brackets] before saving.
        </span>
      </div>
      {instagram && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Quick-reply buttons (Instagram, optional)</legend>
          {draft.quickReplies.length > 0 && (
            <ul aria-label="Quick-reply buttons" className="flex flex-wrap gap-2">
              {draft.quickReplies.map((title) => (
                <li
                  key={title}
                  className="flex items-center gap-1 rounded-full border px-3 py-1 text-sm"
                >
                  {title}
                  <button
                    type="button"
                    aria-label={`Remove ${title}`}
                    className="rounded-full p-0.5 hover:bg-muted"
                    onClick={() =>
                      set({ quickReplies: draft.quickReplies.filter((t) => t !== title) })
                    }
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${id}-quick`} className="sr-only">
              New quick-reply button
            </label>
            <Input
              id={`${id}-quick`}
              className="max-w-56"
              value={newQuickReply}
              maxLength={LIMITS.quickReplyChars}
              placeholder="Button label"
              onChange={(e) => setNewQuickReply(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={
                label === "" ||
                draft.quickReplies.includes(label) ||
                draft.quickReplies.length >= LIMITS.quickReplies
              }
              onClick={() => {
                set({ quickReplies: [...draft.quickReplies, label] });
                setNewQuickReply("");
              }}
            >
              Add button
            </Button>
          </div>
        </fieldset>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || !ready}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Deletes one saved reply after a confirmation. */
function DeleteSavedReply({
  reply,
  onNotice,
}: {
  reply: SavedReply;
  onNotice: (notice: Notice | null) => void;
}) {
  const remove = useMutation(api.v1.savedReplies.remove);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  if (!confirming) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(true)}>
        Delete
      </Button>
    );
  }
  return (
    <span
      role="group"
      aria-label={`Delete ${reply.title}?`}
      className="flex items-center gap-2 text-sm"
    >
      Delete “{reply.title}”?
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={pending}
        onClick={() => {
          setPending(true);
          remove({ savedReplyId: reply.id }).then(
            () =>
              onNotice({
                tone: "success",
                title: "Saved reply deleted",
                message: `“${reply.title}” was deleted.`,
              }),
            (error: unknown) => {
              setPending(false);
              setConfirming(false);
              onNotice(savedReplyErrorNotice(error));
            },
          );
        }}
      >
        {pending ? "Deleting…" : "Delete"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => setConfirming(false)}
      >
        Cancel
      </Button>
    </span>
  );
}

/** The ready-made replies by group; choosing one opens the form filled in. */
function StarterGallery({ onUse }: { onUse: (starter: SavedReplyStarter) => void }) {
  const groups = Object.keys(STARTER_GROUP_LABELS) as SavedReplyStarter["group"][];
  return (
    <section aria-labelledby="saved-reply-starters" className="flex flex-col gap-3">
      <h2 id="saved-reply-starters" className="text-lg font-semibold">
        Ready-made replies
      </h2>
      {groups.map((group) => (
        <div key={group} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">
            {STARTER_GROUP_LABELS[group]}
          </h3>
          <ul
            aria-label={STARTER_GROUP_LABELS[group]}
            className="grid gap-2 md:grid-cols-2 xl:grid-cols-3"
          >
            {SAVED_REPLY_STARTERS.filter((s) => s.group === group).map((starter) => (
              <li
                key={starter.id}
                aria-label={starter.title}
                className="flex flex-col gap-2 rounded-lg border p-3 text-sm"
              >
                <span className="font-medium">{starter.title}</span>
                <span className="text-muted-foreground">{starter.text}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-auto self-start"
                  onClick={() => onUse(starter)}
                >
                  Use this reply
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function SavedReplies({ onNotice }: { onNotice: (notice: Notice | null) => void }) {
  const { role } = useOrg();
  const canEdit = role === "admin" || role === "editor";
  const { data: replies } = useAnalyticsQuery(api.v1.savedReplies.list, {});
  const [editing, setEditing] = useState<Draft | null>(null);
  const [showStarters, setShowStarters] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const open = (draft: Draft) => {
    onNotice(null);
    setEditing(draft);
    setShowStarters(false);
  };
  useEffect(() => {
    if (editing !== null) formRef.current?.scrollIntoView?.({ block: "start" });
  }, [editing]);

  if (replies === undefined) {
    return <Skeleton className="h-40 w-full" role="status" aria-label="Loading saved replies" />;
  }
  return (
    <div className="flex flex-col gap-6">
      {canEdit && editing === null && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => open(EMPTY)}>
            <Plus aria-hidden="true" />
            New saved reply
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-expanded={showStarters}
            onClick={() => setShowStarters((s) => !s)}
          >
            Ready-made replies
          </Button>
        </div>
      )}
      {editing !== null && (
        <div ref={formRef}>
          <SavedReplyForm
            key={editing.id ?? editing.title}
            initial={editing}
            onCancel={() => setEditing(null)}
            onDone={(notice) => {
              setEditing(null);
              onNotice(notice);
            }}
          />
        </div>
      )}
      {showStarters && editing === null && (
        <StarterGallery onUse={(starter) => open(fromStarter(starter))} />
      )}
      <section aria-labelledby="saved-reply-list" className="flex flex-col gap-3">
        <h2 id="saved-reply-list" className="text-lg font-semibold">
          Your saved replies
        </h2>
        {replies.length === 0 ? (
          <EmptyState title="No saved replies yet">
            {canEdit
              ? "Add your own, or start from a ready-made reply: opening hours, shipping, returns, bookings and more."
              : "Editors and admins can add saved replies here."}
          </EmptyState>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {replies.map((reply) => (
              <li
                key={reply.id}
                aria-label={reply.title}
                className="flex flex-col gap-2 rounded-lg border p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium">{reply.title}</h3>
                  {reply.channels.map((channel) => (
                    <Badge key={channel} variant="outline">
                      {CHANNEL_LABELS[channel]}
                    </Badge>
                  ))}
                </div>
                <p className="text-sm break-words whitespace-pre-wrap">{reply.text}</p>
                {reply.quickReplies !== undefined && (
                  <ul aria-label="Quick-reply buttons" className="flex flex-wrap gap-1">
                    {reply.quickReplies.map((title) => (
                      <li key={title} className="rounded-full border px-2 py-0.5 text-xs">
                        {title}
                      </li>
                    ))}
                  </ul>
                )}
                {canEdit && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => open(fromReply(reply))}
                    >
                      Edit
                    </Button>
                    <DeleteSavedReply reply={reply} onNotice={onNotice} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Saved replies (/inbox/saved-replies; ADR 0021): the org's reusable answers for WhatsApp and
 * Instagram, inserted from the reply box of a conversation. Every member sees them; editors and
 * admins add (from scratch or a ready-made reply), edit and delete them.
 */
export function SavedRepliesView() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const onNotice = useCallback((next: Notice | null) => setNotice(next), []);
  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);
  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs items={[{ label: "Inbox", href: "/inbox" }, { label: "Saved replies" }]} />
      <PageHeader
        title="Saved replies"
        description="Answers your team sends often, ready to insert in a WhatsApp or Instagram reply and edit before sending."
      />
      {notice && (
        <div ref={noticeRef} tabIndex={-1} className="outline-none">
          <ConnectionNotice notice={notice} />
        </div>
      )}
      <QueryBoundary resetKey="saved-replies" title="Saved replies">
        <SavedReplies onNotice={onNotice} />
      </QueryBoundary>
    </div>
  );
}
