import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import type { AdPlatform, EntityLevel } from "../domain/types";
import type { DateKey } from "../lib/dates";
import { createDefaultRegistry } from "../providers";
import type { AdsProviderCapabilities } from "../providers/capabilities";
import { syncableLevels } from "../sync/plan";
import { overlapDays, rangeDays, type DateRange } from "./periods";

/**
 * Data states (docs/analytics.md "Missing vs zero"). Coverage comes from the
 * Phase 5 `syncAccounts.coveredFrom/coveredThrough`: inside coverage a missing
 * row means "no delivery"; outside it means "unknown". Never collapsed to 0.
 */
export const DATA_STATES = [
  "reported",
  "partial",
  "no_delivery",
  "unknown",
  "unsupported",
] as const;
export type DataState = (typeof DATA_STATES)[number];

export type AccountCoverage = {
  accountId: Id<"adAccounts">;
  coveredFrom?: DateKey;
  coveredThrough?: DateKey;
  lastSyncedAt?: number;
  /** The account's provider can report the requested data at all. */
  supported: boolean;
};

let registry: ReturnType<typeof createDefaultRegistry> | undefined;

/** Static provider capabilities (declarations only; no provider call is ever made). */
export function capabilitiesOf(platform: AdPlatform): AdsProviderCapabilities | undefined {
  registry ??= createDefaultRegistry();
  return registry.hasAds(platform) ? registry.ads(platform).capabilities : undefined;
}

export type Requirement =
  | { kind: "level"; level: EntityLevel }
  | { kind: "placement"; level: EntityLevel }
  | { kind: "actions"; level: EntityLevel };

export function supports(platform: AdPlatform, requirement: Requirement): boolean {
  const caps = capabilitiesOf(platform);
  if (caps === undefined) return false;
  const levelOk = syncableLevels(caps).includes(requirement.level);
  switch (requirement.kind) {
    case "level":
      return levelOk;
    case "placement":
      return levelOk && caps.placementBreakdown;
    case "actions":
      return levelOk && caps.actionMetrics;
  }
}

/** Coverage of each account (org-scoped index reads, one per account). */
export async function loadCoverage(
  db: DatabaseReader,
  orgId: Id<"organizations">,
  accounts: readonly Doc<"adAccounts">[],
  requirement: Requirement,
): Promise<AccountCoverage[]> {
  const result: AccountCoverage[] = [];
  for (const account of accounts) {
    const state = await db
      .query("syncAccounts")
      .withIndex("by_org_account", (q) => q.eq("orgId", orgId).eq("adAccountId", account._id))
      .first();
    result.push({
      accountId: account._id,
      ...(state?.coveredFrom !== undefined ? { coveredFrom: state.coveredFrom } : {}),
      ...(state?.coveredThrough !== undefined ? { coveredThrough: state.coveredThrough } : {}),
      ...(state?.lastSuccessAt !== undefined ? { lastSyncedAt: state.lastSuccessAt } : {}),
      supported: supports(account.platform, requirement),
    });
  }
  return result;
}

function daysCovered(coverage: AccountCoverage, range: DateRange): number {
  return overlapDays(range, { from: coverage.coveredFrom, through: coverage.coveredThrough });
}

/**
 * reported     rows exist and every (supported) account covers the whole range
 * partial      some day of some account is outside coverage (values are lower bounds)
 * no_delivery  fully covered and no rows (NOT zero; the client may display 0)
 * unknown      no row and no coverage at all
 * unsupported  no account's provider reports this data
 */
export function dataStateOf(
  hasRows: boolean,
  coverages: readonly AccountCoverage[],
  range: DateRange,
): DataState {
  const relevant = coverages.filter((c) => c.supported);
  if (relevant.length === 0) return "unsupported";
  const days = rangeDays(range);
  const covered = relevant.map((c) => daysCovered(c, range));
  const full = covered.every((d) => d === days);
  if (hasRows) return full ? "reported" : "partial";
  if (full) return "no_delivery";
  return covered.every((d) => d === 0) ? "unknown" : "partial";
}

export function coverageSummary(coverages: readonly AccountCoverage[], range: DateRange) {
  const days = rangeDays(range);
  return coverages.map((c) => ({
    accountId: c.accountId as string,
    ...(c.coveredFrom !== undefined ? { coveredFrom: c.coveredFrom } : {}),
    ...(c.coveredThrough !== undefined ? { coveredThrough: c.coveredThrough } : {}),
    daysUncovered: days - daysCovered(c, range),
    ...(c.lastSyncedAt !== undefined ? { lastSyncedAt: c.lastSyncedAt } : {}),
    supported: c.supported,
  }));
}
