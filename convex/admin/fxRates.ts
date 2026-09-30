import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { FX_PIVOT, parseRate } from "../analytics/fx";
import { isDateKey } from "../lib/dates";
import { isValidCurrency } from "../lib/validation";

/**
 * INTERNAL operator functions for the global fxRates reference table
 * (`npx convex run admin/fxRates:upsert '{"rates":[...]}'`). Rates are units of
 * `quote` per 1 USD. No public function writes rates; an external rate
 * provider is a later, separate integration.
 */

const MAX_BATCH = 500;

const rateInput = v.object({
  quote: v.string(),
  date: v.string(),
  rate: v.string(),
  source: v.optional(v.string()),
});

export const upsert = internalMutation({
  args: { rates: v.array(rateInput) },
  returns: v.object({ inserted: v.number(), updated: v.number() }),
  handler: async (ctx, { rates }) => {
    if (rates.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} rates per call`);
    const now = Date.now();
    let inserted = 0;
    let updated = 0;
    for (const input of rates) {
      if (!isValidCurrency(input.quote) || input.quote === FX_PIVOT) {
        throw new Error(`Invalid quote currency "${input.quote}"`);
      }
      if (!isDateKey(input.date)) throw new Error(`Invalid date "${input.date}"`);
      parseRate(input.rate); // throws on anything but a positive decimal with <= 12 decimals
      const existing = await ctx.db
        .query("fxRates")
        .withIndex("by_quote_date", (q) => q.eq("quote", input.quote).eq("date", input.date))
        .first();
      const fields = { rate: input.rate.trim(), source: input.source ?? "manual", updatedAt: now };
      if (existing) {
        await ctx.db.patch(existing._id, fields);
        updated++;
      } else {
        await ctx.db.insert("fxRates", {
          quote: input.quote,
          date: input.date,
          ...fields,
          createdAt: now,
        });
        inserted++;
      }
    }
    return { inserted, updated };
  },
});

export const list = internalQuery({
  args: { quote: v.string(), from: v.string(), to: v.string() },
  returns: v.array(v.object({ date: v.string(), rate: v.string(), source: v.string() })),
  handler: async (ctx, { quote, from, to }) => {
    const rows = await ctx.db
      .query("fxRates")
      .withIndex("by_quote_date", (q) => q.eq("quote", quote).gte("date", from).lte("date", to))
      .take(1_000);
    return rows.map((r) => ({ date: r.date, rate: r.rate, source: r.source }));
  },
});
