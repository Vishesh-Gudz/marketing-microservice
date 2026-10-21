"use client";

import { useAction } from "convex/react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Connection } from "@/lib/analytics/types";
import { connectionActionNotice } from "@/lib/connections/messages";
import { connectReturnUrl, navigateToAuthorization } from "@/lib/connections/navigation";
import type { Notice } from "@/lib/connections/types";
import { ConnectionNotice } from "./connection-notice";

/**
 * Admin-only: starts Google OAuth through v1/connections:beginConnect and leaves for the
 * consent page in the same tab. Reconnecting passes the connection id, so the server can
 * refuse a different Google identity (identity_mismatch). The authorization URL is used once
 * and never rendered, logged or stored.
 */
export function ConnectButton({ connection }: { connection: Connection | undefined }) {
  const beginConnect = useAction(api.v1.connections.beginConnect);
  const searchParams = useSearchParams();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Notice | null>(null);
  const reconnect = connection !== undefined;

  async function start() {
    setPending(true);
    setError(null);
    try {
      const { authorizeUrl } = await beginConnect({
        provider: "google_ads",
        returnUrl: connectReturnUrl(window.location.origin, searchParams),
        ...(connection !== undefined ? { reconnectConnectionId: connection.id } : {}),
      });
      navigateToAuthorization(authorizeUrl);
    } catch (caught) {
      setError(connectionActionNotice(caught));
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
          ? "Opening Google sign-in…"
          : reconnect
            ? "Reconnect Google Ads"
            : "Connect Google Ads"}
      </Button>
      {error && <ConnectionNotice notice={error} />}
    </div>
  );
}
