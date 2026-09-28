import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import {
  socialAccountStatusValidator,
  socialAccountTypeValidator,
  socialPlatformValidator,
} from "../../domain/validators";
import { toIso } from "../../lib/dto";

/**
 * Organic social account DTOs (Phase 10). Minimum identity and link state only: no
 * credentials, no profile picture or other profile details (those arrive with Stage B),
 * no internal ids beyond the opaque account/connection ids.
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
