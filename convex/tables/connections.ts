import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  adAccountStatusValidator,
  adPlatformValidator,
  connectionProviderValidator,
  managerStatusValidator,
  socialAccountTypeValidator,
  socialPlatformValidator,
  testAccountStatusValidator,
} from "../domain/validators";
import { orgIdField } from "./common";

// Phase 4: platform connections and their (encrypted) credentials.
// `credentials` and `oauthStates` are INTERNAL-ONLY: no public function reads
// them (lint + contract tests). Plaintext tokens never reach the database.

export const connectionStatusValidator = v.union(
  v.literal("active"),
  v.literal("needs_reauth"),
  v.literal("revoked"),
);

export const connectionTables = {
  /**
   * One platform identity (Meta user / Google account / Instagram professional account)
   * connected by an org.
   */
  connections: defineTable({
    orgId: orgIdField,
    provider: connectionProviderValidator,
    /** Platform user identity; natural key with (orgId, provider). */
    externalUserId: v.string(),
    displayName: v.optional(v.string()),
    status: connectionStatusValidator,
    grantedScopes: v.array(v.string()),
    /** Increments every time the credential is replaced (reconnect). */
    credentialVersion: v.number(),
    /** Access-token expiry when the platform has one (Meta ~60 days). */
    tokenExpiresAt: v.optional(v.number()),
    /** Sanitized last failure: kind + generic message only, never platform payloads. */
    lastError: v.optional(v.object({ kind: v.string(), message: v.string(), at: v.number() })),
    connectedBySubject: v.string(),
    connectedAt: v.number(),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_provider_identity", ["orgId", "provider", "externalUserId"])
    .index("by_org_status", ["orgId", "status"])
    // GLOBAL (approved exception): system health sweep across orgs.
    .index("by_status_expires", ["status", "tokenExpiresAt"]),

  /** AES-256-GCM encrypted credential bundle, one per connection. INTERNAL-ONLY. */
  credentials: defineTable({
    orgId: orgIdField,
    connectionId: v.id("connections"),
    ciphertext: v.bytes(),
    iv: v.bytes(),
    keyVersion: v.number(),
    algorithm: v.literal("AES-256-GCM"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_org_connection", ["orgId", "connectionId"]),

  /** Short-lived, single-use OAuth state. The nonce is stored only as a hash. INTERNAL-ONLY. */
  oauthStates: defineTable({
    orgId: orgIdField,
    provider: connectionProviderValidator,
    nonceHash: v.string(),
    /** PKCE verifier (short-lived; deleted by the sweep). */
    codeVerifier: v.optional(v.string()),
    issuer: v.string(),
    initiatedBySubject: v.string(),
    returnUrl: v.optional(v.string()),
    reconnectConnectionId: v.optional(v.id("connections")),
    status: v.union(v.literal("pending"), v.literal("consumed"), v.literal("failed")),
    failureCode: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
    consumedAt: v.optional(v.number()),
  })
    // GLOBAL (approved exception): the OAuth callback is unauthenticated.
    .index("by_nonce_hash", ["nonceHash"])
    // GLOBAL (approved exception): system sweep of expired states.
    .index("by_expires", ["expiresAt"])
    .index("by_org_created", ["orgId", "createdAt"]),

  /** Accounts a connection can access; replaced on every discovery. */
  discoveredAssets: defineTable({
    orgId: orgIdField,
    connectionId: v.id("connections"),
    assetType: v.literal("ad_account"),
    platform: adPlatformValidator,
    externalId: v.string(),
    name: v.string(),
    currency: v.string(),
    timezone: v.string(),
    status: adAccountStatusValidator,
    rawStatus: v.optional(v.string()),
    isManager: v.boolean(),
    /**
     * Discovery facts as the provider reported them (absent on rows stored before they were
     * recorded). Read through connections/assetStatus.ts: an absent google_ads value is
     * "unknown", never "client" / "not_test".
     */
    managerStatus: v.optional(managerStatusValidator),
    testAccountStatus: v.optional(testAccountStatusValidator),
    parentExternalId: v.optional(v.string()),
    discoveredAt: v.number(),
  }).index("by_org_connection_external", ["orgId", "connectionId", "externalId"]),

  /**
   * Organic social accounts a connection can access (Phase 10); replaced on every
   * discovery. Minimum identity only: no profile picture, biography, website or followers
   * (those arrive with the first sync preflight, Stage B).
   */
  discoveredSocialAccounts: defineTable({
    orgId: orgIdField,
    connectionId: v.id("connections"),
    platform: socialPlatformValidator,
    /** Instagram professional account id (`/me.user_id`). */
    externalId: v.string(),
    username: v.optional(v.string()),
    /** Business / creator only: any other platform account type fails discovery closed. */
    accountType: socialAccountTypeValidator,
    discoveredAt: v.number(),
  }).index("by_org_connection_external", ["orgId", "connectionId", "externalId"]),
};
