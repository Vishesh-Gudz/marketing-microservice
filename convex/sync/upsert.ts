import type { Infer } from "convex/values";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import type { EntityLevel, Placement } from "../domain/types";
import type { DateKey } from "../lib/dates";
import {
  mapAd,
  mapAdAccount,
  mapAdGroup,
  mapActionRows,
  mapCampaign,
  mapCreative,
  mapMetricRows,
  type CanonicalInsert,
} from "../mapping/ads";
import type { AccountScope, OrgScope } from "../mapping/scope";
import { mapLinkedSocialAccount } from "../mapping/social";
import { MappingError } from "../providers/errors";
import type {
  ProviderActionRow,
  ProviderAd,
  ProviderAdAccount,
  ProviderAdGroup,
  ProviderCampaign,
  ProviderCreative,
  ProviderMetricRow,
} from "../providers/types";
import type { ProviderDiscoveredSocialAccount } from "../providers/social/types";
import type { syncCountsValidator } from "../tables/sync";
import { applyCaps } from "./guards";
import { buildResolver } from "./resolver";

/**
 * THE canonical write path for adAccounts, campaigns, adGroups, ads, creatives,
 * metricsDaily and actionMetricsDaily, and (Phase 10) the organic social tables
 * socialAccounts, socialPosts, socialPostMetricSnapshots and socialAccountMetricsDaily
 * (ESLint: no other module may insert into these tables). Natural keys are exactly the Phase 2 keys (domain/identity.ts):
 *
 *   adAccounts                              (orgId, platform, externalId)
 *   campaigns / adGroups / ads / creatives  (orgId, adAccountId, externalId)
 *   metricsDaily        (orgId, entityId, placement, date)
 *   actionMetricsDaily  (orgId, entityId, placement, date, rawActionType, attributionWindow)
 *
 * Uniqueness without SQL constraints: every write reads its natural-key index
 * range and writes in the SAME mutation. Convex mutations are serializable,
 * so a concurrent insert of the same key conflicts and one side retries. A
 * defensive repair keeps the oldest row if duplicates are ever found.
 *
 * Replacement semantics: provider-owned fields are REPLACED (a field the
 * platform stops reporting disappears; metrics are never patched or
 * incremented); service-owned fields (createdAt, connectionId, linkedAt) are
 * preserved.
 */

export type SyncCounts = Infer<typeof syncCountsValidator>;

export function emptyCounts(): SyncCounts {
  return {
    pages: 0,
    records: 0,
    inserted: 0,
    updated: 0,
    removed: 0,
    reappeared: 0,
    metricRows: 0,
    actionRows: 0,
    pruned: 0,
    unresolved: 0,
    rejected: 0,
    truncated: 0,
    duplicatesRepaired: 0,
  };
}

export function addCounts(a: SyncCounts, b: Partial<SyncCounts>): SyncCounts {
  const out = { ...a };
  for (const [key, value] of Object.entries(b) as [keyof SyncCounts, number][]) {
    out[key] += value;
  }
  return out;
}

/** Keeps the oldest row of a natural key; deletes duplicates (should never exist). */
async function keepOldest<T extends { _id: Id<TableNames> }>(
  db: DatabaseWriter,
  rows: T[],
  counts: SyncCounts,
): Promise<T | null> {
  const [first, ...rest] = rows;
  for (const duplicate of rest) {
    await db.delete(duplicate._id);
    counts.duplicatesRepaired++;
  }
  return first ?? null;
}

/** Bound on rows read for one natural key (normally 0 or 1). */
const KEY_SCAN = 10;

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------------------
// Ad accounts
// ---------------------------------------------------------------------------

async function findAdAccount(
  db: DatabaseWriter,
  orgId: Id<"organizations">,
  platform: Doc<"adAccounts">["platform"],
  externalId: string,
  counts: SyncCounts,
) {
  const rows = await db
    .query("adAccounts")
    .withIndex("by_org_platform_external", (q) =>
      q.eq("orgId", orgId).eq("platform", platform).eq("externalId", externalId),
    )
    .take(KEY_SCAN);
  return await keepOldest(db, rows, counts);
}

