"use client";

import { useAuth } from "@clerk/nextjs";
import { useMemo } from "react";
import { CLERK_TOKEN_TEMPLATE } from "./mode";

type FetchAccessToken = (args: { forceRefreshToken: boolean }) => Promise<string | null>;

/**
 * Clerk → Convex: the `useAuth` hook for ConvexProviderWithAuth.
 *
 * - Always requests the "convex" JWT template, whose claims carry `org_id`, `org_role` and
 *   `org_name`. (Convex's ConvexProviderWithClerk would send the plain session token instead
 *   once Clerk's session token has `aud: "convex"`, and that token lacks those claims.)
 * - Authenticated only with an active organization (D5): without one no token is sent and
 *   the backend never sees an org-less identity.
 * - A new fetchAccessToken per (session, organization, role) makes Convex fetch a fresh token
 *   for it, so switching organizations switches the tenant on the next request.
 */
export function useClerkConvexAuth() {
  const { isLoaded, isSignedIn, getToken, orgId, orgRole, sessionId } = useAuth();

  const fetchAccessToken = useMemo<FetchAccessToken>(() => {
    const scope = { sessionId, orgId, orgRole };
    return async ({ forceRefreshToken }) => {
      if (!scope.sessionId || !scope.orgId) return null;
      try {
        return await getToken({ template: CLERK_TOKEN_TEMPLATE, skipCache: forceRefreshToken });
      } catch {
        return null;
      }
    };
  }, [getToken, sessionId, orgId, orgRole]);

  const isAuthenticated = isSignedIn === true && typeof orgId === "string" && orgId !== "";

  return useMemo(
    () => ({ isLoading: !isLoaded, isAuthenticated, fetchAccessToken }),
    [isLoaded, isAuthenticated, fetchAccessToken],
  );
}
