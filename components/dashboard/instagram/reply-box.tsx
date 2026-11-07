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
import { enterRunsOwnAction } from "@/lib/messaging/enter-key";
import { LIMITS } from "@/lib/messaging/saved-replies";
import { cn } from "@/lib/utils";
import { newClientMessageId } from "@/lib/whatsapp/inbox";
import { ConnectionNotice } from "../connections/connection-notice";
import { COMPOSER_FIELD } from "../messaging/conversation";
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
 *
 * `closed` (D-M5): no reply can be sent any more (the window closed, or the account cannot
 * send). The box stays mounted, so a typed draft is kept, read-only, until it is discarded or a
 * reply is allowed again. With no draft it shows nothing.
 */
export function ReplyBox({
  accountId,
  conversationId,
  contactName,
  humanAgent = false,
  closed = false,
}: {
  accountId: string;
  conversationId: string;
  contactName?: string;
  humanAgent?: boolean;
  closed?: boolean;
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

  function addQuickReply() {
    edited({ quickReplies: [...quickReplies, label] });
    setNewQuickReply("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (closed || inFlight.current || blank || tooLong) return;
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

  if (closed && text === "" && quickReplies.length === 0) return null;

  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
      {notice && <ConnectionNotice notice={notice} />}
      {closed ? (
        <p className="text-xs text-muted-foreground">
          Your unsent draft is kept here. It can be sent if the customer writes again.
        </p>
      ) : (
        <>
          {humanAgent && (
            <p className="rounded-[10px] bg-canvas px-3 py-2 text-sm text-muted-foreground">
              Human agent reply: the 24-hour window has closed, so Meta allows only a personal reply
              from a member of your team to the customer&apos;s question, never an automated or
              promotional message.
            </p>
          )}
          <div className="flex flex-wrap items-start gap-2">
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
        </>
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
        onChange={(event) => edited({ text: event.target.value })}
      />
      <span
        id={countId}
        className={cn(
          "px-1 text-xs tabular-nums",
          tooLong ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {bytes.toLocaleString("en")} / {MAX_REPLY_BYTES.toLocaleString("en")} bytes
        {tooLong ? " (too long: shorten the message)" : " (emoji and accented letters use more)"}
      </span>
      {(!closed || quickReplies.length > 0) && (
        <fieldset className="flex flex-col gap-1.5 px-1">
          <legend className="mb-1.5 text-xs font-medium text-ink-2">
            Quick-reply buttons (optional)
          </legend>
          {quickReplies.length > 0 && (
            <ul aria-label="Quick-reply buttons" className="flex flex-wrap gap-1.5">
              {quickReplies.map((title) => (
                <li
                  key={title}
                  className="flex items-center gap-1 rounded-full border border-line bg-paper py-0.5 pr-1 pl-2.5 text-xs text-ink"
                >
                  {title}
                  {!closed && (
                    <button
                      type="button"
                      aria-label={`Remove ${title}`}
                      className="rounded-full p-0.5 text-ink-2 hover:bg-canvas hover:text-ink"
                      disabled={pending}
                      onClick={() =>
                        edited({ quickReplies: quickReplies.filter((t) => t !== title) })
                      }
                    >
                      <X aria-hidden="true" className="size-3" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!closed && (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={quickId} className="sr-only">
                New quick-reply button
              </label>
              <Input
                id={quickId}
                className="h-8 max-w-48 text-sm"
                value={newQuickReply}
                maxLength={LIMITS.quickReplyChars}
                placeholder="Button label"
                disabled={pending || quickReplies.length >= LIMITS.quickReplies}
                // Enter adds the button; it never sends the reply (D-M1).
                onKeyDown={enterRunsOwnAction(() => {
                  if (canAddQuickReply) addQuickReply();
                })}
                onChange={(e) => setNewQuickReply(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending || !canAddQuickReply}
                onClick={addQuickReply}
              >
                Add button
              </Button>
              <span className="text-xs text-muted-foreground">
                The customer taps one instead of typing (up to 13, 20 characters each).
              </span>
            </div>
          )}
        </fieldset>
      )}
      <div className="flex items-center justify-end gap-2 border-t border-line pt-2">
        {closed ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              edited({ text: "", quickReplies: [] });
              setNewQuickReply("");
            }}
          >
            Discard draft
          </Button>
        ) : (
          <Button type="submit" disabled={pending || blank || tooLong}>
            {pending ? "Sending…" : humanAgent ? "Send as human agent" : "Send"}
          </Button>
        )}
      </div>
    </form>
  );
}
