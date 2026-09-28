/**
 * Google Ads credential (G-D5), stored ONLY inside the encrypted credential blob
 * (connections/credentialStore.ts). It holds the OAuth REFRESH token; access tokens are
 * minted per provider call and kept in memory only (G-D5a). No expiry: Google refresh
 * tokens have none (revocation surfaces as invalid_grant → needs_reauth).
 */
export type GoogleCredential = {
  kind: "google";
  v: 1;
  refreshToken: string;
  /** The OAuth client the token was issued to (checked against GOOGLE_CLIENT_ID per call). */
  clientId: string;
  /** Epoch ms. */
  issuedAt: number;
  /** Scopes Google reported as granted. */
  scopes: string[];
};

export function isGoogleCredential(value: unknown): value is GoogleCredential {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.kind === "google" &&
    c.v === 1 &&
    typeof c.refreshToken === "string" &&
    c.refreshToken.length > 0 &&
    typeof c.clientId === "string" &&
    typeof c.issuedAt === "number" &&
    Array.isArray(c.scopes) &&
    c.scopes.every((s) => typeof s === "string")
  );
}
