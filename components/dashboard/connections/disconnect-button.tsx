"use client";

import { useMutation } from "convex/react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Connection } from "@/lib/analytics/types";
import { disconnectActionNotice } from "@/lib/connections/messages";
import type { Notice } from "@/lib/connections/types";
import { ConnectionNotice } from "./connection-notice";

/**
 * Admin-only: disconnects the shown Google Ads connection through v1/connections:disconnect
 * after an explicit confirmation. The server revokes the connection, unlinks its accounts
 * (rows and data are kept) and deletes its credential. Afterwards Connect starts a fresh
 * connection, which may use a different Google account (Reconnect only accepts the same one).
 */
export function DisconnectButton({
  connection,
  onDisconnected,
}: {
  connection: Connection;
  onDisconnected: () => void;
}) {
  const disconnect = useMutation(api.v1.connections.disconnect);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Notice | null>(null);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);

  // Focus the safe choice when the confirmation opens, and return to the trigger when it closes.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (opened.current) triggerRef.current?.focus();
    opened.current = confirming;
  }, [confirming]);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await disconnect({ connectionId: connection.id });
      onDisconnected();
    } catch (caught) {
      setError(disconnectActionNotice(caught));
      setPending(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          Disconnect Google Ads
        </Button>
        {error && <ConnectionNotice notice={error} />}
      </div>
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
        Disconnect Google Ads?
      </p>
      <ul className="list-disc pl-5 text-muted-foreground">
        <li>Linked accounts stop syncing. Their data and history are kept.</li>
        <li>The stored Google access is deleted.</li>
        <li>Afterwards, connect again to sign in with any Google account.</li>
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
