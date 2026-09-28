import type { Doc } from "../_generated/dataModel";
import { MappingError } from "../providers/errors";
import type { ProviderDiscoveredSocialAccount } from "../providers/social/types";
import { socialRecordIssues } from "../providers/social/validate";
import type { OrgScope } from "./scope";

/**
 * Provider social records -> canonical social rows (Phase 10). Pure; tenant identity enters
 * ONLY through a branded scope derived from stored state or the verified tenant.
 *
 * Stage A maps what linking needs: a discovered account (minimum identity) becomes the
 * canonical socialAccounts row. `name` is the username as a label until the first sync
 * preflight (Stage B) fills the profile name; the external id is the last resort. Posts,
 * snapshots and daily rows are mapped in Stage B.
 */

export type LinkedSocialAccountFields = Pick<
  Doc<"socialAccounts">,
  "orgId" | "platform" | "externalId" | "username" | "name" | "accountType" | "status"
>;

export function mapLinkedSocialAccount(
  record: ProviderDiscoveredSocialAccount,
  scope: OrgScope,
): LinkedSocialAccountFields {
  if (socialRecordIssues("discoveredSocialAccount", record).length > 0) {
    throw new MappingError("invalid_record", "Invalid discovered social account");
  }
  return {
    orgId: scope.orgId,
    platform: record.platform,
    externalId: record.externalId,
    ...(record.username !== undefined ? { username: record.username } : {}),
    name: record.username ?? record.externalId,
    accountType: record.accountType,
    status: "active",
  };
}
