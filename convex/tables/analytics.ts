import { defineTable } from "convex/server";
import { v } from "convex/values";
import { dateKeyValidator } from "../domain/validators";

// Phase 6: analytics reference data.
//
// fxRates is GLOBAL reference data (approved exception to "every table carries
// orgId"): public exchange rates, not tenant data. It is written only by
// internal admin functions (convex/admin/fxRates.ts) and read by analytics to
// convert native money into an org's reporting currency at query time.

export const analyticsTables = {
  /** Units of `quote` per 1 USD (USD is the pivot) on `date`. */
  fxRates: defineTable({
    /** ISO 4217 code; never "USD" (the pivot is implicitly 1). */
    quote: v.string(),
    /** Calendar day the rate applies to. */
    date: dateKeyValidator,
    /** Positive decimal string, at most 12 fractional digits (exact; never a float). */
    rate: v.string(),
    /** "manual" for operator-loaded rates; a future rate provider sets its own name. */
    source: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_quote_date", ["quote", "date"]),
};
