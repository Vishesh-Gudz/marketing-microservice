/**
 * Which identity the dashboard uses, decided at build time (Standalone SaaS, D4):
 *
 * - "dev":   a development build with NEXT_PUBLIC_DEV_AUTH_TOKEN (scripts/dev-auth.mjs). Local
 *            development and the Playwright journeys; Clerk is not mounted at all.
 * - "clerk": every other build, including EVERY production build. Without a valid Clerk
 *            publishable key the dashboard stays signed out (fails closed, nothing mounted).
 */
export type AuthMode = "dev" | "clerk";

export function resolveAuthMode(
  nodeEnv: string | undefined,
  devToken: string | undefined,
): AuthMode {
  return nodeEnv !== "production" && devToken ? "dev" : "clerk";
}

/** A Clerk publishable key: `pk_test_…` (development instance) or `pk_live_…` (production). */
export function isClerkPublishableKey(value: string | undefined): value is string {
  return typeof value === "string" && /^pk_(test|live)_[A-Za-z0-9+/=_-]+$/.test(value);
}

/** The Clerk JWT template the dashboard requests for Convex (its `aud` is "convex", D3). */
export const CLERK_TOKEN_TEMPLATE = "convex";

export const SIGN_IN_PATH = "/sign-in";
export const SIGN_UP_PATH = "/sign-up";
/** Clerk session task: a signed-in user must create or join an organization first (D5). */
export const CHOOSE_ORGANIZATION_PATH = "/session-tasks/choose-organization";
export const ORGANIZATION_PATH = "/organization";

function under(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Pages anyone may open without a session (Clerk's own sign-in and sign-up flows). */
export function isPublicAuthPath(pathname: string): boolean {
  return under(pathname, SIGN_IN_PATH) || under(pathname, SIGN_UP_PATH);
}

/** Session-task pages a signed-in user without an organization may open. */
export function isSessionTaskPath(pathname: string): boolean {
  return under(pathname, "/session-tasks");
}
