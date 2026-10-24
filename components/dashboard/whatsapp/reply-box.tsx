"use client";

import { useMutation } from "convex/react";
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { api } from "@/convex/_generated/api";
import type { Notice } from "@/lib/connections/types";
import { cn } from "@/lib/utils";
import { MAX_REPLY_CHARS, newClientMessageId } from "@/lib/whatsapp/inbox";
import { sendErrorNotice } from "@/lib/whatsapp/messages";
import { ConnectionNotice } from "../connections/connection-notice";

/**
 * A free-form text reply (v1/whatsapp:sendText), for editors and admins while the customer's
 * reply window is open. One send at a time. The draft keeps its `clientMessageId` until it is
 * sent or edited, so pressing Send again after an error can never send it twice. A refusal is
 * shown in fixed words; the sent message then appears in the thread with its status.
 */
export function ReplyBox({ conversationId }: { conversationId: string }) {
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
      <Label htmlFor={fieldId}>Message</Label>
      <textarea
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
        className={cn(
          "w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        )}
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
