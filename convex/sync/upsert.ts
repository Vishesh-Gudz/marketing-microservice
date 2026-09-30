import type { Infer } from "convex/values";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import type { EntityLevel, Placement } from "../domain/types";
import { todayIn, type DateKey } from "../lib/dates";
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
import type { AccountScope, OrgScope, SocialAccountScope } from "../mapping/scope";
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
import type {
  ProviderDiscoveredSocialAccount,
  ProviderSocialAccount,
  ProviderSocialAccountDay,
  ProviderSocialPost,
  ProviderSocialPostSnapshot,
} from "../providers/social/types";
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
 *   socialAccounts             (orgId, platform, externalId)
 *   socialPosts                (orgId, socialAccountId, externalId)
 *   socialPostMetricSnapshots  (orgId, postId, capturedDate)
 *   socialAccountMetricsDaily  (orgId, socialAccountId, date) — column-group replace
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
// Organic social (Phase 10). socialAccounts natural key: (orgId, platform, externalId).
// Stage A: the link path. Stage B: the sync write path below (preflight refresh + follower
// capture, posts, lifetime snapshots, account days with column groups, post removal).
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

/** Account-type drift (F11): business <-> creator must never change silently. */
export type SocialAccountDrift = "account_type";

export function socialAccountDrift(
  account: Doc<"socialAccounts">,
  record: ProviderSocialAccount,
): SocialAccountDrift | undefined {
  return record.accountType !== account.accountType ? "account_type" : undefined;
}

/**
 * socialAccountMetricsDaily has TWO column groups with independent writers (I-D12, F7).
 * A writer replaces ONLY its own group: a column absent from its new values is cleared,
 * nothing is ever incremented, and the other group's columns are never touched.
 *   profile   written by the sync preflight (follower capture, today's UTC day)
 *   insights  written by fetchAccountMetrics (one record per requested UTC day)
 * profileViews / websiteClicks belong to neither group: deprecated, never written (and
 * cleared whenever a group rewrites the row). syncedAt = last write of either group.
 */
export const SOCIAL_DAY_COLUMN_GROUPS = {
  profile: ["followers", "followersCapturedAt"],
  insights: [
    "followerDelta",
    "reach",
    "views",
    "accountsEngaged",
    "totalInteractions",
    "extras",
    "insightsSyncedAt",
  ],
} as const;

const DEPRECATED_DAY_COLUMNS = ["profileViews", "websiteClicks"] as const;

type DayRow = Doc<"socialAccountMetricsDaily">;
type DayGroup = keyof typeof SOCIAL_DAY_COLUMN_GROUPS;

async function findSocialDay(
  db: DatabaseWriter,
  scope: SocialAccountScope,
  date: DateKey,
  counts: SyncCounts,
): Promise<DayRow | null> {
  const rows = await db
    .query("socialAccountMetricsDaily")
    .withIndex("by_org_account_date", (q) =>
      q.eq("orgId", scope.orgId).eq("socialAccountId", scope.socialAccountId).eq("date", date),
    )
    .take(KEY_SCAN);
  return await keepOldest(db, rows, counts);
}

/** Replaces ONE column group of a day row (insert when the day has no row yet). */
async function writeDayGroup(
  db: DatabaseWriter,
  scope: SocialAccountScope,
  date: DateKey,
  group: DayGroup,
  values: Partial<DayRow>,
  now: number,
  counts: SyncCounts,
): Promise<void> {
  const existing = await findSocialDay(db, scope, date, counts);
  const owned = new Set<string>([...SOCIAL_DAY_COLUMN_GROUPS[group], ...DEPRECATED_DAY_COLUMNS]);
  const kept = Object.fromEntries(
    Object.entries(existing ?? {}).filter(
      ([key]) => key !== "_id" && key !== "_creationTime" && !owned.has(key),
    ),
  );
  const row = withoutUndefined({
    ...kept,
    orgId: scope.orgId,
    socialAccountId: scope.socialAccountId,
    platform: scope.platform,
    date,
    ...values,
    syncedAt: now,
  }) as Omit<DayRow, "_id" | "_creationTime">;
  if (existing) {
    await db.replace(existing._id, row);
    counts.updated++;
  } else {
    await db.insert("socialAccountMetricsDaily", row);
    counts.inserted++;
  }
  counts.metricRows++;
}

