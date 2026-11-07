"use client";

import { useAction } from "convex/react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Notice } from "@/lib/connections/types";
import {
  BUSINESS_APP_DISCONNECT,
  disconnectResultNotice,
  signupErrorNotice,
} from "@/lib/whatsapp/messages";
import { ConfirmPanel } from "../library";

/**
 * Admin-only: disconnects one WhatsApp Business Account through v1/whatsapp:disconnectAccount
 * after an explicit confirmation (ADR 0014 B4). The server stops routing its numbers and revokes
 * the connection at once, then tells Meta to stop sending its webhooks here and deletes the
 * stored access. Conversations and messages are kept. One call at a time; the result (or a
 * refusal) reaches `onNotice` as fixed text. A number kept in the WhatsApp Business app
 * (`businessApp`, ADR 0019) is released from Meta's Business Platform only in the app itself.
 */
export function DisconnectWhatsApp({
  accountId,
  name,
  businessApp = false,
  onNotice,
}: {
  accountId: string;
  name: string;
  businessApp?: boolean;
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
    <ConfirmPanel
      titleId={titleId}
      title={`Disconnect ${name}?`}
      consequences={[
        "Messages for its numbers stop reaching this app at once.",
        "Conversations and messages so far are kept.",
        "Meta is told to stop sending them here, and the stored access is deleted.",
        ...(businessApp
          ? [
              <>
                The number keeps working in the WhatsApp Business app. To release it from
                Meta&apos;s Business Platform too: {BUSINESS_APP_DISCONNECT.charAt(0).toLowerCase()}
                {BUSINESS_APP_DISCONNECT.slice(1)}.
              </>,
            ]
          : []),
        "Afterwards, use Connect WhatsApp to connect it again.",
      ]}
      pending={pending}
      onCancel={() => setConfirming(false)}
    >
      <Button type="button" variant="destructive" disabled={pending} onClick={() => void confirm()}>
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
    </ConfirmPanel>
  );
}
