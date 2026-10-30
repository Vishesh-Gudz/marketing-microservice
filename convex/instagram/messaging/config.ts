import { isLocalDeployment } from "../../providers/mode";

/** Instagram messaging configuration (ADR 0017). Pure: safe in the default runtime. */

export const INSTAGRAM_WEBHOOK_PATH = "/instagram/webhook";

/** Convex env var names. Values are never logged or returned. */
export const INSTAGRAM_MESSAGING_ENV = {
  /**
   * Gate (fail closed): on cloud deployments, asking for the messaging permission and turning
   * messaging on stay refused until this is exactly "true". Turning it off, disconnecting and
   * the webhook are unaffected.
   */
  enabled: "INSTAGRAM_MESSAGING_ENABLED",
  /**
   * The secret Meta signs Instagram webhook deliveries with (`X-Hub-Signature-256`). Meta's docs
   * say only "your app's App Secret"; whether that is the Meta app secret or the Instagram app
   * secret is UNVERIFIED, so this has no default and no fallback to either: set it only after a
   * Development-mode delivery has proved which one signs. Unset: every delivery is refused (503).
   */
  webhookAppSecret: "INSTAGRAM_WEBHOOK_APP_SECRET",
  /** The verify token entered in Meta's webhook settings (GET handshake). */
  webhookVerifyToken: "INSTAGRAM_WEBHOOK_VERIFY_TOKEN",
} as const;

/**
 * Whether new messaging consent and enabling are open. Local deployments and in-process tests
 * (loopback or absent CONVEX_CLOUD_URL) are open, as for WhatsApp connections.
 */
export function instagramMessagingEnabled(
  env: { enabled?: string; cloudUrl?: string } = {
    enabled: process.env[INSTAGRAM_MESSAGING_ENV.enabled],
    cloudUrl: process.env.CONVEX_CLOUD_URL,
  },
): boolean {
  return isLocalDeployment(env.cloudUrl) || env.enabled === "true";
}

/** Largest accepted delivery body (ours, as for WhatsApp). */
export const MAX_WEBHOOK_BODY_BYTES = 3 * 1024 * 1024;

/** [doc] Meta batches at most 1000 updates per delivery; more rejects the delivery. */
export const MAX_EVENTS_PER_DELIVERY = 1000;

/** Events processed per scheduled transaction. */
export const PROCESS_BATCH_SIZE = 100;

/** Longest inbound text stored (ours; Meta limits what a business sends to 1000 bytes). */
export const MAX_TEXT_CHARS = 65_536;

/**
 * Oldest plausible event time. [assume] Meta's `timestamp` is epoch milliseconds (its examples
 * show 13-digit values; no unit is documented). A value in seconds reads as 1970 and is refused.
 */
export const EARLIEST_EVENT_MS = Date.UTC(2020, 0, 1);

/** Earlier outbound messages one "seen" event may mark read (bounded work per event). */
export const MAX_READ_MARKS = 100;

// Stuck-event recovery and event retention: the same values as WhatsApp (convex/whatsapp/config.ts).
export const STUCK_EVENT_AFTER_MS = 5 * 60 * 1000;
export const RECOVERY_INTERVAL_MINUTES = 5;
export const MAX_RECOVERY_ATTEMPTS = 3;
export const RETRY_GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
export const RECOVERY_BATCH_SIZE = 100;
/** Far longer than Meta's 36-hour retry period [doc], so a retried delivery finds its dedupe key. */
export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const RETENTION_BATCH_SIZE = 200;
export const MAX_RETENTION_CONTINUATIONS = 20;

/**
 * D14 (ADR 0017, an engineering policy, not a legal conclusion): stored conversations and
 * messages are kept this long after messaging stops (turned off, disconnected, unlinked or the
 * permission removed), then purged. A verified data-deletion request purges at once.
 */
export const RETENTION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
/** Rows one purge step deletes before scheduling its continuation. */
export const PURGE_STEP_DELETES = 500;
/** Continuations one purge chain schedules; the hourly sweep resumes a longer one. */
export const MAX_PURGE_STEPS = 20;
/** Accounts whose grace period ended that one sweep starts or resumes. */
export const PURGE_ACCOUNTS_PER_SWEEP = 50;

/** The webhook subscription call (one request, inside an admin action). */
export const SUBSCRIBE_TIMEOUT_MS = 15_000;

/** [doc] "Message text must be UTF-8 and be a 1000 bytes or less." Counted in UTF-8 bytes. */
export const MAX_OUTBOUND_TEXT_BYTES = 1000;
/** The browser's id for one outbound message (as for WhatsApp): 8-64 letters, digits, - or _. */
export const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** The one send call (a scheduled action). */
export const SEND_TIMEOUT_MS = 15_000;
/** A send still pending this long after it was queued is settled by the watchdog. */
export const STUCK_SEND_AFTER_MS = 5 * 60 * 1000;
