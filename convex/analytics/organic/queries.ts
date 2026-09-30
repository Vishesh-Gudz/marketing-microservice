import type { PaginationOptions } from "convex/server";
import type { Doc, Id } from "../../_generated/dataModel";
import type { SocialPlatform } from "../../domain/types";
import { compareDateKeys, isDateKey, type DateKey } from "../../lib/dates";
import { clampPagination } from "../../lib/dto";
import { apiError } from "../../lib/errors";
import { getOwned } from "../../lib/tenancy";
import { createDefaultRegistry } from "../../providers";
import type { SocialProviderCapabilities } from "../../providers/social/capabilities";
import {
  bucketsOf,
  previousPeriod,
  rangeProblem,
  type DateRange,
  type Granularity,
} from "../periods";
import type { TenantCtx } from "../scope";
import {
  aggregateOrganic,
  compareOrganic,
  type AccountDays,
  type ComparedMetric,
  type OrganicAggregate,
  type OrganicDelta,
} from "./aggregate";
import { SocialReadBudget } from "./budget";
import { ORGANIC_LIMITS } from "./config";
import { zonedRangeInstants } from "./dates";

/**
 * The organic read operations behind convex/v1/{socialAccounts,socialPosts,organicAnalytics}.ts
 * (Phase 10 Stage B). Query-time reads of the canonical social tables written by the B1 sync
 * (socialAccounts, socialPosts, socialPostMetricSnapshots, socialAccountMetricsDaily, plus the
 * social sync state): no provider, no credential, no write, no second storage path. The org is
 * ALWAYS ctx.tenant.orgId; client-supplied ids are loaded with getOwned (another tenant's id
 * is NOT_FOUND); every read is orgId-first and bounded (page size or SocialReadBudget).
 */

let registry: ReturnType<typeof createDefaultRegistry> | undefined;

/** Static social capabilities (declarations only; no provider call is ever made). */
export function socialCapabilitiesOf(
  platform: SocialPlatform,
): SocialProviderCapabilities | undefined {
  registry ??= createDefaultRegistry();
  return registry.hasSocial(platform) ? registry.socialCapabilities(platform) : undefined;
}

function invalid(field: string, reason: string): never {
  throw apiError("INVALID_ARGUMENT", `Invalid ${field} (${reason}).`, { field, reason });
}

/** Explicit inclusive range, validated from the range alone (no clock). */
function validRange(range: DateRange, field: string): DateRange {
  const problem = rangeProblem(range, { maxDays: ORGANIC_LIMITS.maxRangeDays });
  if (problem !== undefined) invalid(field, problem);
  return { from: range.from, to: range.to };
}

export type CompareArg = "previous_period" | DateRange;

