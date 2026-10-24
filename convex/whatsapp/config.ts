import { apiError } from "../lib/errors";
import { isLocalDeployment } from "../providers/mode";

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
  /** Not a secret: "true" (exactly) opens new WhatsApp connections on a cloud deployment. */
  connectionsEnabled: "WHATSAPP_CONNECTIONS_ENABLED",
  /** Not secrets: the WhatsApp Meta app and its Facebook Login for Business configuration. */
  appId: "WHATSAPP_APP_ID",
  signupConfigId: "WHATSAPP_ES_CONFIG_ID",
} as const;

/**
 * Graph API version for Embedded Signup and onboarding calls (Meta's current version, v26.0).
 * Pinned separately from the Meta Ads version so the two integrations never move together.
 */
export const WHATSAPP_GRAPH_API_VERSION = "v26.0";
/** Selected by the login configuration (no `extras.version`); v5 is not adopted (ADR 0014). */
export const EMBEDDED_SIGNUP_VERSION = "v4";
/** Per-request timeout for onboarding calls (the 30-second code is exchanged first). */
export const SIGNUP_TIMEOUT_MS = 15_000;
/** Permissions the business token must carry (Meta: both need Advanced Access). */
export const WHATSAPP_SCOPES = [
  "whatsapp_business_management",
  "whatsapp_business_messaging",
] as const;
/** Our own cap on registration calls per number (Meta allows 10 per 72 hours, error 133016). */
export const MAX_REGISTRATION_ATTEMPTS = 5;
/** Meta's error for a number past its register / deregister limit (Meta docs, registration). */
export const REGISTRATION_RATE_LIMIT_CODE = 133016;
/** After that error, no registration call for the number for Meta's whole 72-hour window. */
export const REGISTRATION_COOLDOWN_MS = 72 * 60 * 60 * 1000;
/**
 * Graph errors that mean the business token is no longer usable: the same classification the
 * Meta Ads provider uses (convex/providers/meta/errors.ts: codes 102 and 190, or HTTP 401).
 * On one, the connection moves to needs_reauth; nothing retries with that token.
 */
export const TOKEN_AUTH_ERROR_CODES: ReadonlySet<number> = new Set([102, 190]);

/**
 * Disconnect cleanup (ADR 0014 B4, convex/whatsapp/offboarding.ts). The first attempt runs at
 * once; after a failure the next one waits OFFBOARDING_RETRY_DELAYS_MS[attempts - 1]. After the
 * last delay's attempt the cleanup gives up (about 8.6 hours in all), and the credential is
 * deleted whatever happened.
 */
export const OFFBOARDING_RETRY_DELAYS_MS: readonly number[] = [
  60 * 1000,
  5 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
];
/** The first attempt plus one per retry delay. */
export const MAX_OFFBOARDING_ATTEMPTS = OFFBOARDING_RETRY_DELAYS_MS.length + 1;
/** An attempt holds the cleanup this long: twice the Meta call's own timeout. */
export const OFFBOARDING_CLAIM_MS = 2 * SIGNUP_TIMEOUT_MS;
/**
 * The generic connection sweep leaves a revoked WhatsApp connection's credential alone this
 * long, so the cleanup can still unsubscribe with it (longer than every retry together); then
 * it deletes any credential still there, as for every provider.
 */
export const WHATSAPP_REVOKED_CREDENTIAL_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Partner removal (ADR 0014 B4b, convex/whatsapp/partnerRemoval.ts): Graph errors read as "this
 * token can no longer reach the WABA" when the webhook confirms a PARTNER_REMOVED: permission
 * (10, 200), unknown alias (803), and 100 with subcode 33 (the object cannot be loaded due to
 * missing permissions). ASSUMED: generic Graph codes, since Meta does not document what reading
 * the WABA answers after a partner removal; to verify with a real removal.
 */
export const WABA_ACCESS_REFUSED_CODES: ReadonlySet<number> = new Set([10, 200, 803]);
export const WABA_NOT_ACCESSIBLE = { code: 100, subcode: 33 } as const;
/** WABAs checked with Meta per delivery; more are answered 500 and checked on Meta's retry. */
export const MAX_PARTNER_REMOVAL_CHECKS = 10;

const META_NUMERIC_ID = /^\d{1,32}$/;

export type SignupAppConfig = { appId: string; appSecret: string; configId: string };

/** The Meta app used for Embedded Signup, or null when any value is missing or malformed. */
export function signupAppConfig(
  env: { appId?: string; appSecret?: string; configId?: string } = {
    appId: process.env[WHATSAPP_ENV.appId],
    appSecret: process.env[WHATSAPP_ENV.appSecret],
    configId: process.env[WHATSAPP_ENV.signupConfigId],
  },
): SignupAppConfig | null {
  const appSecret = configuredSecret(env.appSecret);
  if (env.appId === undefined || !META_NUMERIC_ID.test(env.appId)) return null;
  if (env.configId === undefined || !META_NUMERIC_ID.test(env.configId)) return null;
  if (appSecret === null) return null;
  return { appId: env.appId, appSecret, configId: env.configId };
}

/**
 * ADR 0014 (D9): new WhatsApp connections stay closed on cloud deployments until an operator
 * sets WHATSAPP_CONNECTIONS_ENABLED=true (exactly), independently of OAUTH_CONNECTIONS_ENABLED.
 * Local deployments and in-process tests (loopback or absent CONVEX_CLOUD_URL) are open.
 * Existing connections and the webhook are unaffected.
 */
export function whatsappConnectionsEnabled(
  env: { enabled?: string; cloudUrl?: string } = {
    enabled: process.env[WHATSAPP_ENV.connectionsEnabled],
    cloudUrl: process.env.CONVEX_CLOUD_URL,
  },
): boolean {
  return isLocalDeployment(env.cloudUrl) || env.enabled === "true";
}

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
 * Refuses (INVALID_ARGUMENT) an operator-supplied `actorSubject` that is not `operator:<name>`.
 * This only standardizes the label: it does not authenticate who typed it.
 */
export function requireOperatorSubject(actorSubject: string): void {
  if (!OPERATOR_SUBJECT.test(actorSubject)) {
    throw apiError("INVALID_ARGUMENT", "actorSubject must be operator:<name>.", {
      field: "actorSubject",
    });
  }
}

/** Operator and system-job audit namespaces; a signed-in user's subject is never one of them. */
const NON_USER_SUBJECT = /^(operator|system):/;

/**
 * Refuses (INVALID_ARGUMENT) an `actorSubject` that is not a signed-in user's subject: the
 * Embedded Signup path (ADR 0014) passes on the verified JWT subject of the org admin, so an
 * operator or system label here would mean a caller is impersonating that path.
 */
export function requireUserSubject(actorSubject: string): void {
  if (
    actorSubject.trim() === "" ||
    actorSubject.length > 256 ||
    NON_USER_SUBJECT.test(actorSubject)
  ) {
    throw apiError("INVALID_ARGUMENT", "actorSubject must be a signed-in user's subject.", {
      field: "actorSubject",
    });
  }
}

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
