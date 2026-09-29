import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import {
  socialAccountStatusValidator,
  socialAccountTypeValidator,
  socialPlatformValidator,
} from "../../domain/validators";
import { toIso } from "../../lib/dto";

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

/** Stage B (v1/socialAccounts): the account plus its follower count and sync state. */
export function toSocialAccountDetailDto(
  account: Doc<"socialAccounts">,
  sync: Doc<"syncAccounts"> | null,
): SocialAccountDto {
  return {
    ...toSocialAccountDto(account),
    ...(account.followersCount !== undefined ? { followersCount: account.followersCount } : {}),
    ...(sync?.lastSuccessAt !== undefined ? { lastSyncedAt: toIso(sync.lastSuccessAt) } : {}),
    ...(sync?.coveredFrom !== undefined && sync.coveredThrough !== undefined
      ? { coverage: { from: sync.coveredFrom, through: sync.coveredThrough } }
      : {}),
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
