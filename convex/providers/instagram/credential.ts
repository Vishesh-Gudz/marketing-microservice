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

const NUMERIC_ID = /^\d{1,32}$/;

export function isInstagramCredential(value: unknown): value is InstagramCredential {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.kind === "instagram" &&
    c.v === 1 &&
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
