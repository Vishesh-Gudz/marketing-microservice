import type { Doc, Id } from "../_generated/dataModel";
import { PLACEMENTS, type ActionType, type AdPlatform, type EntityLevel } from "../domain/types";
import { apiError } from "../lib/errors";
import { fingerprint } from "../providers/hash";
import { aggregateActions, type ActionGroup } from "./actions";
import { MetricAccumulator, type AggregateValues } from "./aggregate";
import { compareAggregates, type Deltas } from "./comparison";
import { ANALYTICS_LIMITS } from "./config";
import {
  capabilitiesOf,
  coverageSummary,
  dataStateOf,
  loadCoverage,
  supports,
  type AccountCoverage,
  type DataState,
  type Requirement,
} from "./coverage";
import { FxConverter, loadRateTable } from "./fx";
import {
  bucketKey,
  bucketsOf,
  previousPeriod,
  rangeProblem,
  type Bucket,
  type DateRange,
  type Granularity,
} from "./periods";
import {
  accountLevelActionRows,
  accountLevelRows,
  campaignLevelRows,
  entityActionRows,
  entityRows,
  ReadBudget,
} from "./reader";
import { ownedEntity, scopedAccounts, type AccountFilters, type TenantCtx } from "./scope";

/**
 * The five analytics read operations behind `convex/v1/analytics.ts`.
 * Query-time aggregation over the canonical Phase 2 rows only: no providers,
 * no credentials, no writes. Every read is tenant-scoped and budgeted.
 */

export type Aggregate = { dataState: DataState; values: AggregateValues };
export type CoverageResult = {
  dataState: DataState;
  accounts: ReturnType<typeof coverageSummary>;
};
export type FxResult = ReturnType<FxConverter["status"]>;
export type Comparison = { range: DateRange; previous: Aggregate; deltas: Deltas };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function loadOrg(ctx: TenantCtx): Promise<Doc<"organizations">> {
  const org = await ctx.db.get(ctx.tenant.orgId);
  if (org === null) throw apiError("INTERNAL", "Resolved organization is missing.");
  return org;
}

/** Validation depends on the supplied range only; queries never read the clock (D5). */
function validRange(range: DateRange, field: string): DateRange {
  const problem = rangeProblem(range, { maxDays: ANALYTICS_LIMITS.maxRangeDays });
  if (problem !== undefined) {
    throw apiError("INVALID_ARGUMENT", `Invalid date range (${problem}).`, {
      field,
      reason: problem,
    });
  }
  return { from: range.from, to: range.to };
}

export type CompareArg = "previous_period" | DateRange;

function comparisonRange(compare: CompareArg | undefined, range: DateRange): DateRange | undefined {
  if (compare === undefined) return undefined;
  if (compare === "previous_period") return previousPeriod(range);
  return validRange(compare, "compare");
}

function union(a: DateRange, b: DateRange | undefined): DateRange {
  if (b === undefined) return a;
  return { from: a.from < b.from ? a.from : b.from, to: a.to > b.to ? a.to : b.to };
}

function aggregate(
  rows: readonly Doc<"metricsDaily">[],
  fx: FxConverter,
  coverages: readonly AccountCoverage[],
  range: DateRange,
): Aggregate {
  const acc = new MetricAccumulator();
  for (const row of rows) acc.add(row);
  return { dataState: dataStateOf(acc.rows > 0, coverages, range), values: acc.summarize(fx) };
}

function compared(current: Aggregate, previous: Aggregate, range: DateRange): Comparison {
  return {
    range,
    previous,
    deltas: compareAggregates(
      { ...current.values, partial: current.dataState === "partial" },
      { ...previous.values, partial: previous.dataState === "partial" },
    ),
  };
}

async function fxFor(
  ctx: TenantCtx,
  org: Doc<"organizations">,
  accounts: readonly Doc<"adAccounts">[],
  range: DateRange,
): Promise<FxConverter> {
  const table = await loadRateTable(
    ctx.db,
    accounts.map((a) => a.currency),
    org.reportingCurrency,
    range,
  );
  return new FxConverter(org.reportingCurrency, table);
}

function coverageResult(
  hasRows: boolean,
  coverages: readonly AccountCoverage[],
  range: DateRange,
): CoverageResult {
  return {
    dataState: dataStateOf(hasRows, coverages, range),
    accounts: coverageSummary(coverages, range),
  };
}

const orgCtx = (ctx: TenantCtx) => ({ db: ctx.db, orgId: ctx.tenant.orgId });

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

