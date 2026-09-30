/**
 * OAuth return-URL policy. A return URL is accepted only if it matches an
 * entry of the calling app's `integrationApps.allowedReturnUrls`:
 *   same origin (scheme + host + port) AND path equal to, or under, the entry's path.
 * No open redirects: anything unparseable, non-http(s), carrying credentials,
 * or on a look-alike host is rejected.
 */

function parse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Valid allowlist entry: https (or http on loopback for development), no credentials/query/fragment. */
export function isValidReturnUrlEntry(entry: string): boolean {
  const url = parse(entry);
  if (!url || url.username || url.password || url.search || url.hash) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
}

export function isAllowedReturnUrl(
  candidate: string,
  allowed: readonly string[] | undefined,
): boolean {
  if (!allowed?.length || candidate.length > 2048) return false;
  const url = parse(candidate);
  if (!url || url.username || url.password) return false;
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return allowed.some((entry) => {
    const base = parse(entry);
    if (!base || !isValidReturnUrlEntry(entry) || base.origin !== url.origin) return false;
    const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    return url.pathname === base.pathname || url.pathname.startsWith(prefix);
  });
}

/** Appends result parameters; never carries codes, tokens or messages. */
export function withResultParams(returnUrl: string, params: Record<string, string>): string {
  const url = new URL(returnUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
