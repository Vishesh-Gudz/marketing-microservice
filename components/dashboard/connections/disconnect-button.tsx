"use client";

import { useMutation } from "convex/react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Connection } from "@/lib/analytics/types";
import { disconnectActionNotice } from "@/lib/connections/messages";
import { PROVIDERS, type ConnectionProvider } from "@/lib/connections/providers";
import type { Notice } from "@/lib/connections/types";
import { ConnectionNotice } from "./connection-notice";

/**
 * Admin-only: disconnects the shown connection through v1/connections:disconnect after an
 * explicit confirmation. For the ad platforms the server revokes the connection, unlinks its
 * accounts (rows and data are kept) and deletes its credential; for YouTube it also deletes
 * the channel's stored data (ADR 0016), so the caller passes its own `consequences`.
 * Afterwards Connect starts a fresh connection, which may use a different account (Reconnect
 * only accepts the same one).
 */
export function DisconnectButton({
  provider,
  connection,
  onDisconnected,
  consequences,
  confirmLabel = "Disconnect",
}: {
  provider: ConnectionProvider;
  connection: Connection;
  onDisconnected: () => void;
  /** What disconnecting does, listed in the confirmation (default: the ad platforms' rules). */
  consequences?: readonly string[];
  confirmLabel?: string;
}) {
  const disconnect = useMutation(api.v1.connections.disconnect);
  const { name, platform, identity } = PROVIDERS[provider];
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Notice | null>(null);
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
    setError(null);
    try {
      await disconnect({ connectionId: connection.id });
      onDisconnected();
    } catch (caught) {
      setError(disconnectActionNotice(caught, provider));
      inFlight.current = false;
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
          Disconnect {name}
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
        Disconnect {name}?
      </p>
      <ul className="list-disc pl-5 text-muted-foreground">
        {(
          consequences ?? [
            "Linked accounts stop syncing. Their data and history are kept.",
            `The stored ${platform} access is deleted.`,
            `Afterwards, connect again to sign in with any ${identity}.`,
          ]
        ).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() => void confirm()}
        >
          {pending ? "Disconnecting…" : confirmLabel}
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
