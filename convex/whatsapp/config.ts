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

/**
 * Stuck-event recovery (convex/whatsapp/recovery.ts, cron every RECOVERY_INTERVAL_MINUTES): an
 * event still pending this long after receipt is retried on its own, so one failing event
 * cannot hold back the rest of its batch. A retry still queued or running is never duplicated.
 */
export const STUCK_EVENT_AFTER_MS = 5 * 60 * 1000;
export const RECOVERY_INTERVAL_MINUTES = 5;
/**
 * Finished retries (after the original attempt) before an event becomes `failed`. A retry
 * counts once its job is no longer queued, whatever its outcome or whether its record still
 * exists; retries that have not run yet are never counted.
 */
export const MAX_RECOVERY_ATTEMPTS = 3;
/**
 * A retry still queued this long after it was scheduled is canceled and its event marked
 * `failed`: no event waits on a job that never runs.
 */
export const RETRY_GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
/** Stuck events examined per sweep run (bounded; the next run continues). */
export const RECOVERY_BATCH_SIZE = 100;
/**
 * Audit subject for internal admin functions run by an operator (dashboard / CLI). Supplied by
 * the operator, not verified by this application, so it gets its own namespace.
 */
export const OPERATOR_SUBJECT = /^operator:[A-Za-z0-9._@-]{1,64}$/;

/**
 * Webhook events that are no longer pending (`processed`, `ignored`, `unmatched`, `failed`) are
 * deleted once at least this old, counted from receipt. Far longer than Meta's retry period
 * for a delivery (about 7 days, unverified), so a deleted dedupe key is not expected to be
 * needed again. It is also how long a `failed` event can be requeued. `pending` events are
 * never deleted by retention.
 */
export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Expired events examined per retention run (bounded; a full batch chains another run). */
export const RETENTION_BATCH_SIZE = 200;
/** Follow-up runs one scheduled retention run may chain; the next hourly run continues. */
export const MAX_RETENTION_CONTINUATIONS = 20;

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
