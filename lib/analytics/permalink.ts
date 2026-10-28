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

/**
 * The same defensive check for a YouTube video link (ADR 0016): the API stores only
 * `https://www.youtube.com/watch?v=<11-character id>`, and only exactly that becomes a link.
 */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function safeYouTubeWatchUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0 || raw.length > 2_048) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  if (url.host !== "www.youtube.com" || url.pathname !== "/watch" || url.hash !== "") {
    return undefined;
  }
  const ids = url.searchParams.getAll("v");
  if ([...url.searchParams.keys()].length !== 1 || ids.length !== 1) return undefined;
  return VIDEO_ID.test(ids[0]!) ? url.href : undefined;
}
