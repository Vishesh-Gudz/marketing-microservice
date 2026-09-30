import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import type { EntityLevel, Placement } from "../domain/types";
import { apiError } from "../lib/errors";
import { ANALYTICS_LIMITS } from "./config";
import type { DateRange } from "./periods";

/**
 * Bounded index reads. Every read of one query draws from a shared budget and
 * uses `.take(remaining + 1)`: exceeding the budget fails the query with
 * INVALID_ARGUMENT `too_many_rows` (deterministic), never truncated results.
 * Every read is orgId-first with the caller's tenant org.
 */

export type BudgetKind = "metric_rows" | "action_rows";

export class ReadBudget {
  used = 0;

  constructor(
    readonly limit: number,
    readonly kind: BudgetKind,
  ) {}

  static metrics() {
    return new ReadBudget(ANALYTICS_LIMITS.maxMetricRows, "metric_rows");
  }

  static actions() {
    return new ReadBudget(ANALYTICS_LIMITS.maxActionRows, "action_rows");
  }

  private exceeded(): never {
    throw apiError(
      "INVALID_ARGUMENT",
      "The request covers too many rows. Narrow the date range or the scope.",
      { reason: "too_many_rows", maxRows: this.limit, budget: this.kind },
    );
  }

  /** Charges `n` reads (e.g. entity documents) to the budget. */
  charge(n: number): void {
    if (this.used + n > this.limit) this.exceeded();
    this.used += n;
  }

  async take<T>(query: { take(n: number): Promise<T[]> }): Promise<T[]> {
    const remaining = this.limit - this.used;
    const rows = await query.take(remaining + 1);
    if (rows.length > remaining) this.exceeded();
    this.used += rows.length;
    return rows;
  }
}

type Ctx = { db: DatabaseReader; orgId: Id<"organizations"> };

/** One account's rows of one level and placement. */
export function accountLevelRows(
  ctx: Ctx,
  budget: ReadBudget,
  adAccountId: Id<"adAccounts">,
  level: EntityLevel,
  placement: Placement,
  range: DateRange,
): Promise<Doc<"metricsDaily">[]> {
  return budget.take(
    ctx.db
      .query("metricsDaily")
      .withIndex("by_org_account_level_placement_date", (q) =>
        q
          .eq("orgId", ctx.orgId)
          .eq("adAccountId", adAccountId)
          .eq("level", level)
          .eq("placement", placement)
          .gte("date", range.from)
          .lte("date", range.to),
      ),
  );
}

/** The whole org's rows of one level and placement. */
export function orgLevelRows(
  ctx: Ctx,
  budget: ReadBudget,
  level: EntityLevel,
  placement: Placement,
  range: DateRange,
): Promise<Doc<"metricsDaily">[]> {
  return budget.take(
    ctx.db
      .query("metricsDaily")
      .withIndex("by_org_level_placement_date", (q) =>
        q
          .eq("orgId", ctx.orgId)
          .eq("level", level)
          .eq("placement", placement)
          .gte("date", range.from)
          .lte("date", range.to),
      ),
  );
}

/** One campaign's rows of a child level (ad_group / ad). */
export function campaignLevelRows(
  ctx: Ctx,
  budget: ReadBudget,
  campaignId: Id<"campaigns">,
  level: EntityLevel,
  placement: Placement,
  range: DateRange,
): Promise<Doc<"metricsDaily">[]> {
  return budget.take(
    ctx.db
      .query("metricsDaily")
      .withIndex("by_org_campaign_level_placement_date", (q) =>
        q
          .eq("orgId", ctx.orgId)
          .eq("campaignId", campaignId)
          .eq("level", level)
          .eq("placement", placement)
          .gte("date", range.from)
          .lte("date", range.to),
      ),
  );
}

/** One entity's rows of one placement. */
export function entityRows(
  ctx: Ctx,
  budget: ReadBudget,
  entityId: Doc<"metricsDaily">["entityId"],
  placement: Placement,
  range: DateRange,
): Promise<Doc<"metricsDaily">[]> {
  return budget.take(
    ctx.db
      .query("metricsDaily")
      .withIndex("by_org_entity_placement_date", (q) =>
        q
          .eq("orgId", ctx.orgId)
          .eq("entityId", entityId)
          .eq("placement", placement)
          .gte("date", range.from)
          .lte("date", range.to),
      ),
  );
}

/** One account's action rows of one level (Phase 6 index; no ad-level scan). */
export function accountLevelActionRows(
  ctx: Ctx,
  budget: ReadBudget,
  adAccountId: Id<"adAccounts">,
  level: EntityLevel,
  range: DateRange,
): Promise<Doc<"actionMetricsDaily">[]> {
  return budget.take(
    ctx.db
      .query("actionMetricsDaily")
      .withIndex("by_org_account_level_date", (q) =>
        q
          .eq("orgId", ctx.orgId)
          .eq("adAccountId", adAccountId)
          .eq("level", level)
          .gte("date", range.from)
          .lte("date", range.to),
      ),
  );
}

/** One entity's action rows (placement "all", the only one synced). */
export function entityActionRows(
  ctx: Ctx,
  budget: ReadBudget,
  entityId: Doc<"actionMetricsDaily">["entityId"],
  range: DateRange,
): Promise<Doc<"actionMetricsDaily">[]> {
  return budget.take(
    ctx.db
      .query("actionMetricsDaily")
      .withIndex("by_org_entity_placement_date_action", (q) =>
        q
          .eq("orgId", ctx.orgId)
          .eq("entityId", entityId)
          .eq("placement", "all")
          .gte("date", range.from)
          .lte("date", range.to),
      ),
  );
}
