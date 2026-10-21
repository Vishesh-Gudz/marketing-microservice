import { filterParamsOnly, parseFilters, serializeFilters } from "@/lib/analytics/filters";
import type { Connection } from "@/lib/analytics/types";

/**
 * Where the Connections page sends the browser. The OAuth return URL is this page with the
 * global filters only (the server accepts it only if its origin and path are allowlisted for
 * the app); the authorization URL is followed in the same tab and never rendered, logged or
 * stored (it carries the single-use state and the PKCE challenge).
 */

type Params = { toString(): string };

/** `<origin>/connections`, carrying only the global dashboard filters. */
export function connectReturnUrl(origin: string, current: Params): string {
  const filters = filterParamsOnly(new URLSearchParams(current.toString())).toString();
  return `${origin}/connections${filters ? `?${filters}` : ""}`;
}

/** The Overview filtered to one ad account (the `accounts` filter); the period is kept. */
export function accountAnalyticsHref(accountId: string, current: Params): string {
  const filters = parseFilters(new URLSearchParams(current.toString()));
  return `/?${serializeFilters({ ...filters, platforms: [], accounts: [accountId] }).toString()}`;
}

/**
 * Leaves for the platform's consent page in the same tab (Google's consent page must be a
 * top-level page). Only http(s) URLs are followed.
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

/** Google Ads connections that can still be used (revoked ones are history), newest first. */
export function googleAdsConnections(connections: readonly Connection[]): Connection[] {
  return connections
    .filter((c) => c.provider === "google_ads" && c.status !== "revoked")
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
