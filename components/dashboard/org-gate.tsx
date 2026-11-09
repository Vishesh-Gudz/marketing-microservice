"use client";

import { useConvexAuth, useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { GudzLoader } from "@/components/brand/gudz-loader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { isMarketingError } from "@/convex/lib/errors";
import { describeError } from "@/lib/analytics/errors";
import { useAuthUi } from "@/lib/auth/auth-ui";
import { CHOOSE_ORGANIZATION_PATH, SIGN_IN_PATH } from "@/lib/auth/mode";
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

/** How long to wait for Convex to re-authenticate after an organization switch. */
export const ORG_SWITCH_RETRY_MS = 300;
export const ORG_SWITCH_MAX_ATTEMPTS = 20;

/**
 * Resolves the caller's organization (D16): waits for the token, provisions the org
 * (v1/orgs:ensure, idempotent) and then subscribes to v1/orgs:me. The tenant is always derived
 * from the token.
 *
 * With Clerk, `ensure` runs again for every active organization, and the result counts only
 * when it is that organization: right after a switch the Convex client may still hold the
 * previous organization's token, so a mismatch waits briefly and retries instead of showing
 * (or provisioning) the wrong one.
 */
export function useOrgGate(): OrgGateState {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { mode, activeOrgId } = useAuthUi();
  const expectedOrgId = mode === "clerk" ? activeOrgId : null;
  const scope = expectedOrgId ?? "*";
  const ensure = useMutation(api.v1.orgs.ensure);
  const [ensured, setEnsured] = useState<{ scope: string; state: EnsureState }>({
    scope,
    state: { status: "pending" },
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    ensure({})
      .then((org) => {
        if (cancelled) return;
        if (expectedOrgId === null || org.externalOrgId === expectedOrgId) {
          setEnsured({ scope, state: { status: "ready" } });
        } else if (attempt + 1 >= ORG_SWITCH_MAX_ATTEMPTS) {
          setEnsured({
            scope,
            state: {
              status: "error",
              error: new Error("The organization switch did not complete."),
            },
          });
        } else {
          retry = setTimeout(() => setAttempt((n) => n + 1), ORG_SWITCH_RETRY_MS);
        }
      })
      .catch(
        (error: unknown) => !cancelled && setEnsured({ scope, state: { status: "error", error } }),
      );
    return () => {
      cancelled = true;
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [isAuthenticated, ensure, expectedOrgId, scope, attempt]);

  const state: EnsureState = ensured.scope === scope ? ensured.state : { status: "pending" };
  const org = useQuery(api.v1.orgs.me, state.status === "ready" ? {} : "skip");

  if (isLoading) return { status: "checking" };
  if (!isAuthenticated) return { status: "signed_out" };
  if (state.status === "error") {
    const described = describeError(state.error);
    return {
      status: "error",
      code: isMarketingError(state.error) ? state.error.data.code : "AUTH_FAILED",
      message: described.message,
    };
  }
  if (org === undefined) return { status: "resolving" };
  // Never show another organization's data while the token catches up with a switch.
  if (expectedOrgId !== null && org.externalOrgId !== expectedOrgId) return { status: "resolving" };
  return { status: "ready", org };
}

// The role and currency tags give way first when the top bar is short of room: on phones,
// and next to the sidebar between 1024 and 1279 px.
const ORG_TAG = "hidden sm:inline-flex lg:hidden xl:inline-flex";

/** Top-bar badge: organization, role and reporting currency. */
export function OrgBadge({ state }: { state: OrgGateState }) {
  switch (state.status) {
    case "ready":
      return (
        <span className="flex min-w-0 items-center gap-2" data-testid="org-badge">
          <span className="max-w-28 truncate text-sm font-medium text-ink sm:max-w-40">
            {state.org.displayName}
          </span>
          <Badge variant="secondary" className={ORG_TAG}>
            {state.org.role}
          </Badge>
          <Badge variant="outline" className={ORG_TAG} asChild>
            <Link
              href="/organization#reporting"
              title="Reporting currency: change it on the Organization page"
              aria-label={`Reporting currency ${state.org.reportingCurrency}: change it on the Organization page`}
            >
              {state.org.reportingCurrency}
            </Link>
          </Badge>
        </span>
      );
    case "signed_out":
      return <Badge variant="outline">Signed out</Badge>;
    case "error":
      return <Badge variant="destructive">{state.code}</Badge>;
    default:
      // Decorative: the content area's loader is the one "Loading organization" status.
      return <Skeleton className="h-5 w-28" aria-hidden="true" />;
  }
}

function SignedOutMessage() {
  const { mode, needsOrganization } = useAuthUi();
  if (mode === "clerk" && needsOrganization) {
    return (
      <EmptyState title="Choose an organization" className="mt-8">
        Create an organization or accept an invitation to use the dashboard.{" "}
        <Link className="underline" href={CHOOSE_ORGANIZATION_PATH}>
          Choose an organization
        </Link>
      </EmptyState>
    );
  }
  if (mode === "clerk") {
    return (
      <EmptyState title="Not signed in" className="mt-8">
        <Link className="underline" href={SIGN_IN_PATH}>
          Sign in
        </Link>{" "}
        to see your organization&apos;s marketing data.
      </EmptyState>
    );
  }
  if (mode === "dev") {
    return (
      <EmptyState title="Not signed in" className="mt-8">
        The local dev token was not accepted. Run <code>npm run dev:auth setup</code> (see
        docs/setup.md).
      </EmptyState>
    );
  }
  return (
    <EmptyState title="Not signed in" className="mt-8">
      Sign-in is not configured for this deployment.
    </EmptyState>
  );
}

/** Main-area message while the gate is not ready. */
export function OrgGateMessage({ state }: { state: Exclude<OrgGateState, { status: "ready" }> }) {
  switch (state.status) {
    case "signed_out":
      return <SignedOutMessage />;
    case "error":
      return (
        <EmptyState title="Your organization could not be loaded" className="mt-8">
          {state.message} ({state.code})
        </EmptyState>
      );
    default:
      return <GateLoader />;
  }
}

/** After this long the loader says it is still connecting. */
export const GATE_SLOW_MS = 3_000;
/** After this long it offers to reload the page. */
export const GATE_STUCK_MS = 12_000;

/**
 * The Gudz loader while the organization resolves (first load and after an organization
 * switch; the sidebar and top bar stay). The gate keeps its own retries; this only explains a
 * slow start and, if it never finishes, offers a reload.
 */
function GateLoader() {
  const [stage, setStage] = useState<"start" | "slow" | "stuck">("start");
  useEffect(() => {
    const slow = setTimeout(() => setStage("slow"), GATE_SLOW_MS);
    const stuck = setTimeout(() => setStage("stuck"), GATE_STUCK_MS);
    return () => {
      clearTimeout(slow);
      clearTimeout(stuck);
    };
  }, []);
  return (
    <GudzLoader label="Loading organization">
      {/* Always rendered, so the text appearing does not move anything. */}
      <p className="min-h-5 text-sm text-muted-foreground">
        {stage === "slow" && "Connecting to your organization…"}
        {stage === "stuck" && "This is taking longer than usual."}
      </p>
      {stage === "stuck" && (
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          Reload the page
        </Button>
      )}
    </GudzLoader>
  );
}
