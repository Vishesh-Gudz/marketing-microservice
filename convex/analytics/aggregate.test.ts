import { describe, expect, it } from "vitest";
import { AD_METRICS } from "../domain/metrics";
import {
  catalogKeys,
  COUNT_METRICS,
  FLOAT_METRICS,
  MetricAccumulator,
  MONEY_METRICS,
  NON_ADDITIVE_METRICS,
  type MetricRow,
} from "./aggregate";
import { FxConverter, RateTable } from "./fx";
import { countToNumber, fixed6ToNumber, ratioFixed6, roundDiv, toFixed6 } from "./numeric";

const usdFx = () => new FxConverter("USD", new RateTable());

function summarize(rows: Partial<MetricRow>[], fx = usdFx()) {
  const acc = new MetricAccumulator();
  for (const row of rows) acc.add({ currency: "USD", date: "2026-04-01", ...row } as MetricRow);
  return acc.summarize(fx);
}

const unavailable = (values: ReturnType<typeof summarize>, name: string) =>
  values.unavailableMetrics.find((u) => u.metric === name)?.reason;
const kpiReason = (values: ReturnType<typeof summarize>, kpi: string) =>
  values.unavailableKpis.find((u) => u.kpi === kpi)?.reason;

describe("numeric primitives", () => {
  it("rounds half away from zero", () => {
    expect(roundDiv(5n, 2n)).toBe(3n);
    expect(roundDiv(-5n, 2n)).toBe(-3n);
    expect(roundDiv(4n, 3n)).toBe(1n);
    expect(roundDiv(-4n, 3n)).toBe(-1n);
    expect(roundDiv(7n, 7n)).toBe(1n);
    expect(() => roundDiv(1n, 0n)).toThrow();
  });

  it("converts floats to exact 6-decimal fixed point and back", () => {
    expect(toFixed6(1.5)).toBe(1_500_000n);
    expect(toFixed6(0.1234565)).toBe(123_457n);
    expect(fixed6ToNumber(1_234_567n)).toBe(1.234567);
    expect(ratioFixed6(1n, 3n)).toBe(333_333n);
    expect(ratioFixed6(2n, 3n)).toBe(666_667n);
  });

  it("refuses counts beyond the safe integer range", () => {
    expect(countToNumber(123n)).toBe(123);
    expect(() => countToNumber(2n ** 60n)).toThrow();
  });

  it("covers the whole metric catalog with the right additivity", () => {
    const listed = [...COUNT_METRICS, ...FLOAT_METRICS, ...MONEY_METRICS, ...NON_ADDITIVE_METRICS];
    expect(listed.sort()).toEqual(catalogKeys().sort());
    for (const key of NON_ADDITIVE_METRICS) expect(AD_METRICS[key].additive).toBe(false);
    for (const key of [...COUNT_METRICS, ...FLOAT_METRICS, ...MONEY_METRICS]) {
      expect(AD_METRICS[key].additive, key).toBe(true);
    }
  });
});