async function syncStateOf(
  ctx: TenantCtx,
  socialAccountId: Id<"socialAccounts">,
): Promise<Doc<"syncAccounts"> | null> {
  return await ctx.db
    .query("syncAccounts")
    .withIndex("by_org_social_account", (q) =>
      q.eq("orgId", ctx.tenant.orgId).eq("socialAccountId", socialAccountId),
    )
    .first();
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type SocialAccountView = {
  account: Doc<"socialAccounts">;
  sync: Doc<"syncAccounts"> | null;
};

/** The org's social accounts (linked and unlinked), ordered by platform then external id. */
export async function listSocialAccounts(ctx: TenantCtx, paginationOpts: PaginationOptions) {
  const result = await ctx.db
    .query("socialAccounts")
    .withIndex("by_org_platform_external", (q) => q.eq("orgId", ctx.tenant.orgId))
    .paginate(clampPagination(paginationOpts));
  const page: SocialAccountView[] = [];
  for (const account of result.page)
    page.push({ account, sync: await syncStateOf(ctx, account._id) });
  return { page, isDone: result.isDone, continueCursor: result.continueCursor };
}

export async function getSocialAccount(ctx: TenantCtx, id: string): Promise<SocialAccountView> {
  const account = await getOwned(ctx, "socialAccounts", id);
  return { account, sync: await syncStateOf(ctx, account._id) };
}

// ---------------------------------------------------------------------------
// Posts (lifetime snapshots; never differenced)
// ---------------------------------------------------------------------------

export type SocialPostView = {
  post: Doc<"socialPosts">;
  latest: Doc<"socialPostMetricSnapshots"> | null;
  postMetrics: readonly string[];
};

async function latestSnapshot(ctx: TenantCtx, postId: Id<"socialPosts">) {
  return await ctx.db
    .query("socialPostMetricSnapshots")
    .withIndex("by_org_post_date", (q) => q.eq("orgId", ctx.tenant.orgId).eq("postId", postId))
    .order("desc")
    .first();
}

function declaredPostMetrics(platform: SocialPlatform): readonly string[] {
  return socialCapabilitiesOf(platform)?.postMetrics ?? [];
}

/**
 * One account's posts by publish instant (newest first unless `dir` is "asc"), optionally
 * limited to publish days [publishedFrom, publishedTo] in the ORGANIZATION timezone. Removed
 * posts stay listed (with removedAt). Each post carries its latest lifetime snapshot.
 */
export async function listSocialPosts(
  ctx: TenantCtx,
  args: {
    socialAccountId: string;
    publishedFrom?: string;
    publishedTo?: string;
    dir?: "asc" | "desc";
    paginationOpts: PaginationOptions;
  },
) {
  const account = await getOwned(ctx, "socialAccounts", args.socialAccountId);
  for (const [field, value] of [
    ["publishedFrom", args.publishedFrom],
    ["publishedTo", args.publishedTo],
  ] as const) {
    if (value !== undefined && !isDateKey(value)) invalid(field, "invalid_date");
  }
  if (
    args.publishedFrom !== undefined &&
    args.publishedTo !== undefined &&
    compareDateKeys(args.publishedFrom, args.publishedTo) > 0
  ) {
    invalid("publishedFrom", "from_after_to");
  }
  const org = await ctx.db.get(ctx.tenant.orgId);
  if (org === null) throw apiError("INTERNAL", "Resolved organization is missing.");
  const { start, end } = zonedRangeInstants(
    {
      ...(args.publishedFrom !== undefined ? { from: args.publishedFrom } : {}),
      ...(args.publishedTo !== undefined ? { to: args.publishedTo } : {}),
    },
    org.timezone,
  );
  const result = await ctx.db
    .query("socialPosts")
    .withIndex("by_org_account_published", (q) => {
      const base = q.eq("orgId", ctx.tenant.orgId).eq("socialAccountId", account._id);
      if (start !== undefined && end !== undefined) {
        return base.gte("publishedAt", start).lt("publishedAt", end);
      }
      if (start !== undefined) return base.gte("publishedAt", start);
      if (end !== undefined) return base.lt("publishedAt", end);
      return base;
    })
    .order(args.dir ?? "desc")
    .paginate(clampPagination(args.paginationOpts));
  const postMetrics = declaredPostMetrics(account.platform);
  const page: SocialPostView[] = [];
  for (const post of result.page) {
    page.push({ post, latest: await latestSnapshot(ctx, post._id), postMetrics });
  }
  return { page, isDone: result.isDone, continueCursor: result.continueCursor };
}

/**
 * One post with its latest snapshot and its lifetime snapshot series (one row per UTC
 * capture day, oldest first), optionally limited to capture days [from, to]. Bounded by the
 * organic read budget.
 */
export async function getSocialPost(ctx: TenantCtx, args: { postId: string; range?: DateRange }) {
  const post = await getOwned(ctx, "socialPosts", args.postId);
  const range = args.range === undefined ? undefined : validRange(args.range, "range");
  const budget = new SocialReadBudget();
  budget.charge(1);
  const snapshots = await budget.take(
    ctx.db.query("socialPostMetricSnapshots").withIndex("by_org_post_date", (q) => {
      const base = q.eq("orgId", ctx.tenant.orgId).eq("postId", post._id);
      return range === undefined
        ? base
        : base.gte("capturedDate", range.from).lte("capturedDate", range.to);
    }),
  );
  return {
    post,
    latest: await latestSnapshot(ctx, post._id),
    snapshots,
    postMetrics: declaredPostMetrics(post.platform),
    ...(range !== undefined ? { range } : {}),
  };
}

// ---------------------------------------------------------------------------
// Account analytics (socialAccountMetricsDaily, UTC days)
// ---------------------------------------------------------------------------

/** The accounts an overview covers: explicit ids (owned, 1-50) or all of the org's. */
async function scopedSocialAccounts(
  ctx: TenantCtx,
  ids: string[] | undefined,
  budget: SocialReadBudget,
): Promise<Doc<"socialAccounts">[]> {
  if (ids !== undefined) {
    const unique = [...new Set(ids)];
    if (unique.length === 0 || unique.length > ORGANIC_LIMITS.maxAccountIds) {
      throw apiError(
        "INVALID_ARGUMENT",
        `Provide 1-${ORGANIC_LIMITS.maxAccountIds} social account ids.`,
        { field: "socialAccountIds" },
      );
    }
    budget.charge(unique.length);
    const accounts: Doc<"socialAccounts">[] = [];
    for (const id of unique) accounts.push(await getOwned(ctx, "socialAccounts", id));
    return accounts.sort((a, b) =>
      a.platform === b.platform
        ? a.externalId.localeCompare(b.externalId)
        : a.platform.localeCompare(b.platform),
    );
  }
  return await budget.take(
    ctx.db
      .query("socialAccounts")
      .withIndex("by_org_platform_external", (q) => q.eq("orgId", ctx.tenant.orgId)),
  );
}

function dayRows(
  ctx: TenantCtx,
  budget: SocialReadBudget,
  socialAccountId: Id<"socialAccounts">,
  range: DateRange,
) {
  return budget.take(
    ctx.db
      .query("socialAccountMetricsDaily")
      .withIndex("by_org_account_date", (q) =>
        q
          .eq("orgId", ctx.tenant.orgId)
          .eq("socialAccountId", socialAccountId)
          .gte("date", range.from)
          .lte("date", range.to),
      ),
  );
}

function supportedAll(accounts: readonly Doc<"socialAccounts">[]): boolean {
  return accounts.every(
    (account) => (socialCapabilitiesOf(account.platform)?.accountMetrics.length ?? 0) > 0,
  );
}

function unionRange(a: DateRange, b: DateRange | undefined): DateRange {
  if (b === undefined) return a;
  return {
    from: compareDateKeys(a.from, b.from) <= 0 ? a.from : b.from,
    to: compareDateKeys(a.to, b.to) >= 0 ? a.to : b.to,
  };
}

export type OrganicCoverage = {
  accountId: Id<"socialAccounts">;
  syncedDays: number;
  unsyncedDays: number;
  lastSyncedAt?: number;
};

export type OrganicOverview = {
  range: DateRange;
  accountCount: number;
  totals: OrganicAggregate;
  comparison?: {
    range: DateRange;
    previous: OrganicAggregate;
    deltas: Partial<Record<ComparedMetric, OrganicDelta>>;
  };
  coverage: { dataState: OrganicAggregate["dataState"]; accounts: OrganicCoverage[] };
};

/**
 * Org (or selected accounts) totals over UTC days [range.from, range.to], with an optional
 * comparison period. Multi-account semantics (R13): additive metrics summed across accounts
 * and days; reach / accountsEngaged / engagementRate only for one account and one day;
 * followers = the sum of each account's latest in-range capture.
 */
export async function organicOverview(
  ctx: TenantCtx,
  args: { range: DateRange; compare?: CompareArg; socialAccountIds?: string[] },
): Promise<OrganicOverview> {
  const range = validRange(args.range, "range");
  const compareRange =
    args.compare === undefined
      ? undefined
      : args.compare === "previous_period"
        ? previousPeriod(range)
        : validRange(args.compare, "compare");
  const budget = new SocialReadBudget();
  const accounts = await scopedSocialAccounts(ctx, args.socialAccountIds, budget);
  const read = unionRange(range, compareRange);
  const perAccount: {
    account: Doc<"socialAccounts">;
    days: AccountDays;
    sync: Doc<"syncAccounts"> | null;
  }[] = [];
  for (const account of accounts) {
    budget.charge(1); // the account's sync state
    const sync = await syncStateOf(ctx, account._id);
    const rows = await dayRows(ctx, budget, account._id, read);
    perAccount.push({ account, sync, days: { accountId: account._id, rows } });
  }
  const supported = supportedAll(accounts);
  const days = perAccount.map((entry) => entry.days);
  const totals = aggregateOrganic({ accounts: days, range, supported });
  const previous =
    compareRange === undefined
      ? undefined
      : aggregateOrganic({ accounts: days, range: compareRange, supported });

  const coverage: OrganicCoverage[] = perAccount.map(({ account, sync, days: { rows } }) => {
    const synced = aggregateOrganic({
      accounts: [{ accountId: account._id, rows }],
      range,
      supported,
    });
    return {
      accountId: account._id,
      syncedDays: synced.syncedDays,
      unsyncedDays: synced.expectedDays - synced.syncedDays,
      ...(sync?.lastSuccessAt !== undefined ? { lastSyncedAt: sync.lastSuccessAt } : {}),
    };
  });

  return {
    range,
    accountCount: accounts.length,
    totals,
    ...(previous !== undefined && compareRange !== undefined
      ? {
          comparison: {
            range: compareRange,
            previous,
            deltas: compareOrganic(totals, previous),
          },
        }
      : {}),
    coverage: { dataState: totals.dataState, accounts: coverage },
  };
}

export type SeriesPoint = {
  key: string;
  from: DateKey;
  to: DateKey;
  partial: boolean;
  aggregate: OrganicAggregate;
};

/**
 * One account's series over UTC days, bucketed by UTC day / ISO week / month. Each bucket
 * follows the overview rules with the bucket as the scope: reach, accountsEngaged and
 * engagementRate exist only in day buckets; followers is the bucket's latest capture.
 */
export async function organicAccountSeries(
  ctx: TenantCtx,
  args: { socialAccountId: string; range: DateRange; granularity?: Granularity },
) {
  const range = validRange(args.range, "range");
  const granularity = args.granularity ?? "day";
  const budget = new SocialReadBudget();
  const account = await getOwned(ctx, "socialAccounts", args.socialAccountId);
  budget.charge(1);
  const rows = await dayRows(ctx, budget, account._id, range);
  const supported = supportedAll([account]);
  const days: AccountDays[] = [{ accountId: account._id, rows }];
  const points: SeriesPoint[] = bucketsOf(range, granularity).map((bucket) => ({
    key: bucket.key,
    from: bucket.from,
    to: bucket.to,
    partial: bucket.partial,
    aggregate: aggregateOrganic({
      accounts: days,
      range: { from: bucket.from, to: bucket.to },
      supported,
    }),
  }));
  return {
    accountId: account._id,
    range,
    granularity,
    dataState: aggregateOrganic({ accounts: days, range, supported }).dataState,
    points,
  };
}
