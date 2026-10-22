"use client";

import { useAction } from "convex/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import {
  claimErrorNotice,
  CONNECT_PROVIDER_PARAM,
  connectResultNotice,
  parseConnectResult,
  withoutConnectResult,
  type ConnectResult,
} from "@/lib/connections/connect-result";
import type { Notice } from "@/lib/connections/types";
import { AD_CONNECTION_PROVIDERS, PROVIDERS } from "@/lib/connections/providers";
import { AdConnection } from "../connections/ad-connection";
import { ConnectionNotice } from "../connections/connection-notice";
import { PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";

/**
 * The OAuth callback's result, read once on arrival (lib/connections/connect-result); the
 * result parameters (including a claim code), the provider hint and any stray code / state
 * are then removed from the URL, keeping the dashboard filters, so a reload or a shared link
 * never replays the notice or the claim.
 */
function useConnectResult() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [result] = useState(() => parseConnectResult(searchParams));
  const leftover =
    parseConnectResult(searchParams).kind !== "none" ||
    searchParams.has(CONNECT_PROVIDER_PARAM) ||
    searchParams.has("code") ||
    searchParams.has("state");
  const cleaned = useRef(false);
  useEffect(() => {
    if (!leftover || cleaned.current) return;
    cleaned.current = true;
    const rest = withoutConnectResult(searchParams).toString();
    router.replace(rest ? `${pathname}?${rest}` : pathname, { scroll: false });
  }, [leftover, searchParams, router, pathname]);
  return result;
}

type Outcome = { result: ConnectResult; notice: Notice | null };

/**
 * S2: a `pending` result carries a one-time claim code. It is claimed exactly once, as the
 * signed-in user of the current org (this view renders only behind the org gate); the server
 * accepts it only from the user and org that started the connection. Until it answers, the
 * notice says the connection is being finished.
 */
function useClaimedResult(result: ConnectResult): Outcome {
  const completeConnect = useAction(api.v1.connections.completeConnect);
  const [claimed, setClaimed] = useState<Outcome | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (result.kind !== "pending" || started.current) return;
    started.current = true;
    const hint = result.provider !== undefined ? { provider: result.provider } : {};
    completeConnect({ claim: result.claim }).then(
      ({ connectionId, discoveryFailed }) => {
        const connected: ConnectResult = {
          kind: "connected",
          connectionId,
          discoveryFailed,
          ...hint,
        };
        setClaimed({ result: connected, notice: connectResultNotice(connected) });
      },
      (error: unknown) =>
        setClaimed({ result: { kind: "none" }, notice: claimErrorNotice(error, result.provider) }),
    );
  }, [result, completeConnect]);
  return claimed ?? { result, notice: connectResultNotice(result) };
}

/**
 * Connections for the ad platforms (Google Ads and Meta Ads; Instagram organic stays out):
 * connect an account, choose the ad account to sync and follow its status. Every step goes
 * through the public v1 API; the server enforces roles, tenancy and which accounts may be
 * linked.
 */
export function ConnectionsView() {
  const { result, notice } = useClaimedResult(useConnectResult());
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Connections"
        description="Connect Google Ads or Meta Ads and choose the ad account to sync."
      />
      {notice && <ConnectionNotice notice={notice} />}
      {AD_CONNECTION_PROVIDERS.map((provider) => {
        const { name } = PROVIDERS[provider];
        const headingId = `connections-${provider}`;
        return (
          <section key={provider} aria-labelledby={headingId} className="flex flex-col gap-4">
            <h2 id={headingId} className="text-lg font-semibold">
              {name}
            </h2>
            <QueryBoundary resetKey={provider} title={name}>
              <AdConnection
                provider={provider}
                preferredConnectionId={
                  result.kind === "connected" ? result.connectionId : undefined
                }
              />
            </QueryBoundary>
          </section>
        );
      })}
    </div>
  );
}