describe("additive sums and missing vs zero", () => {
  it("sums exactly, including money beyond 2^53 micros", () => {
    const huge = 2n ** 55n + 7n;
    const values = summarize([
      { spendMicros: huge, impressions: 10, clicks: 1 },
      { spendMicros: huge, impressions: 5, clicks: 0, date: "2026-04-02" },
    ]);
    expect(values.money.spendMicros).toEqual({
      native: [{ currency: "USD", micros: 2n * huge }],
      reporting: 2n * huge,
    });
    expect(values.numbers.impressions).toBe(15n);
    expect(values.numbers.clicks).toBe(1n);
  });

  it("keeps a reported zero as zero and an absent field as not reported", () => {
    const values = summarize([{ spendMicros: 0n, clicks: 0, impressions: 0 }]);
    expect(values.money.spendMicros?.native).toEqual([{ currency: "USD", micros: 0n }]);
    expect(values.numbers.clicks).toBe(0n);
    expect(values.numbers.conversions).toBeUndefined();
    expect(unavailable(values, "conversions")).toBe("not_reported");
    expect(unavailable(values, "conversionValue")).toBe("not_reported");
    expect(unavailable(values, "clicks")).toBeUndefined();
  });

  it("marks a metric partial when only some rows report it", () => {
    const values = summarize([{ clicks: 3 }, { clicks: 4, linkClicks: 2 }]);
    expect(values.numbers.linkClicks).toBe(2n);
    expect(values.partialMetrics).toContain("linkClicks");
    expect(values.partialMetrics).not.toContain("clicks");
  });

  it("sums fractional conversions in fixed point, independent of row order", () => {
    const rows = [0.1, 0.2, 0.3, 1 / 3, 2.675].map((c, i) => ({
      conversions: c,
      date: `2026-04-0${i + 1}`,
    }));
    const forward = summarize(rows);
    const backward = summarize([...rows].reverse());
    expect(forward.numbers.conversions).toBe(backward.numbers.conversions);
    expect(fixed6ToNumber(forward.numbers.conversions!)).toBe(3.608333);
  });

  it("returns nothing (not zeros) for an empty aggregate", () => {
    const values = summarize([]);
    expect(values.rows).toBe(0);
    expect(values.numbers).toEqual({});
    expect(values.money).toEqual({});
    expect(values.unavailableMetrics).toEqual([]);
  });

  it("reports reach only at the stored grain (one row)", () => {
    expect(summarize([{ reach: 500, impressions: 900 }]).reach).toBe(500);
    const two = summarize([{ reach: 500 }, { reach: 400, date: "2026-04-02" }]);
    expect(two.reach).toBeUndefined();
    expect(unavailable(two, "reach")).toBe("non_additive");
    expect(unavailable(summarize([{ impressions: 1 }]), "reach")).toBe("not_reported");
  });

  it("flags invalid (negative or fractional-count) data instead of summing it", () => {
    const values = summarize([{ clicks: 1.5, impressions: 10 }]);
    expect(unavailable(values, "clicks")).toBe("invalid_data");
    expect(kpiReason(values, "ctr")).toBe("invalid_data");
  });
});

describe("KPI formulas", () => {
  const base = {
    spendMicros: 12_345_678n,
    impressions: 4_000,
    clicks: 123,
    conversions: 7.5,
    conversionValueMicros: 50_000_000n,
  };

  it("computes CTR, CPC, CPM, conversion rate, cost per conversion and ROAS exactly", () => {
    const values = summarize([base]);
    expect(fixed6ToNumber(values.ratios.ctr!)).toBe(0.03075); // 123 / 4000
    expect(values.moneyKpis.cpc).toEqual({
      native: [{ currency: "USD", micros: 100_371n }], // 12_345_678 / 123 = 100_371.36 -> 100_371
      reporting: 100_371n,
    });
    expect(values.moneyKpis.cpm?.native[0]!.micros).toBe(3_086_420n); // 12_345_678 * 1000 / 4000 = 3_086_419.5
    expect(fixed6ToNumber(values.ratios.conversionRate!)).toBe(0.060976); // 7.5 / 123
    expect(values.moneyKpis.costPerConversion?.native[0]!.micros).toBe(1_646_090n); // /7.5
    expect(fixed6ToNumber(values.ratios.roas!)).toBe(4.05); // 50 / 12.345678 = 4.0500000405
  });

  it("is 0 when the numerator is a reported zero", () => {
    const values = summarize([{ ...base, clicks: 0, conversions: 0 }]);
    expect(values.ratios.ctr).toBe(0n);
    expect(values.ratios.conversionRate).toBeUndefined();
    expect(kpiReason(values, "conversionRate")).toBe("zero_denominator");
  });

  it("omits KPIs with a zero or missing denominator or a missing numerator", () => {
    const zero = summarize([{ spendMicros: 1_000_000n, impressions: 0, clicks: 0 }]);
    expect(kpiReason(zero, "ctr")).toBe("zero_denominator");
    expect(kpiReason(zero, "cpc")).toBe("zero_denominator");
    expect(kpiReason(zero, "cpm")).toBe("zero_denominator");
    expect(zero.moneyKpis.cpc).toBeUndefined();

    const noValue = summarize([{ spendMicros: 1_000_000n, impressions: 10, clicks: 2 }]);
    expect(kpiReason(noValue, "roas")).toBe("numerator_unavailable");
    expect(kpiReason(noValue, "costPerConversion")).toBe("denominator_unavailable");
    expect(noValue.ratios.roas).toBeUndefined();

    const noSpend = summarize([{ impressions: 10, clicks: 2 }]);
    expect(kpiReason(noSpend, "cpc")).toBe("numerator_unavailable");
  });

  it("uses paired sums and flags partial KPIs", () => {
    // Row 2 has clicks but no impressions: it must not inflate CTR.
    const values = summarize([
      { clicks: 10, impressions: 1_000 },
      { clicks: 90, date: "2026-04-02" },
    ]);
    expect(fixed6ToNumber(values.ratios.ctr!)).toBe(0.01);
    expect(values.partialKpis).toContain("ctr");
    expect(values.partialMetrics).toContain("impressions");
  });
});

