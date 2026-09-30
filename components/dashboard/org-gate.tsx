"use client";

import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { isMarketingError } from "@/convex/lib/errors";
import { describeError } from "@/lib/analytics/errors";
import type { Org } from "@/lib/analytics/types";
import { EmptyState } from "./empty-state";

export type OrgGateState =
  | { status: "checking" }
  | { status: "signed_out" }
  | { status: "error"; code: string; message: string }
  | { status: "resolving" }
  | { status: "ready"; org: Org };

type EnsureState =
  { status: "pending" } | { status: "ready" } | { status: "error"; error: unknown };

/**
 * Resolves the caller's organization (D16): waits for the parent-issued token,
 * provisions the org once per session (v1/orgs:ensure, idempotent) and then
 * subscribes to v1/orgs:me. The tenant is always derived from the token.
 */
export function useOrgGate(): OrgGateState {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const ensure = useMutation(api.v1.orgs.ensure);
  const [ensured, setEnsured] = useState<EnsureState>({ status: "pending" });

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    ensure({})
      .then(() => !cancelled && setEnsured({ status: "ready" }))
      .catch((error: unknown) => !cancelled && setEnsured({ status: "error", error }));
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, ensure]);

  const org = useQuery(api.v1.orgs.me, ensured.status === "ready" ? {} : "skip");

  if (isLoading) return { status: "checking" };
  if (!isAuthenticated) return { status: "signed_out" };
  if (ensured.status === "error") {
    const described = describeError(ensured.error);
    return {
      status: "error",
      code: isMarketingError(ensured.error) ? ensured.error.data.code : "AUTH_FAILED",
      message: described.message,
    };
  }
  if (org === undefined) return { status: "resolving" };
  return { status: "ready", org };
}

/** Header badge: organization and role. */
export function OrgBadge({ state }: { state: OrgGateState }) {
  switch (state.status) {
    case "ready":
      return (
        <span className="flex items-center gap-2" data-testid="org-badge">
          <span className="max-w-40 truncate text-sm font-medium">{state.org.displayName}</span>
          <Badge variant="secondary">{state.org.role}</Badge>
          <Badge variant="outline" title="Reporting currency">
            {state.org.reportingCurrency}
          </Badge>
        </span>
      );
    case "signed_out":
      return <Badge variant="outline">Signed out</Badge>;
    case "error":
      return <Badge variant="destructive">{state.code}</Badge>;
    default:
      return <Skeleton className="h-5 w-28" aria-label="Loading organization" />;
  }
}

/** Main-area message while the gate is not ready. */
export function OrgGateMessage({ state }: { state: Exclude<OrgGateState, { status: "ready" }> }) {
  switch (state.status) {
    case "signed_out":
      return (
        <EmptyState title="Not signed in" className="mt-8">
          Open this dashboard from your application. In local development, run{" "}
          <code>npm run dev:auth setup</code> (see docs/setup.md).
        </EmptyState>
      );
    case "error":
      return (
        <EmptyState title="Your organization could not be loaded" className="mt-8">
          {state.message} ({state.code})
        </EmptyState>
      );
    default:
      return (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading organization">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-24 w-full" />
        </div>
      );
  }
}
