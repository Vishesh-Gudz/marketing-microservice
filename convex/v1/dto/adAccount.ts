import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { adAccountStatusValidator, adPlatformValidator } from "../../domain/validators";
import { toIso } from "../../lib/dto";
import { publicSyncStatusDto, type PublicSyncStatus } from "../../sync/publicStatus";

export const adAccountDto = v.object({
  id: v.string(),
  platform: adPlatformValidator,
  externalId: v.string(),
  name: v.string(),
  currency: v.string(),
  timezone: v.string(),
  status: adAccountStatusValidator,
  isManager: v.boolean(),
  linked: v.boolean(),
  connectionId: v.optional(v.string()),
  linkedAt: v.optional(v.string()),
  /** Read-only sync state (v1/adAccounts:list; absent before the first plan). */
  sync: v.optional(publicSyncStatusDto),
});
export type AdAccountDto = Infer<typeof adAccountDto>;

export function toAdAccountDto(account: Doc<"adAccounts">, sync?: PublicSyncStatus): AdAccountDto {
  return {
    id: account._id,
    platform: account.platform,
    externalId: account.externalId,
    name: account.name,
    currency: account.currency,
    timezone: account.timezone,
    status: account.status,
    isManager: account.isManager,
    linked: account.connectionId !== undefined,
    ...(account.connectionId !== undefined ? { connectionId: account.connectionId } : {}),
    ...(account.linkedAt !== undefined ? { linkedAt: toIso(account.linkedAt) } : {}),
    ...(sync !== undefined ? { sync } : {}),
  };
}
