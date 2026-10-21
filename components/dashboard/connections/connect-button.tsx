"use client";

import { useAction } from "convex/react";
import { useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Connection } from "@/lib/analytics/types";
import { connectionActionNotice } from "@/lib/connections/messages";
import { connectReturnUrl, navigateToAuthorization } from "@/lib/connections/navigation";
import { PROVIDERS, type AdConnectionProvider } from "@/lib/connections/providers";
import type { Notice } from "@/lib/connections/types";
import { ConnectionNotice } from "./connection-notice";

/**
 * Admin-only: starts the provider's OAuth through v1/connections:beginConnect and leaves for
 * the consent page in the same tab. Reconnecting passes the connection id, so the server can
 * refuse a different identity (identity_mismatch). The authorization URL is used once and
 * never rendered, logged or stored. The button stays disabled until the page is left, so a
 * second click never starts a second connection.
 */
export function ConnectButton({
  provider,
  connection,
}: {
  provider: AdConnectionProvider;
  connection: Connection | undefined;
}) {
  const beginConnect = useAction(api.v1.connections.beginConnect);
  const searchParams = useSearchParams();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Notice | null>(null);
  const inFlight = useRef(false);
  const { name, platform } = PROVIDERS[provider];
  const reconnect = connection !== undefined;

  async function start() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const { authorizeUrl } = await beginConnect({
        provider,
        returnUrl: connectReturnUrl(window.location.origin, searchParams, provider),
        ...(connection !== undefined ? { reconnectConnectionId: connection.id } : {}),
      });
      navigateToAuthorization(authorizeUrl);
    } catch (caught) {
      setError(connectionActionNotice(caught, provider));
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        variant={connection?.status === "active" ? "outline" : "default"}
        disabled={pending}
        onClick={() => void start()}
      >
        {pending
          ? `Opening ${platform} sign-in…`
          : reconnect
            ? `Reconnect ${name}`
            : `Connect ${name}`}
      </Button>
      {error && <ConnectionNotice notice={error} />}
    </div>
  );
}
