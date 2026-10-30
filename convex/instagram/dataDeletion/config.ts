/**
 * Meta's deauthorize and data-deletion callbacks for the Instagram Login app (ADR 0017, IM6).
 * Both URLs are set in App Dashboard > Instagram > API setup with Instagram business login >
 * Business login settings; the status URL is what the data-deletion callback answers with.
 */

export const INSTAGRAM_DEAUTHORIZE_PATH = "/instagram/deauthorize";
export const INSTAGRAM_DATA_DELETION_PATH = "/instagram/data-deletion";
export const INSTAGRAM_DATA_DELETION_STATUS_PATH = "/instagram/data-deletion/status";

/**
 * The ONLY secret that verifies a callback's `signed_request`: no default and no fallback.
 * Unset (or malformed), both callbacks answer 503 and change nothing. [assume] RI14: Meta's
 * docs say "your app secret"; for Instagram Login it is not documented whether that is the
 * Instagram app secret or the Meta app secret, so the operator sets the one that verifies.
 */
export const INSTAGRAM_CALLBACK_SECRET_ENV = "INSTAGRAM_CALLBACK_APP_SECRET";

/** A callback body is one form field of a few hundred bytes. */
export const MAX_CALLBACK_BODY_BYTES = 8 * 1024;

/**
 * Instagram connections of one user handled per callback, per lookup index. More is refused
 * with a 500 (Meta retries) instead of handling some and reporting the rest as done.
 */
export const MAX_CONNECTIONS_PER_USER = 50;

/**
 * IM7.0: a callback issued before an authorization was claimed does not apply to it
 * (`connections.authorizedAt`), with this much clock tolerance in favour of applying it.
 */
export const AUTHORIZATION_SKEW_MS = 5 * 60 * 1000;

/** Rows one deletion step may delete (Convex transaction limits). */
export const DELETION_STEP_DELETES = 400;

/** While waiting on a direct-message purge or the credential deletion: next check. */
export const ADVANCE_RETRY_MS = 30_000;
/** Checks in one chain (about an hour); the hourly sweep resumes a request after that. */
export const MAX_ADVANCE_RETRIES = 120;
/**
 * Every fan-out of a pending request moves its `nextAttemptAt` this far ahead, success or not,
 * so the hourly sweep (oldest `nextAttemptAt` first) never keeps picking the same failing ones.
 */
export const STALLED_AFTER_MS = 15 * 60 * 1000;
export const SWEEP_BATCH = 20;

/** Instagram connections read per verification step; requests completed per step. */
export const VERIFY_PAGE = 200;
export const COMPLETE_BATCH = 50;

/** Why an operator closed a review without full verification. */
export const CLOSE_REASONS = [
  "org_confirmed_unrelated",
  "connection_unrecoverable",
  "requester_unreachable",
] as const;
/** Why an operator erased an older (pre-IM6) Instagram connection. */
export const ERASE_REASONS = ["org_consented", "connection_abandoned"] as const;

/**
 * The disconnect deletes the credential in a scheduled action; if it still exists this long
 * after the request, the deletion step deletes it itself.
 */
export const CREDENTIAL_GRACE_MS = 15 * 60 * 1000;

/** An erased connection keeps its row (ids elsewhere point at it) but no Instagram identity. */
export const ERASED_IDENTITY_PREFIX = "erased:";

/** Confirmation codes: 20 characters, no look-alikes (0/O, 1/I). */
export const CONFIRMATION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CONFIRMATION_CODE_LENGTH = 20;
export const CONFIRMATION_CODE = /^[A-HJ-NP-Z2-9]{20}$/;
