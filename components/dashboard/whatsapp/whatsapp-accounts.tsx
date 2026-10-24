"use client";

import { useAction } from "convex/react";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import type { Notice } from "@/lib/connections/types";
import {
  accountSetupText,
  SETUP_STATUS_LABELS,
  setupResultNotice,
  signupErrorNotice,
} from "@/lib/whatsapp/messages";
import type { SetupStatus, WhatsAppAccount } from "@/lib/whatsapp/types";
import { formatInstant } from "../freshness-note";
import type { EmbeddedSignup } from "./connect-whatsapp";

const BADGE_VARIANT: Readonly<
  Record<SetupStatus, "default" | "secondary" | "destructive" | "outline">
> = {
  connected: "default",
  action_required: "secondary",
  reauthorization_required: "destructive",
  disconnected: "outline",
};

/** Admin-only: resumes the missing setup steps (v1/whatsapp:retrySetup); one call at a time. */
function RetrySetupButton({
  accountId,
  onNotice,
}: {
  accountId: string;
  onNotice: (notice: Notice | null) => void;
}) {
  const retrySetup = useAction(api.v1.whatsapp.retrySetup);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  async function retry() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    onNotice(null);
    try {
      onNotice(setupResultNotice(await retrySetup({ accountId })));
    } catch (error) {
      onNotice(signupErrorNotice(error));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => void retry()}
    >
      {pending ? "Retrying setup…" : "Retry setup"}
    </Button>
  );
}

function AccountCard({
  account,
  name,
  isAdmin,
  signup,
  onNotice,
}: {
  account: WhatsAppAccount;
  name: string;
  isAdmin: boolean;
  signup: EmbeddedSignup;
  onNotice: (notice: Notice | null) => void;
}) {
  const { timezone } = useOrg();
  const headingId = `whatsapp-account-${account.id}`;
  const explanation = accountSetupText(account);
  const canRetry = account.setupStatus === "action_required" && account.nextStep !== undefined;
  return (
    <li aria-labelledby={headingId} className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="font-medium">
          {name}
        </h3>
        <Badge variant={BADGE_VARIANT[account.setupStatus]}>
          {SETUP_STATUS_LABELS[account.setupStatus]}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        WhatsApp Business account {account.wabaId} · connected{" "}
        {formatInstant(account.connectedAt, timezone)}
      </p>
      {explanation && <p className="text-sm">{explanation}</p>}
      {account.numbers.length > 0 && (
        <ul aria-label={`Phone numbers of ${name}`} className="flex flex-col gap-1 text-sm">
          {account.numbers.map((number) => (
            <li key={number.id} className="flex flex-wrap gap-x-2">
              <span className="font-medium">
                {number.displayPhoneNumber ?? `Number ${number.phoneNumberId}`}
              </span>
              <span className="text-muted-foreground">
                {number.status === "active"
                  ? number.registered
                    ? "Registered for messaging"
                    : "Not registered for messaging yet"
                  : "Disconnected"}
                {number.registrationRetryAfter !== undefined &&
                  ` · registration can be retried after ${formatInstant(number.registrationRetryAfter, timezone)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {isAdmin && (canRetry || account.setupStatus === "reauthorization_required") && (
        <div className="flex flex-wrap gap-2">
          {canRetry && <RetrySetupButton accountId={account.id} onNotice={onNotice} />}
          {account.setupStatus === "reauthorization_required" && (
            <Button
              type="button"
              size="sm"
              disabled={signup.status !== "ready"}
              onClick={signup.start}
            >
              Connect again
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The org's WhatsApp Business accounts (every role): setup status, numbers and, for admins,
 * Retry setup / Connect again. Everything comes from the public v1 API; the server enforces
 * roles and tenancy.
 */
export function WhatsAppAccounts({
  isAdmin,
  signup,
  onNotice,
}: {
  isAdmin: boolean;
  signup: EmbeddedSignup;
  onNotice: (notice: Notice | null) => void;
}) {
  const { data: accounts } = useAnalyticsQuery(api.v1.whatsapp.listAccounts, {});
  const { data: connections } = useAnalyticsQuery(api.v1.connections.list, {});
  if (accounts === undefined) {
    return (
      <Skeleton className="h-24 w-full" role="status" aria-label="Loading WhatsApp accounts" />
    );
  }
  if (accounts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No WhatsApp account is connected yet.
        {isAdmin ? " Use Connect WhatsApp to add your WhatsApp Business number." : ""}
      </p>
    );
  }
  const names = new Map(
    (connections ?? [])
      .filter((c) => c.provider === "whatsapp" && c.displayName !== undefined)
      .map((c) => [c.id, c.displayName!]),
  );
  return (
    <ul className="flex flex-col gap-3">
      {accounts.map((account) => (
        <AccountCard
          key={account.id}
          account={account}
          name={names.get(account.connectionId) ?? "WhatsApp Business account"}
          isAdmin={isAdmin}
          signup={signup}
          onNotice={onNotice}
        />
      ))}
    </ul>
  );
}
