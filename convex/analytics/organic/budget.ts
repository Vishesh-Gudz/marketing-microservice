import { apiError } from "../../lib/errors";
import { ORGANIC_LIMITS } from "./config";

/**
 * The organic read budget (F16: maxSocialRows = 8,000), shared by every read of one organic
 * query: social account documents, sync states and organic rows. Reads use
 * `.take(remaining + 1)`, so exceeding the budget fails the query with INVALID_ARGUMENT
 * `too_many_rows` (same error contract as the Phase 6 ad budgets) and never returns
 * truncated data. Separate from the ad ReadBudget, which is unchanged.
 */
export class SocialReadBudget {
  used = 0;

  constructor(readonly limit: number = ORGANIC_LIMITS.maxSocialRows) {}

  private exceeded(): never {
    throw apiError(
      "INVALID_ARGUMENT",
      "The request covers too many rows. Narrow the date range or the scope.",
      { reason: "too_many_rows", maxRows: this.limit, budget: "social_rows" },
    );
  }

  /** Charges `n` reads (e.g. documents loaded by id). */
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
