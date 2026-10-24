import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import {
  adAccountStatusValidator,
  adPlatformValidator,
  managerStatusValidator,
  storedConnectionProviderValidator,
  testAccountStatusValidator,
} from "../../domain/validators";
import { effectiveManagerStatus, effectiveTestAccountStatus } from "../../connections/assetStatus";
import { toIso } from "../../lib/dto";
import { isSyncErrorReason, syncErrorReasonValidator } from "../../sync/publicStatus";
import { connectionStatusValidator } from "../../tables/connections";

/** Days before token expiry from which a connection is flagged `expiresSoon`. */
const EXPIRES_SOON_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * Connection DTO. Carries NO secret material: no tokens, ciphertext, IVs,
 * verifiers, nonces or authorization codes (contract-tested).
 */
export const connectionDto = v.object({
  id: v.string(),
  /**
   * Phase 10: widened with "instagram"; ADR 0014: with "whatsapp" (additive enum values; v1
   * freezes in Phase 13).
   */
  provider: storedConnectionProviderValidator,
  displayName: v.optional(v.string()),
  status: connectionStatusValidator,
  grantedScopes: v.array(v.string()),
  /** Required scopes the user did not grant (re-connect to fix). */
  missingScopes: v.array(v.string()),
  tokenExpiresAt: v.optional(v.string()),
  expiresSoon: v.boolean(),
  lastError: v.optional(
    v.object({
      kind: v.string(),
      message: v.string(),
      /** Google Ads discovery failures: allowlisted reason (never the platform code). */
      reason: v.optional(syncErrorReasonValidator),
      at: v.string(),
    }),
  ),
  connectedAt: v.string(),
  updatedAt: v.string(),
});
export type ConnectionDto = Infer<typeof connectionDto>;

export function toConnectionDto(
  connection: Doc<"connections">,
  requiredScopes: readonly string[],
  now: number,
): ConnectionDto {
  const granted = new Set(connection.grantedScopes);
  return {
    id: connection._id,
    provider: connection.provider,
    ...(connection.displayName !== undefined ? { displayName: connection.displayName } : {}),
    status: connection.status,
    grantedScopes: connection.grantedScopes,
    missingScopes: requiredScopes.filter((scope) => !granted.has(scope)),
    ...(connection.tokenExpiresAt !== undefined
      ? { tokenExpiresAt: toIso(connection.tokenExpiresAt) }
      : {}),
    expiresSoon:
      connection.status === "active" &&
      connection.tokenExpiresAt !== undefined &&
      connection.tokenExpiresAt - now < EXPIRES_SOON_MS,
    ...(connection.lastError !== undefined
      ? {
          lastError: {
            kind: connection.lastError.kind,
            message: connection.lastError.message,
            ...(isSyncErrorReason(connection.lastError.reason)
              ? { reason: connection.lastError.reason }
              : {}),
            at: toIso(connection.lastError.at),
          },
        }
      : {}),
    connectedAt: toIso(connection.connectedAt),
    updatedAt: toIso(connection.updatedAt),
  };
}

export const discoveredAssetDto = v.object({
  externalId: v.string(),
  platform: adPlatformValidator,
  name: v.string(),
  currency: v.string(),
  timezone: v.string(),
  status: adAccountStatusValidator,
  /** True only when the platform explicitly reported a manager. */
  isManager: v.boolean(),
  /** "manager" | "client" | "unknown" (not reported). Only "client" can be linked. */
  managerStatus: managerStatusValidator,
  /** "test" | "not_test" | "unknown" (not reported). Never defaulted. */
  testAccountStatus: testAccountStatusValidator,
  /** The manager account it was discovered through (absent: directly accessible). */
  parentExternalId: v.optional(v.string()),
  /** Already linked to this connection. */
  linked: v.boolean(),
  discoveredAt: v.string(),
});
export type DiscoveredAssetDto = Infer<typeof discoveredAssetDto>;

export function toDiscoveredAssetDto(
  asset: Doc<"discoveredAssets">,
  linked: boolean,
): DiscoveredAssetDto {
  return {
    externalId: asset.externalId,
    platform: asset.platform,
    name: asset.name,
    currency: asset.currency,
    timezone: asset.timezone,
    status: asset.status,
    isManager: asset.isManager,
    managerStatus: effectiveManagerStatus(asset),
    testAccountStatus: effectiveTestAccountStatus(asset),
    ...(asset.parentExternalId !== undefined ? { parentExternalId: asset.parentExternalId } : {}),
    linked,
    discoveredAt: toIso(asset.discoveredAt),
  };
}