describe("currencies", () => {
  it("keeps native amounts per currency and converts to reporting when every rate exists", () => {
    const table = new RateTable();
    table.add("EUR", "2026-04-01", "0.9"); // 0.9 EUR per USD
    const values = summarize(
      [
        { currency: "USD", spendMicros: 10_000_000n, clicks: 10 },
        { currency: "EUR", spendMicros: 9_000_000n, clicks: 30 },
      ],
      new FxConverter("USD", table),
    );
    expect(values.money.spendMicros).toEqual({
      native: [
        { currency: "EUR", micros: 9_000_000n },
        { currency: "USD", micros: 10_000_000n },
      ],
      reporting: 20_000_000n,
    });
    // CPC: native per currency, reporting from converted numerators / all clicks.
    expect(values.moneyKpis.cpc).toEqual({
      native: [
        { currency: "EUR", micros: 300_000n },
        { currency: "USD", micros: 1_000_000n },
      ],
      reporting: 500_000n,
    });
  });

  it("omits reporting values (not zero) when a rate is missing; ROAS becomes mixed_currency", () => {
    const fx = new FxConverter("USD", new RateTable());
    const values = summarize(
      [
        {
          currency: "USD",
          spendMicros: 10_000_000n,
          conversionValueMicros: 30_000_000n,
          clicks: 1,
        },
        { currency: "JPY", spendMicros: 1_000_000_000n, conversionValueMicros: 1n, clicks: 1 },
      ],
      fx,
    );
    expect(values.money.spendMicros?.reporting).toBeUndefined();
    expect(values.money.spendMicros?.native).toHaveLength(2);
    expect(values.moneyKpis.cpc?.native).toHaveLength(2);
    expect(values.moneyKpis.cpc?.reporting).toBeUndefined();
    expect(kpiReason(values, "roas")).toBe("mixed_currency");
    expect(fx.status()).toEqual({
      reportingCurrency: "USD",
      status: "missing",
      missing: [{ currency: "JPY", days: 1 }],
    });
  });

  it("computes ROAS in the native currency when there is only one", () => {
    const fx = new FxConverter("USD", new RateTable());
    const values = summarize(
      [{ currency: "EUR", spendMicros: 2_000_000n, conversionValueMicros: 5_000_000n }],
      fx,
    );
    expect(fixed6ToNumber(values.ratios.roas!)).toBe(2.5);
    expect(values.money.spendMicros?.reporting).toBeUndefined();
  });
});
