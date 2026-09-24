"use client";

import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { isMarketingError } from "@/convex/lib/errors";
import { Badge } from "@/components/ui/badge";

type EnsureState = { status: "pending" } | { status: "ready" } | { status: "error"; code: string };

/**
 * Phase 1 verification only: provisions the caller's org (v1/orgs:ensure) and
 * shows who the verified token resolves to. Not a dashboard feature.
 */
export function OrgStatus() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const ensure = useMutation(api.v1.orgs.ensure);
  const [state, setState] = useState<EnsureState>({ status: "pending" });

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    ensure({})
      .then(() => !cancelled && setState({ status: "ready" }))
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          code: isMarketingError(error) ? error.data.code : "AUTH_FAILED",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, ensure]);

  const org = useQuery(api.v1.orgs.me, state.status === "ready" ? {} : "skip");

  if (isLoading) return <Badge variant="outline">Checking token…</Badge>;
  if (!isAuthenticated)
    return <Badge variant="outline">No token (run npm run dev:auth setup)</Badge>;
  if (state.status === "error") return <Badge variant="destructive">{state.code}</Badge>;
  if (org === undefined) return <Badge variant="outline">Resolving organization…</Badge>;

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge>{org.displayName}</Badge>
      <Badge variant="secondary">{org.role}</Badge>
      <span className="text-xs text-muted-foreground">
        {org.externalOrgId} @ {org.issuer}
      </span>
    </span>
  );
}