/**
 * Sync preflight: replaces the provider-owned account fields (name, username,
 * followersCount, status, attributes) and captures the follower count into today's UTC
 * day row (profile column group, as of capture [IR15]). The caller must have checked
 * `socialAccountDrift` first. Never writes a URL (F1: profilePictureUrl is cleared).
 */
export async function refreshSocialAccount(
  db: DatabaseWriter,
  account: Doc<"socialAccounts">,
  scope: SocialAccountScope,
  record: ProviderSocialAccount,
  now: number,
): Promise<SyncCounts> {
  const counts = emptyCounts();
  counts.records = 1;
  const capped = applyCaps({ attributes: record.attributes });
  counts.truncated += capped.truncated;
  await db.patch(account._id, {
    name: record.name,
    username: record.username,
    followersCount: record.followersCount,
    status: record.status,
    attributes: capped.value.attributes,
    profilePictureUrl: undefined,
    lastSeenAt: now,
    removedAt: undefined,
    updatedAt: now,
  });
  if (account.removedAt !== undefined) counts.reappeared++;
  counts.updated++;
  await writeDayGroup(
    db,
    scope,
    todayIn("UTC", now),
    "profile",
    { followers: record.followersCount, followersCapturedAt: now },
    now,
    counts,
  );
  return counts;
}

/**
 * Listing page: upserts posts by (orgId, socialAccountId, externalId), replacing the
 * provider-owned fields and clearing a previous removal. `known` counts records that
 * already existed un-removed (for the incremental early stop, F9).
 */
export async function writeSocialPostPage(
  db: DatabaseWriter,
  scope: SocialAccountScope,
  items: readonly ProviderSocialPost[],
  now: number,
): Promise<{ counts: SyncCounts; known: number }> {
  const counts = emptyCounts();
  counts.records += items.length;
  let known = 0;
  for (const record of items) {
    const existing = await keepOldest(
      db,
      await db
        .query("socialPosts")
        .withIndex("by_org_account_external", (q) =>
          q
            .eq("orgId", scope.orgId)
            .eq("socialAccountId", scope.socialAccountId)
            .eq("externalId", record.externalId),
        )
        .take(KEY_SCAN),
      counts,
    );
    const row = withoutUndefined({
      orgId: scope.orgId,
      socialAccountId: scope.socialAccountId,
      platform: scope.platform,
      externalId: record.externalId,
      type: record.type,
      caption: record.caption,
      permalink: record.permalink,
      publishedAt: record.publishedAt,
      lastSeenAt: now,
      updatedAt: now,
    });
    if (existing) {
      if (existing.removedAt !== undefined) counts.reappeared++;
      else known++;
      // Replacing clears removedAt and never keeps a URL other than the permalink.
      await db.replace(existing._id, { ...row, createdAt: existing.createdAt });
      counts.updated++;
    } else {
      await db.insert("socialPosts", { ...row, createdAt: now });
      counts.inserted++;
    }
  }
  return { counts, known };
}

/**
 * Snapshot page: one row per (post, UTC capture day), replaced (the last capture of a day
 * wins). A snapshot of a post that is not stored yet is skipped and counted unresolved
 * (F8: a post is never created from a snapshot).
 */
export async function writeSocialSnapshotPage(
  db: DatabaseWriter,
  scope: SocialAccountScope,
  items: readonly ProviderSocialPostSnapshot[],
): Promise<SyncCounts> {
  const counts = emptyCounts();
  counts.records += items.length;
  for (const record of items) {
    const post = await db
      .query("socialPosts")
      .withIndex("by_org_account_external", (q) =>
        q
          .eq("orgId", scope.orgId)
          .eq("socialAccountId", scope.socialAccountId)
          .eq("externalId", record.postExternalId),
      )
      .first();
    if (post === null) {
      counts.unresolved++;
      continue;
    }
    const { accountExternalId: _account, postExternalId: _post, ...metrics } = record;
    const row = withoutUndefined({
      ...metrics,
      orgId: scope.orgId,
      socialAccountId: scope.socialAccountId,
      postId: post._id,
      platform: scope.platform,
    });
    const existing = await keepOldest(
      db,
      await db
        .query("socialPostMetricSnapshots")
        .withIndex("by_org_post_date", (q) =>
          q.eq("orgId", scope.orgId).eq("postId", post._id).eq("capturedDate", row.capturedDate),
        )
        .take(KEY_SCAN),
      counts,
    );
    if (existing) {
      await db.replace(existing._id, row);
      counts.updated++;
    } else {
      await db.insert("socialPostMetricSnapshots", row);
      counts.inserted++;
    }
    counts.metricRows++;
  }
  return counts;
}

