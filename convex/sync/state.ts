import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { addDays, todayIn } from "../lib/dates";
import { SYNC_LIMITS } from "./config";
import { subjectOf, type SyncSubject } from "./subject";

/** The sync state row of an ad account (org-scoped lookup). */
export async function findSyncAccount(
  db: DatabaseReader,
  orgId: Id<"organizations">,
  adAccountId: Id<"adAccounts">,
): Promise<Doc<"syncAccounts"> | null> {
  return await db
    .query("syncAccounts")
    .withIndex("by_org_account", (q) => q.eq("orgId", orgId).eq("adAccountId", adAccountId))
    .first();
}

/**
 * Called when an ad account is (re)linked (Phase 4 linkAdAccounts). Creates
 * the sync state on first link and schedules it for the next planner tick. A
 * relink to another connection, or a link after an unlink (parked), resets
 * scheduling and failure state; coverage is kept because the canonical rows
 * (same natural keys) are reused. An active run is NOT touched here: its next
 * claim/commit sees the changed connection and cancels itself.
 */
export async function ensureSyncAccount(
  db: DatabaseWriter,
  account: Doc<"adAccounts">,
  options: { relinked: boolean },
  now: number,
): Promise<Id<"syncAccounts">> {
  const existing = await findSyncAccount(db, account.orgId, account._id);
  if (existing === null) {
    return await db.insert("syncAccounts", {
      orgId: account.orgId,
      adAccountId: account._id,
      state: "idle",
      nextPlanAt: now,
      structureStale: true,
      backfillHorizon: addDays(
        todayIn(account.timezone, now),
        -(SYNC_LIMITS.backfillHorizonDays - 1),
      ),
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (options.relinked || existing.state === "parked" || existing.nextPlanAt === undefined) {
    await db.patch(existing._id, {
      state: existing.activeRunId !== undefined ? existing.state : "idle",
      nextPlanAt: now,
      structureStale: true,
      consecutiveFailures: 0,
      throttledUntil: undefined,
      lastError: undefined,
      ...(options.relinked ? { nextLookbackAt: now } : {}),
      updatedAt: now,
    });
  }
  return existing._id;
}

// ---------------------------------------------------------------------------
// Phase 10: organic social subjects
// ---------------------------------------------------------------------------

/** The sync state row of a social account (org-scoped lookup). */
export async function findSocialSyncAccount(
  db: DatabaseReader,
  orgId: Id<"organizations">,
  socialAccountId: Id<"socialAccounts">,
): Promise<Doc<"syncAccounts"> | null> {
  return await db
    .query("syncAccounts")
    .withIndex("by_org_social_account", (q) =>
      q.eq("orgId", orgId).eq("socialAccountId", socialAccountId),
    )
    .first();
}

/** The sync state row of any subject. */
export async function findSyncAccountForSubject(
  db: DatabaseReader,
  orgId: Id<"organizations">,
  subject: SyncSubject,
): Promise<Doc<"syncAccounts"> | null> {
  const row =
    subject.kind === "ad"
      ? await findSyncAccount(db, orgId, subject.adAccountId)
      : await findSocialSyncAccount(db, orgId, subject.socialAccountId);
  // A row found through one subject index must not also name the other subject.
  if (row !== null) subjectOf(row);
  return row;
}

/**
 * Called when a social account is (re)linked (Phase 10 linkSocialAccounts), with the same
 * scheduling rules as ensureSyncAccount. Social days are UTC days; the backfill horizon is
 * the platform's account-metric retention (capabilities.accountMetricsHorizonDays).
 */
export async function ensureSocialSyncAccount(
  db: DatabaseWriter,
  account: Doc<"socialAccounts">,
  options: { relinked: boolean; horizonDays: number },
  now: number,
): Promise<Id<"syncAccounts">> {
  const existing = await findSocialSyncAccount(db, account.orgId, account._id);
  if (existing === null) {
    return await db.insert("syncAccounts", {
      orgId: account.orgId,
      socialAccountId: account._id,
      state: "idle",
      nextPlanAt: now,
      structureStale: false,
      backfillHorizon: addDays(todayIn("UTC", now), -(options.horizonDays - 1)),
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (options.relinked || existing.state === "parked" || existing.nextPlanAt === undefined) {
    await db.patch(existing._id, {
      state: existing.activeRunId !== undefined ? existing.state : "idle",
      nextPlanAt: now,
      consecutiveFailures: 0,
      throttledUntil: undefined,
      lastError: undefined,
      ...(options.relinked ? { nextLookbackAt: now } : {}),
      updatedAt: now,
    });
  }
  return existing._id;
}