/**
 * Link path (Phase 4 `linkAdAccounts`): upserts a discovered account and links
 * it to `connectionId`. Discovery records carry no attributes, so this keeps
 * the Phase 4 field-level update instead of a full replace.
 */
export async function upsertLinkedAdAccount(
  db: DatabaseWriter,
  scope: OrgScope,
  record: ProviderAdAccount,
  connectionId: Id<"connections">,
  now: number,
): Promise<{
  adAccountId: Id<"adAccounts">;
  created: boolean;
  previousConnectionId?: Id<"connections">;
}> {
  const row = mapAdAccount(record, scope, now);
  const existing = await findAdAccount(
    db,
    scope.orgId,
    row.platform,
    row.externalId,
    emptyCounts(),
  );
  if (existing) {
    await db.patch(existing._id, {
      name: row.name,
      currency: row.currency,
      timezone: row.timezone,
      status: row.status,
      rawStatus: row.rawStatus,
      isManager: row.isManager,
      parentExternalId: row.parentExternalId,
      connectionId,
      linkedAt: existing.connectionId === connectionId ? existing.linkedAt : now,
      lastSeenAt: now,
      removedAt: undefined,
      updatedAt: now,
    });
    return {
      adAccountId: existing._id,
      created: false,
      ...(existing.connectionId !== undefined
        ? { previousConnectionId: existing.connectionId }
        : {}),
    };
  }
  const adAccountId = await db.insert("adAccounts", { ...row, connectionId, linkedAt: now });
  return { adAccountId, created: true };
}

export type AccountDrift = "currency" | "timezone" | "manager";

/** Currency/timezone define the meaning of stored money and days; they must never change silently. */
export function accountDrift(
  account: Doc<"adAccounts">,
  record: ProviderAdAccount,
): AccountDrift | undefined {
  if (record.currency !== account.currency) return "currency";
  if (record.timezone !== account.timezone) return "timezone";
  if (record.isManager) return "manager";
  return undefined;
}

/**
 * Sync path (getAccount preflight): replaces provider-owned account fields.
 * Preserves createdAt, connectionId and linkedAt. The caller must have checked
 * `accountDrift` first.
 */