export type OverviewArgs = { range: DateRange; compare?: CompareArg; filters?: AccountFilters };

export async function overview(ctx: TenantCtx, args: OverviewArgs) {
  const org = await loadOrg(ctx);
  const range = validRange(args.range, "range");
  const previousRange = comparisonRange(args.compare, range);
  const budget = ReadBudget.metrics();
  const accounts = await scopedAccounts(ctx, args.filters, budget);

  const rows: Doc<"metricsDaily">[] = [];
  const previousRows: Doc<"metricsDaily">[] = [];
  for (const account of accounts) {
    rows.push(
      ...(await accountLevelRows(orgCtx(ctx), budget, account._id, "account", "all", range)),
    );
    if (previousRange) {
      previousRows.push(
        ...(await accountLevelRows(
          orgCtx(ctx),
          budget,
          account._id,
          "account",
          "all",
          previousRange,
        )),
      );
    }
  }
  const coverages = await loadCoverage(ctx.db, ctx.tenant.orgId, accounts, {
    kind: "level",
    level: "account",
  });
  const fx = await fxFor(ctx, org, accounts, union(range, previousRange));
  const totals = aggregate(rows, fx, coverages, range);
  const comparison = previousRange
    ? compared(totals, aggregate(previousRows, fx, coverages, previousRange), previousRange)
    : undefined;
  return {
    range,
    accountCount: accounts.length,
    totals,
    ...(comparison ? { comparison } : {}),
    coverage: coverageResult(rows.length > 0, coverages, range),
    fx: fx.status(),
  };
}

// ---------------------------------------------------------------------------
// timeSeries
// ---------------------------------------------------------------------------

export type TimeSeriesArgs = {
  range: DateRange;
  granularity: Granularity;
  filters?: AccountFilters;
  entity?: { level: EntityLevel; id: string };
};

export async function timeSeries(ctx: TenantCtx, args: TimeSeriesArgs) {
  const org = await loadOrg(ctx);
  const range = validRange(args.range, "range");
  const budget = ReadBudget.metrics();

  let accounts: Doc<"adAccounts">[];
  let rows: Doc<"metricsDaily">[];
  let level: EntityLevel = "account";
  if (args.entity !== undefined) {
    if (args.filters !== undefined) {
      throw apiError("INVALID_ARGUMENT", "filters cannot be combined with entity.", {
        field: "filters",
      });
    }
    const { entity, account } = await ownedEntity(ctx, args.entity.level, args.entity.id);
    level = args.entity.level;
    accounts = [account];
    rows = await entityRows(orgCtx(ctx), budget, entity._id, "all", range);
  } else {
    accounts = await scopedAccounts(ctx, args.filters, budget);
    rows = [];
    for (const account of accounts) {
      rows.push(
        ...(await accountLevelRows(orgCtx(ctx), budget, account._id, "account", "all", range)),
      );
    }
  }

  const coverages = await loadCoverage(ctx.db, ctx.tenant.orgId, accounts, {
    kind: "level",
    level,
  });
  const fx = await fxFor(ctx, org, accounts, range);
  const byBucket = new Map<string, Doc<"metricsDaily">[]>();
  for (const row of rows) {
    const key = bucketKey(row.date, args.granularity);
    const list = byBucket.get(key) ?? [];
    list.push(row);
    byBucket.set(key, list);
  }
  const points = bucketsOf(range, args.granularity).map((bucket: Bucket) => ({
    ...bucket,
    ...aggregate(byBucket.get(bucket.key) ?? [], fx, coverages, bucket),
  }));
  return {
    range,
    granularity: args.granularity,
    level,
    points,
    coverage: coverageResult(rows.length > 0, coverages, range),
    fx: fx.status(),
  };
}

// ---------------------------------------------------------------------------
// performance
// ---------------------------------------------------------------------------

export type PerformanceLevel = "campaign" | "ad_group" | "ad";
export type SortBy = "spend" | "impressions" | "clicks" | "conversions" | "name";
export type PerformanceArgs = {
  level: PerformanceLevel;
  range: DateRange;
  parent?: { accountId?: string; campaignId?: string; adGroupId?: string };
  filters?: AccountFilters;
  sort?: { by: SortBy; dir?: "asc" | "desc" };
  compare?: CompareArg;
  paginationOpts: { numItems: number; cursor: string | null };
};

