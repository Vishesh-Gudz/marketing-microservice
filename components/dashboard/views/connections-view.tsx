"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  CONNECT_PROVIDER_PARAM,
  connectResultNotice,
  parseConnectResult,
  withoutConnectResult,
} from "@/lib/connections/connect-result";
import { AD_CONNECTION_PROVIDERS, PROVIDERS } from "@/lib/connections/providers";
import { AdConnection } from "../connections/ad-connection";
import { ConnectionNotice } from "../connections/connection-notice";
import { PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";

/**
 * The OAuth callback's result, read once on arrival (lib/connections/connect-result); the
 * result parameters, the provider hint and any stray code / state are then removed from the
 * URL, keeping the dashboard filters, so a reload or a shared link never replays the notice.
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

/**
 * Connections for the ad platforms (Google Ads and Meta Ads; Instagram organic stays out):
 * connect an account, choose the ad account to sync and follow its status. Every step goes
 * through the public v1 API; the server enforces roles, tenancy and which accounts may be
 * linked.
 */
export function ConnectionsView() {
  const result = useConnectResult();
  const notice = connectResultNotice(result);
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
