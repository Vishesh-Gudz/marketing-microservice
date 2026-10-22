import { MAX_FUTURE_SKEW_MS, SERVICE_WINDOW_MS } from "./config";

/**
 * Customer-service window (pure). Each inbound customer message opens a 24-hour window in which
 * the business may send free-form messages; outside it, only approved templates may be sent.
 * Enforced server-side at send time (Stage 5); read APIs expose only the expiry instant, so a
 * cached query result can never claim a window is still open.
 */

/** When the window opened by `lastInboundAt` closes, or undefined if no customer message yet. */
export function serviceWindowExpiresAt(lastInboundAt: number | undefined): number | undefined {
  return lastInboundAt === undefined ? undefined : lastInboundAt + SERVICE_WINDOW_MS;
}

export function isServiceWindowOpen(lastInboundAt: number | undefined, now: number): boolean {
  const expiresAt = serviceWindowExpiresAt(lastInboundAt);
  return expiresAt !== undefined && now < expiresAt;
}

/**
 * The instant an inbound message counts from: its platform timestamp, unless that lies further
 * in the future than the allowed skew, in which case the receipt time (a skewed or forged clock
 * must not extend the window).
 */
export function effectiveInboundAt(platformAt: number, receivedAt: number): number {
  return platformAt > receivedAt + MAX_FUTURE_SKEW_MS ? receivedAt : platformAt;
}