export type EntitySummary = {
  id: string;
  level: PerformanceLevel;
  externalId: string;
  name: string;
  platform: AdPlatform;
  status: Doc<"campaigns">["status"];
  deliveryStatus?: Doc<"campaigns">["deliveryStatus"];
  accountId: string;
  campaignId?: string;
  adGroupId?: string;
  currency: string;
  removed: boolean;
  objective?: Doc<"campaigns">["objective"];
  channelType?: Doc<"campaigns">["channelType"];
  budgetType?: Doc<"campaigns">["budgetType"];
  budgetMicros?: bigint;
};

export type PerformanceRow = { entity: EntitySummary; current: Aggregate; comparison?: Comparison };

function parentProblem(
  level: PerformanceLevel,
  parent: PerformanceArgs["parent"],
): string | undefined {
  const keys = Object.entries(parent ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
  if (keys.length > 1) return "Provide at most one parent id.";
  const key = keys[0];
  switch (level) {
    case "campaign":
      return key === undefined || key === "accountId"
        ? undefined
        : "Campaigns can be scoped by accountId only.";
    case "ad_group":
      return key === "campaignId" ? undefined : "Ad groups require parent.campaignId.";
    case "ad":
      return key === "campaignId" || key === "adGroupId"
        ? undefined
        : "Ads require parent.campaignId or parent.adGroupId.";
  }
}

type EntityDoc = Doc<"campaigns"> | Doc<"adGroups"> | Doc<"ads">;

type PerformanceScope = {
  accounts: Doc<"adAccounts">[];
  /** Every entity of the requested level in the scope (each gets a row, with or without delivery). */
  entities: EntityDoc[];
  readRows(range: DateRange): Promise<Doc<"metricsDaily">[]>;
};

/**
 * Resolves the scoped entity set ONCE (entity documents are charged to the read
 * budget) and how to read its rows for a range. Removed entities are included
 * (flagged `removed`); entities without rows get dataState no_delivery/unknown/partial.
 */
async function performanceScope(
  ctx: TenantCtx,
  args: PerformanceArgs,
  budget: ReadBudget,
): Promise<PerformanceScope> {
  const parent = args.parent ?? {};
  const level = args.level;
  const org = orgCtx(ctx);

  if (parent.adGroupId !== undefined) {
    const { entity, account } = await ownedEntity(ctx, "ad_group", parent.adGroupId);
    const ads = await budget.take(
      ctx.db
        .query("ads")
        .withIndex("by_org_adGroup", (q) =>
          q.eq("orgId", ctx.tenant.orgId).eq("adGroupId", entity._id as Id<"adGroups">),
        ),
    );
    return {
      accounts: [account],
      entities: ads,
      readRows: async (range) => {
        const rows: Doc<"metricsDaily">[] = [];
        for (const ad of ads) rows.push(...(await entityRows(org, budget, ad._id, "all", range)));
        return rows;
      },
    };
  }

  if (parent.campaignId !== undefined) {
    const { entity, account } = await ownedEntity(ctx, "campaign", parent.campaignId);
    const campaignId = entity._id as Id<"campaigns">;
    const entities: EntityDoc[] =
      level === "ad_group"
        ? await budget.take(
            ctx.db
              .query("adGroups")
              .withIndex("by_org_campaign", (q) =>
                q.eq("orgId", ctx.tenant.orgId).eq("campaignId", campaignId),
              ),
          )
        : await budget.take(
            ctx.db
              .query("ads")
              .withIndex("by_org_campaign", (q) =>
                q.eq("orgId", ctx.tenant.orgId).eq("campaignId", campaignId),
              ),
          );
    return {
      accounts: [account],
      entities,
      readRows: (range) => campaignLevelRows(org, budget, campaignId, level, "all", range),
    };
  }

  // Campaigns of one account (parent.accountId) or of every scoped account.
  const accounts =
    parent.accountId !== undefined
      ? [(await ownedEntity(ctx, "account", parent.accountId)).account]
      : await scopedAccounts(ctx, args.filters, budget);
  const entities: EntityDoc[] = [];
  for (const account of accounts) {
    entities.push(
      ...(await budget.take(
        ctx.db
          .query("campaigns")
          .withIndex("by_org_account_external", (q) =>
            q.eq("orgId", ctx.tenant.orgId).eq("adAccountId", account._id),
          ),
      )),
    );
  }
  return {
    accounts,
    entities,
    readRows: async (range) => {
      const rows: Doc<"metricsDaily">[] = [];
      for (const account of accounts) {
        rows.push(...(await accountLevelRows(org, budget, account._id, level, "all", range)));
      }
      return rows;
    },
  };
}

function summaryOf(
  level: PerformanceLevel,
  doc: Doc<"campaigns"> | Doc<"adGroups"> | Doc<"ads">,
  account: Doc<"adAccounts">,
): EntitySummary {
  const base: EntitySummary = {
    id: doc._id,
    level,
    externalId: doc.externalId,
    name: doc.name,
    platform: doc.platform,
    status: doc.status,
    ...(doc.deliveryStatus !== undefined ? { deliveryStatus: doc.deliveryStatus } : {}),
    accountId: doc.adAccountId,
    currency: account.currency,
    removed: doc.removedAt !== undefined,
  };
  if (level === "campaign") {
    const c = doc as Doc<"campaigns">;
    return {
      ...base,
      objective: c.objective,
      ...(c.channelType !== undefined ? { channelType: c.channelType } : {}),
      budgetType: c.budgetType,
      ...(c.budgetMicros !== undefined ? { budgetMicros: c.budgetMicros } : {}),
    };
  }
  if (level === "ad_group") {
    return { ...base, campaignId: (doc as Doc<"adGroups">).campaignId };
  }
  const ad = doc as Doc<"ads">;
  return {
    ...base,
    campaignId: ad.campaignId,
    ...(ad.adGroupId !== undefined ? { adGroupId: ad.adGroupId } : {}),
  };
}

function sortValue(row: PerformanceRow, by: SortBy): bigint | string | undefined {
  const values = row.current.values;
  switch (by) {
    case "name":
      return row.entity.name;
    case "spend":
      return values.money.spendMicros?.reporting;
    case "impressions":
      return values.numbers.impressions;
    case "clicks":
      return values.numbers.clicks;
    case "conversions":
      return values.numbers.conversions;
  }
}

function compareRows(sort: { by: SortBy; dir: "asc" | "desc" }) {
  return (a: PerformanceRow, b: PerformanceRow) => {
    const x = sortValue(a, sort.by);
    const y = sortValue(b, sort.by);
    // Rows without a value (not reported, or no reporting-currency spend) always sort last.
    if (x === undefined || y === undefined) {
      if (x !== y) return x === undefined ? 1 : -1;
    } else if (x !== y) {
      const order = x < y ? -1 : 1;
      return sort.dir === "asc" ? order : -order;
    }
    if (a.entity.name !== b.entity.name) return a.entity.name < b.entity.name ? -1 : 1;
    return a.entity.id < b.entity.id ? -1 : a.entity.id > b.entity.id ? 1 : 0;
  };
}

export async function performance(ctx: TenantCtx, args: PerformanceArgs) {
  const org = await loadOrg(ctx);
  const range = validRange(args.range, "range");
  const previousRange = comparisonRange(args.compare, range);
  const problem = parentProblem(args.level, args.parent);
  if (problem !== undefined) throw apiError("INVALID_ARGUMENT", problem, { field: "parent" });
  if (args.parent !== undefined && args.filters !== undefined) {
    throw apiError("INVALID_ARGUMENT", "filters cannot be combined with parent.", {
      field: "filters",
    });
  }
  const sort = {
    by: args.sort?.by ?? "spend",
    dir: args.sort?.dir ?? (args.sort?.by === "name" ? "asc" : "desc"),
  } as const;
  const numItems = Math.max(
    1,
    Math.min(Math.floor(args.paginationOpts.numItems), ANALYTICS_LIMITS.maxPageSize),
  );
  const requestKey = fingerprint([
    args.level,
    range,
    args.parent ?? null,
    args.filters ?? null,
    sort,
    previousRange ?? null,
  ]);
  let offset = 0;
  if (args.paginationOpts.cursor) {
    const match = /^([0-9a-z]+)\.(\d{1,7})$/.exec(args.paginationOpts.cursor);
    if (!match || match[1] !== requestKey) {
      throw apiError("INVALID_ARGUMENT", "The cursor belongs to a different request.", {
        field: "paginationOpts.cursor",
      });
    }
    offset = Number(match[2]);
  }

  const budget = ReadBudget.metrics();
  const scope = await performanceScope(ctx, args, budget);
  const currentRows = await scope.readRows(range);
  const previousRows = previousRange ? await scope.readRows(previousRange) : [];

  const byEntity = (rows: readonly Doc<"metricsDaily">[]) => {
    const map = new Map<string, Doc<"metricsDaily">[]>();
    for (const row of rows) {
      const list = map.get(row.entityId) ?? [];
      list.push(row);
      map.set(row.entityId, list);
    }
    return map;
  };
  const currentByEntity = byEntity(currentRows);
  const previousByEntity = byEntity(previousRows);

  const accountsById = new Map(scope.accounts.map((a) => [a._id as string, a]));
  const coverages = await loadCoverage(ctx.db, ctx.tenant.orgId, scope.accounts, {
    kind: "level",
    level: args.level,
  });
  const coverageByAccount = new Map(coverages.map((c) => [c.accountId as string, c]));
  const fx = await fxFor(ctx, org, scope.accounts, union(range, previousRange));

  const rows: PerformanceRow[] = [];
  for (const doc of scope.entities) {
    // Defense in depth: entity documents come from org-scoped index reads.
    if (doc.orgId !== ctx.tenant.orgId) continue;
    const account = accountsById.get(doc.adAccountId);
    if (account === undefined) continue;
    const coverage = coverageByAccount.get(account._id) ?? {
      accountId: account._id,
      supported: supports(account.platform, { kind: "level", level: args.level }),
    };
    const entityCurrent = aggregate(currentByEntity.get(doc._id) ?? [], fx, [coverage], range);
    const row: PerformanceRow = {
      entity: summaryOf(args.level, doc, account),
      current: entityCurrent,
    };
    if (previousRange) {
      row.comparison = compared(
        entityCurrent,
        aggregate(previousByEntity.get(doc._id) ?? [], fx, [coverage], previousRange),
        previousRange,
      );
    }
    rows.push(row);
  }
  rows.sort(compareRows(sort));
  const page = rows.slice(offset, offset + numItems);
  const next = offset + page.length;
  return {
    page,
    isDone: next >= rows.length,
    continueCursor: `${requestKey}.${next}`,
    range,
    fx: fx.status(),
  };
}

// ---------------------------------------------------------------------------
// breakdown
// ---------------------------------------------------------------------------

export type BreakdownBy = "platform" | "account" | "placement";
export type BreakdownArgs = {
  by: BreakdownBy;
  range: DateRange;
  level?: EntityLevel;
  filters?: AccountFilters;
};

export async function breakdown(ctx: TenantCtx, args: BreakdownArgs) {
  const org = await loadOrg(ctx);
  const range = validRange(args.range, "range");
  const level = args.level ?? "account";
  if (args.by !== "placement" && level !== "account") {
    throw apiError("INVALID_ARGUMENT", "Only placement breakdowns accept a level.", {
      field: "level",
    });
  }
  const budget = ReadBudget.metrics();
  const accounts = await scopedAccounts(ctx, args.filters, budget);
  const requirement: Requirement =
    args.by === "placement" ? { kind: "placement", level } : { kind: "level", level };
  const coverages = await loadCoverage(ctx.db, ctx.tenant.orgId, accounts, requirement);
  const supported = accounts.filter((_, i) => coverages[i]!.supported);
  const fx = await fxFor(ctx, org, accounts, range);

  const groups: {
    key: string;
    platform?: AdPlatform;
    accountId?: string;
    placement?: (typeof PLACEMENTS)[number];
    aggregate: Aggregate;
  }[] = [];

  if (args.by === "placement") {
    const rowsByPlacement = new Map<string, Doc<"metricsDaily">[]>();
    for (const account of supported) {
      for (const placement of PLACEMENTS) {
        if (placement === "all") continue;
        const rows = await accountLevelRows(
          orgCtx(ctx),
          budget,
          account._id,
          level,
          placement,
          range,
        );
        if (rows.length > 0)
          rowsByPlacement.set(placement, [...(rowsByPlacement.get(placement) ?? []), ...rows]);
      }
    }
    // Every placement a supported provider can report is listed (no rows = no_delivery/unknown).
    const reportable = new Set(
      supported.flatMap((a) => capabilitiesOf(a.platform)?.placements ?? []),
    );
    for (const placement of PLACEMENTS) {
      if (placement === "all") continue;
      const rows = rowsByPlacement.get(placement);
      if (rows === undefined && !reportable.has(placement)) continue;
      groups.push({
        key: placement,
        placement,
        aggregate: aggregate(rows ?? [], fx, coverages, range),
      });
    }
    return {
      by: args.by,
      level,
      range,
      groups,
      coverage: coverageResult(rowsByPlacement.size > 0, coverages, range),
      fx: fx.status(),
    };
  }

  const rowsByAccount = new Map<string, Doc<"metricsDaily">[]>();
  for (const account of supported) {
    rowsByAccount.set(
      account._id,
      await accountLevelRows(orgCtx(ctx), budget, account._id, "account", "all", range),
    );
  }
  if (args.by === "account") {
    accounts.forEach((account, i) => {
      groups.push({
        key: account._id,
        accountId: account._id,
        platform: account.platform,
        aggregate: aggregate(rowsByAccount.get(account._id) ?? [], fx, [coverages[i]!], range),
      });
    });
  } else {
    for (const platform of [...new Set(accounts.map((a) => a.platform))].sort()) {
      const indexes = accounts
        .map((a, i) => (a.platform === platform ? i : -1))
        .filter((i) => i >= 0);
      const rows = indexes.flatMap((i) => rowsByAccount.get(accounts[i]!._id) ?? []);
      groups.push({
        key: platform,
        platform,
        aggregate: aggregate(
          rows,
          fx,
          indexes.map((i) => coverages[i]!),
          range,
        ),
      });
    }
  }
  const hasRows = [...rowsByAccount.values()].some((rows) => rows.length > 0);
  return {
    by: args.by,
    level,
    range,
    groups,
    coverage: coverageResult(hasRows, coverages, range),
    fx: fx.status(),
  };
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

export type ActionsArgs = {
  range: DateRange;
  level?: EntityLevel;
  entity?: { level: EntityLevel; id: string };
  filters?: AccountFilters & {
    actionTypes?: ActionType[];
    attributionWindows?: string[];
    primaryOnly?: boolean;
  };
};

export async function actions(ctx: TenantCtx, args: ActionsArgs) {
  const org = await loadOrg(ctx);
  const range = validRange(args.range, "range");
  const actionBudget = ReadBudget.actions();
  const metricBudget = ReadBudget.metrics();
  const { actionTypes, attributionWindows, primaryOnly, ...accountFilters } = args.filters ?? {};

  let level: EntityLevel = args.level ?? "account";
  let accounts: Doc<"adAccounts">[];
  let actionRows: Doc<"actionMetricsDaily">[] = [];
  let spendRows: Doc<"metricsDaily">[] = [];
  if (args.entity !== undefined) {
    if (args.level !== undefined && args.level !== args.entity.level) {
      throw apiError("INVALID_ARGUMENT", "level must match entity.level.", { field: "level" });
    }
    if (accountFilters.platforms !== undefined || accountFilters.accountIds !== undefined) {
      throw apiError("INVALID_ARGUMENT", "Account filters cannot be combined with entity.", {
        field: "filters",
      });
    }
    level = args.entity.level;
    const { entity, account } = await ownedEntity(ctx, level, args.entity.id);
    accounts = [account];
    if (supports(account.platform, { kind: "actions", level })) {
      actionRows = await entityActionRows(orgCtx(ctx), actionBudget, entity._id, range);
      spendRows = await entityRows(orgCtx(ctx), metricBudget, entity._id, "all", range);
    }
  } else {
    accounts = await scopedAccounts(
      ctx,
      Object.keys(accountFilters).length > 0 ? accountFilters : undefined,
      metricBudget,
    );
    for (const account of accounts) {
      if (!supports(account.platform, { kind: "actions", level })) continue;
      actionRows.push(
        ...(await accountLevelActionRows(orgCtx(ctx), actionBudget, account._id, level, range)),
      );
      spendRows.push(
        ...(await accountLevelRows(orgCtx(ctx), metricBudget, account._id, level, "all", range)),
      );
    }
  }

  const types = actionTypes === undefined ? undefined : new Set(actionTypes);
  const windows = attributionWindows === undefined ? undefined : new Set(attributionWindows);
  const filtered = actionRows.filter(
    (row) =>
      (types === undefined || types.has(row.actionType)) &&
      (windows === undefined || windows.has(row.attributionWindow)) &&
      (primaryOnly !== true || row.isPrimary === true),
  );
  const coverages = await loadCoverage(ctx.db, ctx.tenant.orgId, accounts, {
    kind: "actions",
    level,
  });
  const fx = await fxFor(ctx, org, accounts, range);
  const groups: ActionGroup[] = aggregateActions(filtered, spendRows, fx);
  return {
    range,
    level,
    groups,
    dataState: dataStateOf(filtered.length > 0, coverages, range),
    coverage: coverageResult(filtered.length > 0, coverages, range),
    fx: fx.status(),
  };
}
