import { isYouTubeChannelId } from "./config";

/**
 * YouTube credential (ADR 0016, Y-D5), stored ONLY inside the encrypted credential blob
 * (convex/connections/credentialStore.ts). It holds the Google OAuth REFRESH token; access
 * tokens are minted per provider call and kept in memory only (as for Google Ads, G-D5a).
 * No expiry: revocation and expiry surface as `invalid_grant` -> "auth" -> needs_reauth.
 * Produced by the YouTube OAuth spec (Checkpoint 2).
 */
export type YouTubeCredential = {
  kind: "youtube";
  v: 1;
  refreshToken: string;
  /** The OAuth client the token was issued to (checked against YOUTUBE_CLIENT_ID per call). */
  clientId: string;
  /** The channel the consent was given for (`channels.list?mine=true` at connect). */
  channelId: string;
  /** Epoch ms. */
  issuedAt: number;
  /** Scopes Google reported as granted. */
  scopes: string[];
};

/** [doc] Google refresh tokens are at most 512 bytes; this bound is deliberately generous. */
const MAX_TOKEN_LENGTH = 4_096;

export function isYouTubeCredential(value: unknown): value is YouTubeCredential {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.kind === "youtube" &&
    c.v === 1 &&
    typeof c.refreshToken === "string" &&
    c.refreshToken.length > 0 &&
    c.refreshToken.length <= MAX_TOKEN_LENGTH &&
    typeof c.clientId === "string" &&
    isYouTubeChannelId(c.channelId) &&
    typeof c.issuedAt === "number" &&
    Number.isFinite(c.issuedAt) &&
    Array.isArray(c.scopes) &&
    c.scopes.every((s) => typeof s === "string")
  );
}
