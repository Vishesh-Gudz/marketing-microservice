"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  connectResultNotice,
  parseConnectResult,
  withoutConnectResult,
} from "@/lib/connections/connect-result";
import { ConnectionNotice } from "../connections/connection-notice";
import { GoogleAdsConnection } from "../connections/google-ads-connection";
import { PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";

/**
 * The OAuth callback's result, read once on arrival (lib/connections/connect-result); the
 * result parameters (and any stray code / state) are then removed from the URL, keeping the
 * dashboard filters, so a reload or a shared link never replays the notice.
 */
function useConnectResult() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [result] = useState(() => parseConnectResult(searchParams));
  const leftover =
    parseConnectResult(searchParams).kind !== "none" ||
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
 * Connections (Google Ads only): connect a Google account, choose the ad account to sync and
 * follow its status. Every step goes through the public v1 API; the server enforces roles,
 * tenancy and which accounts may be linked.
 */
export function ConnectionsView() {
  const result = useConnectResult();
  const notice = connectResultNotice(result);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Connections"
        description="Connect Google Ads and choose the ad account to sync."
      />
      {notice && <ConnectionNotice notice={notice} />}
      <section aria-labelledby="connections-google-ads" className="flex flex-col gap-4">
        <h2 id="connections-google-ads" className="text-lg font-semibold">
          Google Ads
        </h2>
        <QueryBoundary resetKey="google-ads" title="Google Ads">
          <GoogleAdsConnection
            preferredConnectionId={result.kind === "connected" ? result.connectionId : undefined}
          />
        </QueryBoundary>
      </section>
    </div>
  );
}
