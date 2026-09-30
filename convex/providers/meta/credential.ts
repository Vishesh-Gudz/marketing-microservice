/**
 * Meta credential (D5), stored ONLY inside the encrypted credential blob
 * (connections/credentialStore.ts). A Facebook Login for Business long-lived
 * USER access token (~60 days, no refresh; D4). System-user tokens are out of
 * Phase 8 scope. appsecret_proof is derived per request and never stored.
 */
export type MetaCredential = {
  kind: "meta";
  v: 1;
  accessToken: string;
  tokenType: "user";
  /** The Meta app the token was issued to (checked against META_APP_ID per call). */
  appId: string;
  /** Epoch ms. */
  issuedAt: number;
  /** Epoch ms; absent = no expiry reported. */
  expiresAt?: number;
  /** Epoch ms; absent = none reported. */
  dataAccessExpiresAt?: number;
  /**
   * Ad account ids from debug_token granular_scopes for ads_read, when Meta reports
   * them. Captured only; discovery does not filter by them (R1, real-account validation).
   */
  grantedAdAccountIds?: string[];
};

export function isMetaCredential(value: unknown): value is MetaCredential {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.kind === "meta" &&
    c.v === 1 &&
    typeof c.accessToken === "string" &&
    c.accessToken.length > 0 &&
    c.tokenType === "user" &&
    typeof c.appId === "string" &&
    typeof c.issuedAt === "number" &&
    (c.expiresAt === undefined || typeof c.expiresAt === "number") &&
    (c.dataAccessExpiresAt === undefined || typeof c.dataAccessExpiresAt === "number") &&
    (c.grantedAdAccountIds === undefined ||
      (Array.isArray(c.grantedAdAccountIds) &&
        c.grantedAdAccountIds.every((id) => typeof id === "string")))
  );
}
