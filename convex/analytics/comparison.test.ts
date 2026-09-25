import { describe, expect, it } from "vitest";
import { MetricAccumulator, type MetricRow } from "./aggregate";
import { compareAggregates } from "./comparison";
import { FxConverter, RateTable } from "./fx";

function agg(
  rows: Partial<MetricRow>[],
  partial = false,
  fx = new FxConverter("USD", new RateTable()),
) {
  const acc = new MetricAccumulator();
  for (const row of rows) acc.add({ currency: "USD", date: "2026-04-01", ...row } as MetricRow);
  return { ...acc.summarize(fx), partial };
}

describe("period-over-period deltas", () => {
  it("computes absolute and percent deltas", () => {
    const deltas = compareAggregates(
      agg([{ impressions: 150, clicks: 15, spendMicros: 30_000_000n }]),
      agg([{ impressions: 100, clicks: 10, spendMicros: 20_000_000n }]),
    );
    expect(deltas.numbers.impressions).toEqual({ absolute: 50n, percent: 500_000n });
    expect(deltas.money.spend).toEqual({
      absolute: { native: [{ currency: "USD", micros: 10_000_000n }], reporting: 10_000_000n },
      percent: 500_000n,
    });
    // CTR equal in both periods: 0 change.
    expect(deltas.numbers.ctr).toEqual({ absolute: 0n, percent: 0n });
  });

  it("returns the absolute change but no percent when previous is zero", () => {
    const deltas = compareAggregates(agg([{ clicks: 5 }]), agg([{ clicks: 0 }]));
    expect(deltas.numbers.clicks).toEqual({ absolute: 5n, reason: "previous_zero" });
    const both = compareAggregates(agg([{ clicks: 0 }]), agg([{ clicks: 0 }]));
    expect(both.numbers.clicks).toEqual({ absolute: 0n, reason: "previous_zero" });
  });

  it("omits deltas when either period is unavailable", () => {
    const noPrevious = compareAggregates(agg([{ clicks: 5 }]), agg([]));
    expect(noPrevious.numbers.clicks).toEqual({ reason: "previous_unavailable" });
    // Current missing: no delta at all (the current aggregate already explains why).
    const noCurrent = compareAggregates(agg([]), agg([{ clicks: 5 }]));
    expect(noCurrent.numbers).not.toHaveProperty("clicks");
    expect(noPrevious.money).not.toHaveProperty("spend");
  });

  it("flags partial comparisons", () => {
    const deltas = compareAggregates(agg([{ clicks: 5 }], true), agg([{ clicks: 4 }]));
    expect(deltas.numbers.clicks).toMatchObject({ absolute: 1n, partial: true });
  });

  it("never computes a cross-currency percent without reporting values", () => {
    const fx = new FxConverter("USD", new RateTable());
    const deltas = compareAggregates(
      agg(
        [
          { currency: "EUR", spendMicros: 3n },
          { currency: "JPY", spendMicros: 4n },
        ],
        false,
        fx,
      ),
      agg(
        [
          { currency: "EUR", spendMicros: 1n },
          { currency: "JPY", spendMicros: 2n },
        ],
        false,
        fx,
      ),
    );
    expect(deltas.money.spend).toEqual({
      absolute: {
        native: [
          { currency: "EUR", micros: 2n },
          { currency: "JPY", micros: 2n },
        ],
      },
      reason: "mixed_currency",
    });
  });

  it("does not compare reach (non-additive)", () => {
    const deltas = compareAggregates(agg([{ reach: 5 }]), agg([{ reach: 3 }]));
    expect(Object.keys(deltas.numbers)).not.toContain("reach");
  });
});
