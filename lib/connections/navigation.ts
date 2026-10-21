import { filterParamsOnly, parseFilters, serializeFilters } from "@/lib/analytics/filters";
import type { Connection } from "@/lib/analytics/types";
import { CONNECT_PROVIDER_PARAM } from "./connect-result";
import type { AdConnectionProvider } from "./providers";

/**
 * Where the Connections page sends the browser. The OAuth return URL is this page with the
 * global filters and a display-only provider hint (the server accepts it only if its origin
 * and path are allowlisted for the app); the authorization URL is followed in the same tab
 * and never rendered, logged or stored (it carries the single-use state and, for Google, the
 * PKCE challenge).
 */

type Params = { toString(): string };

/**
 * `<origin>/connections` with the global dashboard filters and `connect=<provider>`. The hint
 * only picks the wording of the result notice (the callback's result names no provider);
 * it is never trusted for anything else and is removed with the result parameters.
 */
export function connectReturnUrl(
  origin: string,
  current: Params,
  provider: AdConnectionProvider,
): string {
  const params = filterParamsOnly(new URLSearchParams(current.toString()));
  params.set(CONNECT_PROVIDER_PARAM, provider);
  return `${origin}/connections?${params.toString()}`;
}

/** The Overview filtered to one ad account (the `accounts` filter); the period is kept. */
export function accountAnalyticsHref(accountId: string, current: Params): string {
  const filters = parseFilters(new URLSearchParams(current.toString()));
  return `/?${serializeFilters({ ...filters, platforms: [], accounts: [accountId] }).toString()}`;
}

/**
 * Leaves for the platform's consent page in the same tab (consent pages must be top-level
 * pages). Only http(s) URLs are followed.
 */
export function navigateToAuthorization(
  authorizeUrl: string,
  assign: (url: string) => void = (url) => window.location.assign(url),
): void {
  const url = new URL(authorizeUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Unexpected authorization URL.");
  }
  assign(url.toString());
}

/** The provider's connections that can still be used (revoked ones are history), newest first. */
export function adConnections(
  connections: readonly Connection[],
  provider: AdConnectionProvider,
): Connection[] {
  return connections
    .filter((c) => c.provider === provider && c.status !== "revoked")
    .sort((a, b) => (a.connectedAt < b.connectedAt ? 1 : a.connectedAt > b.connectedAt ? -1 : 0));
}

/** The connection to show: the preferred one if present, else the newest active, else the newest. */
export function pickConnection(
  candidates: readonly Connection[],
  preferredId: string | undefined,
): Connection | undefined {
  return (
    candidates.find((c) => c.id === preferredId) ??
    candidates.find((c) => c.status === "active") ??
    candidates[0]
  );
}
