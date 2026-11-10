import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import {
  literalUnion,
  socialAccountStatusValidator,
  socialAccountTypeValidator,
  socialPlatformValidator,
} from "../../domain/validators";
import { toIso } from "../../lib/dto";
import { instagramOrganicSyncAllowed } from "../../providers/instagram/config";

/**
 * O2: whether organic sync can run for an account, from its connection.
 * - active                      everything else (including unlinked accounts)
 * - insights_permission_missing an Instagram Unified Login connection without
 *                               instagram_manage_insights: the account is never synced until it is
 *                               reconnected with that permission
 */
export const ORGANIC_SYNC_STATES = ["active", "insights_permission_missing"] as const;
export type OrganicSyncState = (typeof ORGANIC_SYNC_STATES)[number];

export function organicSyncOf(
  account: Pick<Doc<"socialAccounts">, "platform">,
  connection: Pick<Doc<"connections">, "provider" | "grantedScopes"> | null,
): OrganicSyncState {
  return account.platform === "instagram" &&
    connection?.provider === "instagram" &&
    !instagramOrganicSyncAllowed(connection.grantedScopes)
    ? "insights_permission_missing"
    : "active";
}

/**
 * Organic social account DTOs (Phase 10). Identity, link state and (Stage B, when read through
 * v1/socialAccounts) the latest follower count, last successful sync and account-metric
 * coverage. Never: credentials, a profile picture or any other URL (F1), biography, website,
 * connection internals beyond the opaque connection id, or internal ids beyond opaque ids.
 */
export const socialAccountDto = v.object({
  id: v.string(),
  platform: socialPlatformValidator,
  externalId: v.string(),
  username: v.optional(v.string()),
  name: v.string(),
  accountType: socialAccountTypeValidator,
  status: socialAccountStatusValidator,
  linked: v.boolean(),
  connectionId: v.optional(v.string()),
  linkedAt: v.optional(v.string()),
  /** Stage B: latest follower count as of its capture (profile read). */
  followersCount: v.optional(v.number()),
  /** Stage B: last successful sync (ISO instant). */
  lastSyncedAt: v.optional(v.string()),
  /** Stage B: UTC days with complete account metrics. */
  coverage: v.optional(v.object({ from: v.string(), through: v.string() })),
  /**
   * O2 (additive): whether organic sync can run (organicSyncOf). Always set by
   * v1/socialAccounts; absent from the link/unlink results of v1/connections (read as active).
   */
  organicSync: v.optional(literalUnion(ORGANIC_SYNC_STATES)),
});
export type SocialAccountDto = Infer<typeof socialAccountDto>;

export function toSocialAccountDto(account: Doc<"socialAccounts">): SocialAccountDto {
  return {
    id: account._id,
    platform: account.platform,
    externalId: account.externalId,
    ...(account.username !== undefined ? { username: account.username } : {}),
    name: account.name,
    accountType: account.accountType,
    status: account.status,
    linked: account.connectionId !== undefined,
    ...(account.connectionId !== undefined ? { connectionId: account.connectionId } : {}),
    ...(account.linkedAt !== undefined ? { linkedAt: toIso(account.linkedAt) } : {}),
  };
}

/**
 * Stage B (v1/socialAccounts): the account plus its follower count and sync state; O2: and
 * whether organic sync can run, from its (tenant-checked) connection.
 */
export function toSocialAccountDetailDto(
  account: Doc<"socialAccounts">,
  sync: Doc<"syncAccounts"> | null,
  connection: Pick<Doc<"connections">, "provider" | "grantedScopes"> | null,
): SocialAccountDto {
  return {
    ...toSocialAccountDto(account),
    ...(account.followersCount !== undefined ? { followersCount: account.followersCount } : {}),
    ...(sync?.lastSuccessAt !== undefined ? { lastSyncedAt: toIso(sync.lastSuccessAt) } : {}),
    ...(sync?.coveredFrom !== undefined && sync.coveredThrough !== undefined
      ? { coverage: { from: sync.coveredFrom, through: sync.coveredThrough } }
      : {}),
    organicSync: organicSyncOf(account, connection),
  };
}

export const discoveredSocialAccountDto = v.object({
  externalId: v.string(),
  platform: socialPlatformValidator,
  username: v.optional(v.string()),
  accountType: socialAccountTypeValidator,
  /** Already linked to this connection. */
  linked: v.boolean(),
  discoveredAt: v.string(),
});
export type DiscoveredSocialAccountDto = Infer<typeof discoveredSocialAccountDto>;

export function toDiscoveredSocialAccountDto(
  row: Doc<"discoveredSocialAccounts">,
  linked: boolean,
): DiscoveredSocialAccountDto {
  return {
    externalId: row.externalId,
    platform: row.platform,
    ...(row.username !== undefined ? { username: row.username } : {}),
    accountType: row.accountType,
    linked,
    discoveredAt: toIso(row.discoveredAt),
  };
}
