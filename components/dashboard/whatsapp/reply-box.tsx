"use client";

import { useMutation } from "convex/react";
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import type { Notice } from "@/lib/connections/types";
import { cn } from "@/lib/utils";
import { MAX_REPLY_CHARS, newClientMessageId } from "@/lib/whatsapp/inbox";
import { sendErrorNotice } from "@/lib/whatsapp/messages";
import { ConnectionNotice } from "../connections/connection-notice";
import {
  COMPOSER_FIELD,
  LockTitle,
  LockedComposer,
  type ReplyLock,
} from "../messaging/conversation";
import { SavedReplyPicker } from "../messaging/saved-reply-picker";

/**
 * A free-form text reply (v1/whatsapp:sendText), for editors and admins while the customer's
 * reply window is open. One send at a time. The draft keeps its `clientMessageId` until it is
 * sent or edited, so pressing Send again after an error can never send it twice. A refusal is
 * shown in fixed words; the sent message then appears in the thread with its status.
 *
 * `closed` (D-M5): the window closed (or the number cannot send) while the box was open. The box
 * stays mounted, so a typed draft is kept, read-only, until it is discarded or the window opens
 * again; nothing can be sent from it meanwhile. With no draft it shows the locked composer
 * (`lock`, L1) or, without one (the number cannot send: the view shows why), nothing.
 */
export function ReplyBox({
  conversationId,
  contactName,
  closed = false,
  lock,
}: {
  conversationId: string;
  /** For saved replies (ADR 0021): fills in `{{customer_name}}`. */
  contactName?: string;
  closed?: boolean;
  /** Why replying is paused (the window closed): shown in place of the field while `closed`. */
  lock?: ReplyLock | undefined;
}) {
  const sendText = useMutation(api.v1.whatsapp.sendText);
  const [text, setText] = useState("");
  const [draftId, setDraftId] = useState(newClientMessageId);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const inFlight = useRef(false);
  const fieldId = useId();
  const countId = useId();
  const blank = text.trim() === "";
  const tooLong = text.length > MAX_REPLY_CHARS;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (closed || inFlight.current || blank || tooLong) return;
    inFlight.current = true;
    setPending(true);
    setNotice(null);
    try {
      await sendText({ conversationId, text, clientMessageId: draftId });
      setText("");
      setDraftId(newClientMessageId());
    } catch (error) {
      setNotice(sendErrorNotice(error));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  if (closed && text === "") return lock !== undefined ? <LockedComposer lock={lock} /> : null;

  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
      {notice && <ConnectionNotice notice={notice} />}
      {closed ? (
        <>
          {lock !== undefined && <LockTitle title={lock.title} />}
          <p className="text-xs text-muted-foreground">
            Your unsent draft is kept here. It can be sent if the customer writes again.
          </p>
        </>
      ) : (
        <SavedReplyPicker
          channel="whatsapp"
          {...(contactName !== undefined ? { contactName } : {})}
          disabled={pending}
          onPick={(reply) => {
            setText(reply.text);
            setDraftId(newClientMessageId());
          }}
        />
      )}
      <Label htmlFor={fieldId} className="sr-only">
        Message
      </Label>
      <Textarea
        id={fieldId}
        value={text}
        rows={3}
        placeholder="Write a reply…"
        className={COMPOSER_FIELD}
        readOnly={closed}
        disabled={pending}
        aria-describedby={countId}
        aria-invalid={tooLong || undefined}
        onChange={(event) => {
          setText(event.target.value);
          setDraftId(newClientMessageId());
        }}
      />
      <div className="flex items-center justify-between gap-2 border-t border-line pt-2">
        <span
          id={countId}
          className={cn(
            "text-xs tabular-nums",
            tooLong ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {text.length} / {MAX_REPLY_CHARS} characters
        </span>
        {closed ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setText("");
              setDraftId(newClientMessageId());
            }}
          >
            Discard draft
          </Button>
        ) : (
          <Button type="submit" disabled={pending || blank || tooLong}>
            {pending ? "Sending…" : "Send"}
          </Button>
        )}
      </div>
    </form>
  );
}
