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
import { SavedReplyPicker } from "../messaging/saved-reply-picker";

/**
 * A free-form text reply (v1/whatsapp:sendText), for editors and admins while the customer's
 * reply window is open. One send at a time. The draft keeps its `clientMessageId` until it is
 * sent or edited, so pressing Send again after an error can never send it twice. A refusal is
 * shown in fixed words; the sent message then appears in the thread with its status.
 */
export function ReplyBox({
  conversationId,
  contactName,
}: {
  conversationId: string;
  /** For saved replies (ADR 0021): fills in `{{customer_name}}`. */
  contactName?: string;
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
    if (inFlight.current || blank || tooLong) return;
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

  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
      {notice && <ConnectionNotice notice={notice} />}
      <SavedReplyPicker
        channel="whatsapp"
        {...(contactName !== undefined ? { contactName } : {})}
        disabled={pending}
        onPick={(reply) => {
          setText(reply.text);
          setDraftId(newClientMessageId());
        }}
      />
      <Label htmlFor={fieldId}>Message</Label>
      <Textarea
        id={fieldId}
        value={text}
        rows={3}
        disabled={pending}
        aria-describedby={countId}
        aria-invalid={tooLong || undefined}
        onChange={(event) => {
          setText(event.target.value);
          setDraftId(newClientMessageId());
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <span
          id={countId}
          className={cn("text-xs", tooLong ? "text-destructive" : "text-muted-foreground")}
        >
          {text.length} / {MAX_REPLY_CHARS} characters
        </span>
        <Button type="submit" disabled={pending || blank || tooLong}>
          {pending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
