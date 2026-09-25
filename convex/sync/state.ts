import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { addDays, todayIn } from "../lib/dates";
import { SYNC_LIMITS } from "./config";

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