/** Account-day page: replaces the INSIGHTS column group of every day (also empty days). */
export async function writeSocialAccountDayPage(
  db: DatabaseWriter,
  scope: SocialAccountScope,
  items: readonly ProviderSocialAccountDay[],
  now: number,
): Promise<SyncCounts> {
  const counts = emptyCounts();
  counts.records += items.length;
  for (const record of items) {
    const { accountExternalId: _account, platform: _platform, date, ...insights } = record;
    const capped = applyCaps(insights);
    counts.truncated += capped.truncated;
    await writeDayGroup(
      db,
      scope,
      date,
      "insights",
      { ...capped.value, insightsSyncedAt: now },
      now,
      counts,
    );
  }
  return counts;
}

export type SocialRemovalCursor = {
  step: "bound" | "count" | "mark";
  c: string | null;
  /** publishedAt of the oldest post this listing saw (lastSeenAt >= before). */
  bound?: number;
  candidates: number;
  alive: number;
};

/**
 * Bounded removal marking after a COMPLETE, fully resolved full listing (I-D13, R3, R5):
 * only posts published AFTER the oldest post the listing actually ingested can be marked
 * (the platform lists at most the most recent media; anything older is never inferred to be
 * deleted). Three passes, each one bounded batch per call:
 *   bound  the oldest post seen by this listing (none seen -> nothing is marked)
 *   count  un-removed posts newer than the bound, and the unseen ones among them
 *   mark   set removedAt on the unseen ones (never hard-deleted)
 * The mass-removal veto (maxShare AND minCount, as for ad entities) can skip marking.
 */
export async function markRemovedSocialPostsBatch(
  db: DatabaseWriter,
  input: {
    scope: SocialAccountScope;
    before: number;
    now: number;
    cursor: SocialRemovalCursor | undefined;
    limit: number;
    maxShare: number;
    minCount: number;
  },
): Promise<
  | { status: "continue"; next: SocialRemovalCursor; removed: number }
  | { status: "done"; removed: number }
  | { status: "vetoed"; candidates: number; alive: number }
> {
  const { scope } = input;
  const cursor: SocialRemovalCursor = input.cursor ?? {
    step: "bound",
    c: null,
    candidates: 0,
    alive: 0,
  };
  const seen = (row: Doc<"socialPosts">) => (row.lastSeenAt ?? 0) >= input.before;

  if (cursor.step === "bound") {
    const page = await db
      .query("socialPosts")
      .withIndex("by_org_account_published", (q) =>
        q.eq("orgId", scope.orgId).eq("socialAccountId", scope.socialAccountId),
      )
      .paginate({ numItems: input.limit, cursor: cursor.c });
    const oldestSeen = page.page.find(seen);
    if (oldestSeen !== undefined) {
      return {
        status: "continue",
        next: { step: "count", c: null, bound: oldestSeen.publishedAt, candidates: 0, alive: 0 },
        removed: 0,
      };
    }
    if (page.isDone) return { status: "done", removed: 0 };
    return { status: "continue", next: { ...cursor, c: page.continueCursor }, removed: 0 };
  }

  const bound = cursor.bound!;
  const page = await db
    .query("socialPosts")
    .withIndex("by_org_account_published", (q) =>
      q
        .eq("orgId", scope.orgId)
        .eq("socialAccountId", scope.socialAccountId)
        .gt("publishedAt", bound),
    )
    .paginate({ numItems: input.limit, cursor: cursor.c });
  const isCandidate = (row: Doc<"socialPosts">) => row.removedAt === undefined && !seen(row);

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
        next: { ...cursor, c: page.continueCursor, candidates, alive },
        removed: 0,
      };
    }
    if (candidates === 0) return { status: "done", removed: 0 };
    if (candidates > input.minCount && candidates / Math.max(alive, 1) > input.maxShare) {
      return { status: "vetoed", candidates, alive };
    }
    return {
      status: "continue",
      next: { step: "mark", c: null, bound, candidates, alive },
      removed: 0,
    };
  }

  let removed = 0;
  for (const row of page.page) {
    if (isCandidate(row)) {
      await db.patch(row._id, { removedAt: input.now, updatedAt: input.now });
      removed++;
    }
  }
  if (!page.isDone) {
    return { status: "continue", next: { ...cursor, c: page.continueCursor }, removed };
  }
  return { status: "done", removed };
}
