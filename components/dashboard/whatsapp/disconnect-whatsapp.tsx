"use client";

import { useAction } from "convex/react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Notice } from "@/lib/connections/types";
import { disconnectResultNotice, signupErrorNotice } from "@/lib/whatsapp/messages";

/**
 * Admin-only: disconnects one WhatsApp Business Account through v1/whatsapp:disconnectAccount
 * after an explicit confirmation (ADR 0014 B4). The server stops routing its numbers and revokes
 * the connection at once, then tells Meta to stop sending its webhooks here and deletes the
 * stored access. Conversations and messages are kept. One call at a time; the result (or a
 * refusal) reaches `onNotice` as fixed text.
 */
export function DisconnectWhatsApp({
  accountId,
  name,
  onNotice,
}: {
  accountId: string;
  name: string;
  onNotice: (notice: Notice | null) => void;
}) {
  const disconnect = useAction(api.v1.whatsapp.disconnectAccount);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  const inFlight = useRef(false);

  // Focus the safe choice when the confirmation opens, and return to the trigger when it closes.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (opened.current) triggerRef.current?.focus();
    opened.current = confirming;
  }, [confirming]);

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    onNotice(null);
    try {
      onNotice(disconnectResultNotice(await disconnect({ accountId })));
    } catch (error) {
      onNotice(signupErrorNotice(error));
    } finally {
      inFlight.current = false;
      setPending(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <Button
        ref={triggerRef}
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setConfirming(true)}
      >
        Disconnect
      </Button>
    );
  }

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="flex w-full flex-col gap-3 rounded-md border border-destructive/40 p-3 text-sm"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) setConfirming(false);
      }}
    >
      <p id={titleId} className="font-medium">
        Disconnect {name}?
      </p>
      <ul className="list-disc pl-5 text-muted-foreground">
        <li>Messages for its numbers stop reaching this app at once.</li>
        <li>Conversations and messages so far are kept.</li>
        <li>Meta is told to stop sending them here, and the stored access is deleted.</li>
        <li>Afterwards, use Connect WhatsApp to connect it again.</li>
      </ul>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() => void confirm()}
        >
          {pending ? "Disconnecting…" : "Disconnect"}
        </Button>
        <Button
          ref={cancelRef}
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
