/**
 * Defensive check (N7) before rendering an Instagram permalink as a link. The API already
 * stores only validated permalinks (https, instagram.com / www.instagram.com, no user info);
 * the dashboard re-checks so an unexpected value can never become a link (e.g. javascript:).
 */
const HOSTS: ReadonlySet<string> = new Set(["instagram.com", "www.instagram.com"]);

export function safeInstagramPermalink(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0 || raw.length > 2_048) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  return HOSTS.has(url.host) ? url.href : undefined;
}
