"use client";

import { useAuth } from "@clerk/nextjs";
import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * What the dashboard UI needs to know about the identity layer (never used for authorization:
 * the backend verifies every token).
 *
 * - mode "dev":          local dev token (scripts/dev-auth.mjs), no Clerk.
 * - mode "clerk":        Clerk sign-in; `activeOrgId` is Clerk's active organization and
 *                        `needsOrganization` is true for a signed-in user without one (D5).
 * - mode "unconfigured": a Clerk build without a valid publishable key; always signed out.
 */
export type AuthUi = {
  mode: "dev" | "clerk" | "unconfigured";
  activeOrgId: string | null;
  needsOrganization: boolean;
};

const UNCONFIGURED: AuthUi = { mode: "unconfigured", activeOrgId: null, needsOrganization: false };
const DEV: AuthUi = { mode: "dev", activeOrgId: null, needsOrganization: false };

const AuthUiContext = createContext<AuthUi>(UNCONFIGURED);

export function useAuthUi(): AuthUi {
  return useContext(AuthUiContext);
}

export function AuthUiProvider({ value, children }: { value: AuthUi; children: ReactNode }) {
  return <AuthUiContext.Provider value={value}>{children}</AuthUiContext.Provider>;
}

export function DevAuthUiProvider({ children }: { children: ReactNode }) {
  return <AuthUiProvider value={DEV}>{children}</AuthUiProvider>;
}

export function UnconfiguredAuthUiProvider({ children }: { children: ReactNode }) {
  return <AuthUiProvider value={UNCONFIGURED}>{children}</AuthUiProvider>;
}

/** Must render inside ClerkProvider. */
export function ClerkAuthUiProvider({ children }: { children: ReactNode }) {
  const { isLoaded, userId, orgId } = useAuth({ treatPendingAsSignedOut: false });
  const activeOrgId = typeof orgId === "string" && orgId !== "" ? orgId : null;
  const value = useMemo<AuthUi>(
    () => ({
      mode: "clerk",
      activeOrgId,
      needsOrganization: isLoaded === true && typeof userId === "string" && activeOrgId === null,
    }),
    [isLoaded, userId, activeOrgId],
  );
  return <AuthUiContext.Provider value={value}>{children}</AuthUiContext.Provider>;
}
