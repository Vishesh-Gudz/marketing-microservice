"use client";

import { useMutation } from "convex/react";
import { X } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import type { Notice } from "@/lib/connections/types";
import { MAX_REPLY_BYTES, sendErrorNotice, utf8Length } from "@/lib/instagram/messages";
import { LIMITS } from "@/lib/messaging/saved-replies";
import { cn } from "@/lib/utils";
import { newClientMessageId } from "@/lib/whatsapp/inbox";
import { ConnectionNotice } from "../connections/connection-notice";
import { SavedReplyPicker } from "../messaging/saved-reply-picker";
import { TemplatePicker } from "./template-picker";

/**
 * A text reply in an Instagram conversation (v1/instagramMessaging:sendText), for editors and
 * admins while the server allows one. Instagram counts UTF-8 bytes (at most 1000), so the counter
 * does too. One send at a time; the draft keeps its `clientMessageId` until it is sent or
 * edited, so pressing Send again after an error can never send it twice. A refusal is shown in
 * fixed words; the sent reply then appears in the thread with its status.
 *
 * ADR 0021: a saved reply can be inserted and edited; up to 13 quick-reply buttons (20
 * characters each) can go with the reply. `humanAgent`: the 24-hour window has closed and Meta's
 * Human Agent rule applies (a person replies personally, nothing automated or promotional).
 * ADR 0022: one of the org's Instagram templates (buttons or cards) can be sent instead.
 */
export function ReplyBox({
  accountId,
  conversationId,
  contactName,
  humanAgent = false,
}: {
  accountId: string;
  conversationId: string;
  contactName?: string;
  humanAgent?: boolean;
}) {
  const sendText = useMutation(api.v1.instagramMessaging.sendText);
  const [text, setText] = useState("");
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [newQuickReply, setNewQuickReply] = useState("");
  const [draftId, setDraftId] = useState(newClientMessageId);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const inFlight = useRef(false);
  const fieldId = useId();
  const countId = useId();
  const quickId = useId();
  const bytes = utf8Length(text);
  const blank = text.trim() === "";
  const tooLong = bytes > MAX_REPLY_BYTES;
  const label = newQuickReply.trim();
  const canAddQuickReply =
    label !== "" &&
    label.length <= LIMITS.quickReplyChars &&
    !quickReplies.includes(label) &&
    quickReplies.length < LIMITS.quickReplies;

  function edited(next: { text?: string; quickReplies?: string[] }) {
    if (next.text !== undefined) setText(next.text);
    if (next.quickReplies !== undefined) setQuickReplies(next.quickReplies);
    setDraftId(newClientMessageId());
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || blank || tooLong) return;
    inFlight.current = true;
    setPending(true);
    setNotice(null);
    try {
      await sendText({
        accountId,
        conversationId,
        text,
        clientMessageId: draftId,
        ...(quickReplies.length > 0 ? { quickReplies } : {}),
      });
      setText("");
      setQuickReplies([]);
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
      {humanAgent && (
        <p className="rounded-md border border-dashed p-2 text-sm text-muted-foreground">
          Human agent reply: the 24-hour window has closed, so Meta allows only a personal reply
          from a member of your team to the customer&apos;s question, never an automated or
          promotional message.
        </p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
        <SavedReplyPicker
          channel="instagram"
          {...(contactName !== undefined ? { contactName } : {})}
          disabled={pending}
          onPick={(reply) => edited({ text: reply.text, quickReplies: reply.quickReplies })}
        />
        <TemplatePicker
          accountId={accountId}
          conversationId={conversationId}
          {...(contactName !== undefined ? { contactName } : {})}
          humanAgent={humanAgent}
          disabled={pending}
        />
      </div>
      <Label htmlFor={fieldId}>Message</Label>
      <Textarea
        id={fieldId}
        value={text}
        rows={3}
        disabled={pending}
        aria-describedby={countId}
        aria-invalid={tooLong || undefined}
        onChange={(event) => edited({ text: event.target.value })}
      />
      <span
        id={countId}
        className={cn("text-xs", tooLong ? "text-destructive" : "text-muted-foreground")}
      >
        {bytes.toLocaleString("en")} / {MAX_REPLY_BYTES.toLocaleString("en")} bytes
        {tooLong ? " (too long: shorten the message)" : " (emoji and accented letters use more)"}
      </span>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Quick-reply buttons (optional)</legend>
        {quickReplies.length > 0 && (
          <ul aria-label="Quick-reply buttons" className="flex flex-wrap gap-2">
            {quickReplies.map((title) => (
              <li
                key={title}
                className="flex items-center gap-1 rounded-full border px-3 py-1 text-sm"
              >
                {title}
                <button
                  type="button"
                  aria-label={`Remove ${title}`}
                  className="rounded-full p-0.5 hover:bg-muted"
                  disabled={pending}
                  onClick={() => edited({ quickReplies: quickReplies.filter((t) => t !== title) })}
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={quickId} className="sr-only">
            New quick-reply button
          </label>
          <Input
            id={quickId}
            className="max-w-56"
            value={newQuickReply}
            maxLength={LIMITS.quickReplyChars}
            placeholder="Button label"
            disabled={pending || quickReplies.length >= LIMITS.quickReplies}
            onChange={(e) => setNewQuickReply(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || !canAddQuickReply}
            onClick={() => {
              edited({ quickReplies: [...quickReplies, label] });
              setNewQuickReply("");
            }}
          >
            Add button
          </Button>
          <span className="text-xs text-muted-foreground">
            The customer taps one instead of typing (up to 13, 20 characters each).
          </span>
        </div>
      </fieldset>
      <div className="flex justify-end">
        <Button type="submit" disabled={pending || blank || tooLong}>
          {pending ? "Sending…" : humanAgent ? "Send as human agent" : "Send"}
        </Button>
      </div>
    </form>
  );
}
