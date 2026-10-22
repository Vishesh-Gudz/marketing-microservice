/**
 * WhatsApp Cloud API inbox configuration (ADR 0013, docs/whatsapp.md).
 *
 * Every value that identifies the Meta app comes from Convex environment variables; nothing is
 * hard-coded. Missing or invalid configuration fails closed: the webhook refuses deliveries it
 * cannot authenticate, and verification requests it cannot match.
 */

/** Webhook callback path on the deployment's CONVEX_SITE_URL (GET verification, POST events). */
export const WHATSAPP_WEBHOOK_PATH = "/whatsapp/webhook";

/**
 * Convex env vars. The app secret signs every webhook delivery (X-Hub-Signature-256); the verify
 * token is the operator-chosen value entered in the Meta app's webhook settings. Both are
 * secrets: never logged, never returned.
 */
export const WHATSAPP_ENV = {
  appSecret: "WHATSAPP_APP_SECRET",
  verifyToken: "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
} as const;

/**
 * Upper bound on a delivery body. Meta documents webhook payloads of up to 3 MB; anything larger
 * is refused before signature verification work is wasted on it.
 */
export const MAX_WEBHOOK_BODY_BYTES = 3 * 1024 * 1024;

/** Upper bound on message + status events in one delivery (Meta batches up to 1000 updates). */
export const MAX_EVENTS_PER_DELIVERY = 1000;

/** Events handed to one processing mutation; larger deliveries are split into several jobs. */
export const PROCESS_BATCH_SIZE = 100;

/** Longest inbound text body stored (WhatsApp's own limit for a text message). */
export const MAX_TEXT_BODY_CHARS = 65_536;

/** Longest contact profile name stored. */
export const MAX_CONTACT_NAME_CHARS = 256;

/**
 * Platform timestamps later than receipt by more than this are clamped to the receipt time, so
 * a skewed clock can never stretch the 24-hour customer-service window into the future.
 */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** The 24-hour customer-service window opened by each inbound customer message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const MIN_SECRET_LENGTH = 8;
const MAX_SECRET_LENGTH = 512;

/** A configured secret: present, bounded, without whitespace. Anything else fails closed. */
export function configuredSecret(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value.length < MIN_SECRET_LENGTH || value.length > MAX_SECRET_LENGTH) return null;
  if (/\s/.test(value)) return null;
  return value;
}
