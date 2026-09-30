import { describe, expect, it } from "vitest";
import { FxConverter, parseRate, RateTable } from "./fx";

describe("rates", () => {
  it("parses exact positive decimals with at most 12 fractional digits", () => {
    expect(parseRate("1")).toBe(1_000_000_000_000n);
    expect(parseRate("0.923456789012")).toBe(923_456_789_012n);
    expect(parseRate("16250.5")).toBe(16_250_500_000_000_000n);
    for (const bad of ["0", "-1", "1e3", "abc", "1.0000000000001", ""]) {
      expect(() => parseRate(bad), bad).toThrow();
    }
  });

  it("uses the rate of the day, else the latest rate at most 7 days older", () => {
    const table = new RateTable();
    table.add("EUR", "2026-04-01", "0.9");
    table.add("EUR", "2026-04-03", "0.8");
    expect(table.lookup("EUR", "2026-04-01")).toBe(parseRate("0.9"));
    expect(table.lookup("EUR", "2026-04-02")).toBe(parseRate("0.9"));
    expect(table.lookup("EUR", "2026-04-10")).toBe(parseRate("0.8"));
    expect(table.lookup("EUR", "2026-04-11")).toBeUndefined(); // 8 days after the last rate
    expect(table.lookup("EUR", "2026-03-31")).toBeUndefined(); // no earlier rate
    expect(table.lookup("USD", "2026-01-01")).toBe(parseRate("1")); // pivot
  });
});

describe("conversion", () => {
  it("converts through the USD pivot in one exact step (half away from zero)", () => {
    const table = new RateTable();
    table.add("EUR", "2026-04-01", "0.8");
    table.add("JPY", "2026-04-01", "150");
    // 10 EUR -> USD: 10 / 0.8 = 12.5
    expect(new FxConverter("USD", table).convert(10_000_000n, "EUR", "2026-04-01")).toBe(
      12_500_000n,
    );
    // 10 EUR -> JPY: 10 * 150 / 0.8 = 1875
    expect(new FxConverter("JPY", table).convert(10_000_000n, "EUR", "2026-04-01")).toBe(
      1_875_000_000n,
    );
    // 1 micro JPY -> EUR: 0.8 / 150 = 0.00533 micros -> rounds to 0
    expect(new FxConverter("EUR", table).convert(1n, "JPY", "2026-04-01")).toBe(0n);
    // 1 JPY -> EUR = 5333.33 micros -> 5333
    expect(new FxConverter("EUR", table).convert(1_000_000n, "JPY", "2026-04-01")).toBe(5_333n);
  });

  it("stays exact for amounts beyond 2^53 micros", () => {
    const table = new RateTable();
    table.add("IDR", "2026-04-01", "16000");
    const idr = 16_000n * 10n ** 18n; // 16e21 micros IDR
    expect(new FxConverter("USD", table).convert(idr, "IDR", "2026-04-01")).toBe(10n ** 18n);
  });

  it("reports not_needed / complete / missing", () => {
    const table = new RateTable();
    table.add("EUR", "2026-04-01", "0.8");
    const same = new FxConverter("USD", table);
    expect(same.convert(5n, "USD", "2026-04-01")).toBe(5n);
    expect(same.status()).toEqual({ reportingCurrency: "USD", status: "not_needed" });

    const complete = new FxConverter("USD", table);
    complete.convert(8n, "EUR", "2026-04-01");
    expect(complete.status().status).toBe("complete");

    const missing = new FxConverter("USD", table);
    expect(missing.convert(8n, "GBP", "2026-04-01")).toBeUndefined();
    expect(missing.convert(8n, "GBP", "2026-04-02")).toBeUndefined();
    expect(missing.convert(8n, "EUR", "2026-05-01")).toBeUndefined();
    expect(missing.status()).toEqual({
      reportingCurrency: "USD",
      status: "missing",
      missing: [
        { currency: "EUR", days: 1 },
        { currency: "GBP", days: 2 },
      ],
    });
  });
});
