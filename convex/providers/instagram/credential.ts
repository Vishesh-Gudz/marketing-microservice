/**
 * Instagram credential (Phase 10), stored ONLY inside the encrypted credential blob
 * (convex/connections/credentialStore.ts). A long-lived Instagram User access token from
 * Instagram Login (~60 days, refreshable once at least 24 h old). Plaintext exists only in
 * action memory. Authorization codes and short-lived tokens are never stored.
 */
export type InstagramCredential = {
  kind: "instagram";
  v: 1;
  accessToken: string;
  tokenType: "long_lived";
  /** The Instagram app the token was issued to (checked against INSTAGRAM_APP_ID per call). */
  appId: string;
  /** Instagram professional account id (`/me.user_id`) the token belongs to. */
  userId: string;
  /** Epoch ms when this token was obtained (refresh eligibility: at least 24 h old). */
  issuedAt: number;
  /** Epoch ms; absent = the platform reported no expiry. */
  expiresAt?: number;
};

/**
 * Instagram API with Unified Login (config.ts): a Business Integration System User access
 * token from the Facebook Login for Business configuration. It belongs to the client's
 * business portfolio, does not expire with the configuration we use, and is never refreshed;
 * it stops working when the client removes the app [doc]. Only the messaging paths and
 * discovery accept it: organic sync and token refresh accept Instagram Login tokens only.
 */
export type InstagramUnifiedCredential = {
  kind: "instagram";
  v: 1;
  setup: "unified";
  accessToken: string;
  tokenType: "system_user";
  /** The Meta app the token was issued to (checked against INSTAGRAM_APP_ID per call). */
  appId: string;
  /** The Instagram professional account id (`/me/assigned_instagram_accounts`). */
  userId: string;
  /** Epoch ms when this token was obtained. */
  issuedAt: number;
};

const NUMERIC_ID = /^\d{1,32}$/;

function hasTokenFields(c: Record<string, unknown>): boolean {
  return (
    typeof c.accessToken === "string" &&
    c.accessToken.length > 0 &&
    c.accessToken.length <= 4_096 &&
    typeof c.appId === "string" &&
    NUMERIC_ID.test(c.appId) &&
    typeof c.userId === "string" &&
    NUMERIC_ID.test(c.userId) &&
    typeof c.issuedAt === "number" &&
    Number.isFinite(c.issuedAt)
  );
}

export function isInstagramUnifiedCredential(value: unknown): value is InstagramUnifiedCredential {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.kind === "instagram" &&
    c.v === 1 &&
    c.setup === "unified" &&
    c.tokenType === "system_user" &&
    hasTokenFields(c)
  );
}

/** A credential the direct-message paths can use: either setup. */
export function isInstagramMessagingCredential(
  value: unknown,
): value is InstagramCredential | InstagramUnifiedCredential {
  return isInstagramCredential(value) || isInstagramUnifiedCredential(value);
}

/** An Instagram Login credential (never a Unified Login one). */
export function isInstagramCredential(value: unknown): value is InstagramCredential {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.kind === "instagram" &&
    c.v === 1 &&
    c.setup === undefined &&
    typeof c.accessToken === "string" &&
    c.accessToken.length > 0 &&
    c.accessToken.length <= 4_096 &&
    c.tokenType === "long_lived" &&
    typeof c.appId === "string" &&
    NUMERIC_ID.test(c.appId) &&
    typeof c.userId === "string" &&
    NUMERIC_ID.test(c.userId) &&
    typeof c.issuedAt === "number" &&
    Number.isFinite(c.issuedAt) &&
    (c.expiresAt === undefined || (typeof c.expiresAt === "number" && Number.isFinite(c.expiresAt)))
  );
}
