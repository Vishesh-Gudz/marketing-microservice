"use client";

import { useCallback, useMemo } from "react";
import type { TokenSource } from "./token-source";

/**
 * Adapts a TokenSource to the `useAuth` hook shape ConvexProviderWithAuth expects.
 * Convex calls `fetchAccessToken` on connect and whenever the token needs refreshing.
 */
export function useTokenAuth(source: TokenSource | null) {
  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) =>
      source ? await source.getToken({ forceRefreshToken }) : null,
    [source],
  );

  return useMemo(
    () => ({ isLoading: false, isAuthenticated: source !== null, fetchAccessToken }),
    [source, fetchAccessToken],
  );
}
