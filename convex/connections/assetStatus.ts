import type { Doc } from "../_generated/dataModel";
import type { ManagerStatus, TestAccountStatus } from "../domain/types";

/**
 * Effective discovery facts of a discovered ad account. Pure.
 *
 * - managerStatus: the stored value when the provider reported one. Without it, providers
 *   that always know the account type (Meta, the mocks) are derived from `isManager`;
 *   a google_ads row without it is "unknown" (Google's `manager` is an optional field and
 *   older rows did not record whether it was reported). An explicit manager is always
 *   "manager".
 * - testAccountStatus: the stored value, else "unknown". Never defaulted to "not_test".
 *
 * "unknown" is never treated as "client": only an effective "client" can be linked.
 */
type Asset = Pick<
  Doc<"discoveredAssets">,
  "platform" | "isManager" | "managerStatus" | "testAccountStatus"
>;

export function effectiveManagerStatus(asset: Asset): ManagerStatus {
  if (asset.isManager) return "manager";
  if (asset.managerStatus !== undefined) return asset.managerStatus;
  return asset.platform === "google_ads" ? "unknown" : "client";
}

export function effectiveTestAccountStatus(asset: Asset): TestAccountStatus {
  return asset.testAccountStatus ?? "unknown";
}
