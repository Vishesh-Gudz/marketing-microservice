import { describe, expect, it } from "vitest";
import { aggregateActions } from "./actions";
import { FxConverter, RateTable } from "./fx";
import { fixed6ToNumber } from "./numeric";

type Row = Parameters<typeof aggregateActions>[0][number];

const row = (overrides: Partial<Row>): Row => ({
  actionType: "purchase",
  rawActionType: "offsite_conversion.fb_pixel_purchase",
  attributionWindow: "7d_click_1d_view",
  attributionBasis: "impression_or_click_date",
  isPrimary: true,
  count: 1,
  currency: "USD",
  date: "2026-04-01",
  ...overrides,
});
const spend = (micros: bigint, date = "2026-04-01", currency = "USD") => ({
  currency,
  date,
  spendMicros: micros,
});
const usd = () => new FxConverter("USD", new RateTable());

describe("action groups", () => {
  it("never sums across attribution windows or action types", () => {
    const groups = aggregateActions(
      [
        row({ count: 3 }),
        row({ count: 2, date: "2026-04-02" }),
        row({ count: 1, attributionWindow: "1d_click" }),
        row({ count: 4, actionType: "lead", rawActionType: "lead" }),
        row({ count: 9, actionType: "add_to_cart", rawActionType: "atc", isPrimary: false }),
      ],
      [spend(10_000_000n)],
      usd(),
    );
    expect(
      groups.map((g) => [g.rawActionType, g.attributionWindow, fixed6ToNumber(g.count)]),
    ).toEqual([
      ["lead", "7d_click_1d_view", 4],
      ["offsite_conversion.fb_pixel_purchase", "1d_click", 1],
      ["offsite_conversion.fb_pixel_purchase", "7d_click_1d_view", 5],
      ["atc", "7d_click_1d_view", 9],
    ]);
  });

  it("divides the scope's total spend by the group's count (days without actions count as zero)", () => {
    const [group] = aggregateActions(
      [row({ count: 2, valueMicros: 60_000_000n })],
      [spend(10_000_000n), spend(20_000_000n, "2026-04-02")], // no conversion on 04-02
      usd(),
    );
    expect(group!.costPerAction).toEqual({
      native: [{ currency: "USD", micros: 15_000_000n }],
      reporting: 15_000_000n,
    });
    expect(fixed6ToNumber(group!.valuePerSpend!)).toBe(2);
    expect(group!.valuePartial).toBe(false);
  });

  it("handles fractional counts exactly and flags partially reported values", () => {
    const [group] = aggregateActions(
      [row({ count: 0.5, valueMicros: 1_000_000n }), row({ count: 1.25, date: "2026-04-02" })],
      [spend(7_000_000n)],
      usd(),
    );
    expect(fixed6ToNumber(group!.count)).toBe(1.75);
    expect(group!.costPerAction!.native[0]!.micros).toBe(4_000_000n);
    expect(group!.valuePartial).toBe(true);
  });

  it("explains missing KPIs instead of returning zeros", () => {
    const [noSpend] = aggregateActions([row({ count: 1 })], [], usd());
    expect(noSpend!.unavailableKpis).toEqual([
      { kpi: "costPerAction", reason: "numerator_unavailable" },
      { kpi: "valuePerSpend", reason: "numerator_unavailable" },
    ]);
    const [zero] = aggregateActions([row({ count: 0 })], [spend(1n)], usd());
    expect(zero!.unavailableKpis).toContainEqual({
      kpi: "costPerAction",
      reason: "zero_denominator",
    });
  });

  it("keeps currencies apart without rates and converts with them", () => {
    const rows = [
      row({ count: 1, valueMicros: 10_000_000n }),
      row({ count: 1, currency: "EUR", valueMicros: 8_000_000n }),
    ];
    const spendRows = [spend(5_000_000n), spend(4_000_000n, "2026-04-01", "EUR")];
    const [noRates] = aggregateActions(rows, spendRows, usd());
    expect(noRates!.costPerAction).toEqual({
      native: [
        { currency: "EUR", micros: 4_000_000n },
        { currency: "USD", micros: 5_000_000n },
      ],
    });
    expect(noRates!.unavailableKpis).toContainEqual({
      kpi: "valuePerSpend",
      reason: "mixed_currency",
    });

    const table = new RateTable();
    table.add("EUR", "2026-04-01", "0.8");
    const [withRates] = aggregateActions(rows, spendRows, new FxConverter("USD", table));
    expect(withRates!.value?.reporting).toBe(20_000_000n);
    expect(withRates!.costPerAction?.reporting).toBe(5_000_000n); // (5 + 5) / 2
    expect(fixed6ToNumber(withRates!.valuePerSpend!)).toBe(2);
  });
});