export async function refreshAdAccount(
  db: DatabaseWriter,
  account: Doc<"adAccounts">,
  record: ProviderAdAccount,
  scope: OrgScope,
  now: number,
): Promise<SyncCounts> {
  const counts = emptyCounts();
  const capped = applyCaps(mapAdAccount(record, scope, now));
  counts.truncated += capped.truncated;
  await db.replace(
    account._id,
    withoutUndefined({
      ...capped.value,
      createdAt: account.createdAt,
      connectionId: account.connectionId,
      linkedAt: account.linkedAt,
    }),
  );
  if (account.removedAt !== undefined) counts.reappeared++;
  counts.updated++;
  return counts;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

type EntityTable = "campaigns" | "adGroups" | "ads" | "creatives";

async function findEntity<T extends EntityTable>(
  db: DatabaseWriter,
  table: T,
  scope: AccountScope,
  externalId: string,
  counts: SyncCounts,
): Promise<Doc<T> | null> {
  // The four entity tables share the natural-key index name and shape.
  const rows = (await (db as DatabaseReader)
    .query(table as "campaigns")
    .withIndex("by_org_account_external", (q) =>
      q.eq("orgId", scope.orgId).eq("adAccountId", scope.adAccountId).eq("externalId", externalId),
    )
    .take(KEY_SCAN)) as unknown as Doc<T>[];
  return await keepOldest(db, rows, counts);
}

async function writeEntity<T extends EntityTable>(
  db: DatabaseWriter,
  table: T,
  scope: AccountScope,
  row: CanonicalInsert<T>,
  counts: SyncCounts,
): Promise<void> {
  const capped = applyCaps(row);
  counts.truncated += capped.truncated;
  const externalId = (row as unknown as { externalId: string }).externalId;
  const existing = await findEntity(db, table, scope, externalId, counts);
  if (existing) {
    const previous = existing as unknown as { removedAt?: number; createdAt: number };
    if (previous.removedAt !== undefined) counts.reappeared++;
    // The mapped row has no removedAt: replacing clears a previous removal.
    await db.replace(existing._id, { ...capped.value, createdAt: previous.createdAt } as never);
    counts.updated++;
  } else {
    await db.insert(table, capped.value as never);
    counts.inserted++;
  }
}

/** Unresolved parents are skipped and counted (never written as dangling references). */
function skipMappingError(error: unknown, counts: SyncCounts): void {
  if (error instanceof MappingError && error.reason === "unresolved_entity") {
    counts.unresolved++;
    return;
  }
  if (error instanceof MappingError && error.reason === "invalid_record") {
    // Hierarchy inconsistency discovered while resolving (e.g. ad group of another campaign).
    counts.rejected++;
    return;
  }
  throw error;
}

export type EntityPage =
  | { kind: "campaign"; items: ProviderCampaign[] }
  | { kind: "adGroup"; items: ProviderAdGroup[] }
  | { kind: "creative"; items: ProviderCreative[] }
  | { kind: "ad"; items: ProviderAd[] };

export async function writeEntityPage(
  db: DatabaseWriter,
  page: EntityPage,
  scope: AccountScope,
  now: number,
): Promise<SyncCounts> {
  const counts = emptyCounts();
  counts.records += page.items.length;
  switch (page.kind) {
    case "campaign":
      for (const record of page.items) {
        await writeEntity(db, "campaigns", scope, mapCampaign(record, scope, now), counts);
      }
      break;
    case "creative":
      for (const record of page.items) {
        await writeEntity(db, "creatives", scope, mapCreative(record, scope, now), counts);
      }
      break;
    case "adGroup": {
      const resolver = await buildResolver(db, scope, {
        campaigns: page.items.map((r) => r.campaignExternalId),
      });
      for (const record of page.items) {
        let row: CanonicalInsert<"adGroups">;
        try {
          row = mapAdGroup(record, scope, resolver, now);
        } catch (error) {
          skipMappingError(error, counts);
          continue;
        }
        await writeEntity(db, "adGroups", scope, row, counts);
      }
      break;
    }
    case "ad": {
      const resolver = await buildResolver(db, scope, {
        campaigns: page.items.map((r) => r.campaignExternalId),
        adGroups: page.items.flatMap((r) =>
          r.adGroupExternalId !== undefined ? [r.adGroupExternalId] : [],
        ),
        creatives: page.items.flatMap((r) =>
          r.creativeExternalId !== undefined ? [r.creativeExternalId] : [],
        ),
      });
      for (const record of page.items) {
        let row: CanonicalInsert<"ads">;
        try {
          row = mapAd(record, scope, resolver, now);
        } catch (error) {
          skipMappingError(error, counts);
          continue;
        }
        await writeEntity(db, "ads", scope, row, counts);
      }
      break;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Metrics (whole-row replace)
// ---------------------------------------------------------------------------

function metricRefs(level: EntityLevel, ids: string[]) {
  switch (level) {
    case "account":
      return {};
    case "campaign":
      return { campaigns: ids };
    case "ad_group":
      return { adGroups: ids };
    case "ad":
      return { ads: ids };
  }
}

export type MetricPage =
  | { kind: "metricRow"; items: ProviderMetricRow[] }
  | { kind: "actionRow"; items: ProviderActionRow[] };

export async function writeMetricPage(
  db: DatabaseWriter,
  page: MetricPage,
  level: EntityLevel,
  scope: AccountScope,
  now: number,
): Promise<SyncCounts> {
  const counts = emptyCounts();
  counts.records += page.items.length;
  const resolver = await buildResolver(
    db,
    scope,
    metricRefs(
      level,
      page.items.map((r) => r.entityExternalId),
    ),
  );

  if (page.kind === "metricRow") {
    const batch = mapMetricRows(page.items, scope, resolver, now);
    counts.unresolved += batch.unresolved.length;
    for (const mapped of batch.rows) {
      const capped = applyCaps(mapped);
      counts.truncated += capped.truncated;
      const row = capped.value;
      const existing = await keepOldest(
        db,
        await db
          .query("metricsDaily")
          .withIndex("by_org_entity_placement_date", (q) =>
            q
              .eq("orgId", row.orgId)
              .eq("entityId", row.entityId)
              .eq("placement", row.placement)
              .eq("date", row.date),
          )
          .take(KEY_SCAN),
        counts,
      );
      if (existing) await db.replace(existing._id, row);
      else await db.insert("metricsDaily", row);
      counts.metricRows++;
    }
  } else {
    const batch = mapActionRows(page.items, scope, resolver, now);
    counts.unresolved += batch.unresolved.length;
    for (const mapped of batch.rows) {
      const row = mapped;
      const existing = await keepOldest(
        db,
        await db
          .query("actionMetricsDaily")
          .withIndex("by_org_entity_placement_date_action", (q) =>
            q
              .eq("orgId", row.orgId)
              .eq("entityId", row.entityId)
              .eq("placement", row.placement)
              .eq("date", row.date)
              .eq("rawActionType", row.rawActionType)
              .eq("attributionWindow", row.attributionWindow),
          )
          .take(KEY_SCAN),
        counts,
      );
      if (existing) await db.replace(existing._id, row);
      else await db.insert("actionMetricsDaily", row);
      counts.actionRows++;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Finalize: prune stale metric rows, mark removed entities (bounded batches)
// ---------------------------------------------------------------------------

export type PruneCursor = { i: number; c: string | null };

/**
 * Deletes rows of a COMPLETED metric request scope that were not rewritten by
 * it (syncedAt < fetchStartedAt): restated-away rows disappear, so "row
 * absent inside coverage" keeps meaning "no delivery". One paginated read per
 * call; returns the next cursor or undefined when done.
 */
export async function pruneMetricsBatch(
  db: DatabaseWriter,
  input: {
    table: "metricsDaily" | "actionMetricsDaily";
    scope: AccountScope;
    level: EntityLevel;
    placements: readonly Placement[];
    from: DateKey;
    to: DateKey;
    before: number;
    cursor: PruneCursor | undefined;
    limit: number;
  },
): Promise<{ pruned: number; next: PruneCursor | undefined }> {
  const cursor = input.cursor ?? { i: 0, c: null };
  const { scope } = input;
  let pruned = 0;

  if (input.table === "metricsDaily") {
    const placement = input.placements[cursor.i];
    if (placement === undefined) return { pruned, next: undefined };
    const page = await db
      .query("metricsDaily")
      .withIndex("by_org_account_level_placement_date", (q) =>
        q
          .eq("orgId", scope.orgId)
          .eq("adAccountId", scope.adAccountId)
          .eq("level", input.level)
          .eq("placement", placement)
          .gte("date", input.from)
          .lte("date", input.to),
      )
      .paginate({ numItems: input.limit, cursor: cursor.c });
    for (const row of page.page) {
      if (row.syncedAt < input.before) {
        await db.delete(row._id);
        pruned++;
      }
    }
    if (!page.isDone) return { pruned, next: { i: cursor.i, c: page.continueCursor } };
    return {
      pruned,
      next: cursor.i + 1 < input.placements.length ? { i: cursor.i + 1, c: null } : undefined,
    };
  }

  const page = await db
    .query("actionMetricsDaily")
    .withIndex("by_org_account_date", (q) =>
      q
        .eq("orgId", scope.orgId)
        .eq("adAccountId", scope.adAccountId)
        .gte("date", input.from)
        .lte("date", input.to),
    )
    .paginate({ numItems: input.limit, cursor: cursor.c });
  for (const row of page.page) {
    if (
      row.level === input.level &&
      input.placements.includes(row.placement) &&
      row.syncedAt < input.before
    ) {
      await db.delete(row._id);
      pruned++;
    }
  }
  return { pruned, next: page.isDone ? undefined : { i: 0, c: page.continueCursor } };
}

export type RemovalCursor = {
  step: "count" | "mark";
  c: string | null;
  candidates: number;
  alive: number;
};

/**
 * Removal marking after a COMPLETE full listing: rows not seen since
 * `before` get removedAt (never hard-deleted; status is provider-owned and
 * untouched). Two passes: count, then mark, so the mass-removal safeguard can
 * veto before anything changes.
 */
export async function markRemovedBatch(
  db: DatabaseWriter,
  input: {
    table: "campaigns" | "adGroups" | "ads";
    scope: AccountScope;
    before: number;
    now: number;
    cursor: RemovalCursor | undefined;
    limit: number;
    maxShare: number;
    minCount: number;
  },
): Promise<
  | { status: "continue"; next: RemovalCursor; removed: number }
  | { status: "done"; removed: number }
  | { status: "vetoed"; candidates: number; alive: number }
> {
  const cursor = input.cursor ?? { step: "count", c: null, candidates: 0, alive: 0 };
  const page = await (db as DatabaseReader)
    .query(input.table as "campaigns")
    .withIndex("by_org_account_external", (q) =>
      q.eq("orgId", input.scope.orgId).eq("adAccountId", input.scope.adAccountId),
    )
    .paginate({ numItems: input.limit, cursor: cursor.c });

  const isCandidate = (row: { removedAt?: number; lastSeenAt?: number }) =>
    row.removedAt === undefined && (row.lastSeenAt ?? 0) < input.before;

  if (cursor.step === "count") {
    let { candidates, alive } = cursor;
    for (const row of page.page) {
      if (row.removedAt !== undefined) continue;
      alive++;
      if (isCandidate(row)) candidates++;
    }
    if (!page.isDone) {
      return {
        status: "continue",
        next: { step: "count", c: page.continueCursor, candidates, alive },
        removed: 0,
      };
    }
    if (candidates === 0) return { status: "done", removed: 0 };
    if (candidates > input.minCount && candidates / Math.max(alive, 1) > input.maxShare) {
      return { status: "vetoed", candidates, alive };
    }
    return {
      status: "continue",
      next: { step: "mark", c: null, candidates, alive },
      removed: 0,
    };
  }

  let removed = 0;
  for (const row of page.page) {
    if (isCandidate(row)) {
      await db.patch(row._id, {
        removedAt: input.now,
        updatedAt: input.now,
      });
      removed++;
    }
  }
  if (!page.isDone) {
    return { status: "continue", next: { ...cursor, c: page.continueCursor }, removed };
  }
  return { status: "done", removed };
}

// ---------------------------------------------------------------------------
// Organic social accounts (Phase 10). Natural key: (orgId, platform, externalId).
// Stage A writes only the link path; posts, snapshots and daily rows are Stage B.
// ---------------------------------------------------------------------------

/**
 * Link path: upserts the canonical socialAccounts row of a discovered account and binds it
 * to `connectionId` (mirrors upsertLinkedAdAccount). Existing rows keep their provider
 * metadata except the discovered identity (username, account type).
 */
export async function upsertLinkedSocialAccount(
  db: DatabaseWriter,
  scope: OrgScope,
  record: ProviderDiscoveredSocialAccount,
  connectionId: Id<"connections">,
  now: number,
): Promise<{
  socialAccountId: Id<"socialAccounts">;
  created: boolean;
  previousConnectionId?: Id<"connections">;
}> {
  const row = mapLinkedSocialAccount(record, scope);
  const existing = await db
    .query("socialAccounts")
    .withIndex("by_org_platform_external", (q) =>
      q.eq("orgId", scope.orgId).eq("platform", row.platform).eq("externalId", row.externalId),
    )
    .first();
  if (existing) {
    await db.patch(existing._id, {
      ...(row.username !== undefined ? { username: row.username } : {}),
      accountType: row.accountType,
      status: "active",
      connectionId,
      linkedAt: existing.connectionId === connectionId ? existing.linkedAt : now,
      lastSeenAt: now,
      removedAt: undefined,
      updatedAt: now,
    });
    return {
      socialAccountId: existing._id,
      created: false,
      ...(existing.connectionId !== undefined
        ? { previousConnectionId: existing.connectionId }
        : {}),
    };
  }
  const socialAccountId = await db.insert("socialAccounts", {
    ...row,
    connectionId,
    linkedAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return { socialAccountId, created: true };
}
