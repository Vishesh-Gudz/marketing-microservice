import { describe, expect, it } from "vitest";
import {
  formatChange,
  formatCount,
  formatDecimal,
  formatMoney,
  formatMultiple,
  formatPercent,
  moneyDisplay,
  toPlotNumber,
} from "./format";

const L = "en-US";

describe("formatMoney (exact)", () => {
  it("formats micros with the currency's own minor units", () => {
    expect(formatMoney({ currency: "USD", micros: "1234560000" }, L)).toBe("$1,234.56");
    expect(formatMoney({ currency: "EUR", micros: "500000" }, L)).toBe("€0.50");
    expect(formatMoney({ currency: "JPY", micros: "1500000000" }, L)).toBe("¥1,500");
    expect(formatMoney({ currency: "USD", micros: "-2500000" }, L)).toBe("-$2.50");
    expect(formatMoney({ currency: "USD", micros: "0" }, L)).toBe("$0.00");
  });

  it("stays exact above 2^53 (no floating point on the text path)", () => {
    // 12,345,678,901,234,567.89 = 12345678901234567890000 micros (far above 2^53).
    const micros = "12345678901234567890000";
    expect(formatMoney({ currency: "USD", micros }, L)).toBe("$12,345,678,901,234,567.89");
    // The float path (chart geometry only) cannot represent it.
    const viaFloat = new Intl.NumberFormat(L, { style: "currency", currency: "USD" }).format(
      toPlotNumber(micros),
    );
    expect(viaFloat).not.toBe("$12,345,678,901,234,567.89");
  });

  it("rounds half-cent values with Intl rounding on the exact decimal", () => {
    expect(formatMoney({ currency: "USD", micros: "1005000" }, L)).toBe("$1.01");
    expect(formatMoney({ currency: "USD", micros: "1004999" }, L)).toBe("$1.00");
  });
});

describe("number formats", () => {
  it("formats counts, decimals, percents, multiples and changes", () => {
    expect(formatCount(1234567, L)).toBe("1,234,567");
    expect(formatDecimal(12.345, L)).toBe("12.35");
    expect(formatDecimal(12, L)).toBe("12");
    expect(formatPercent(0.0123, L)).toBe("1.23%");
    expect(formatMultiple(4.05, L)).toBe("4.05×");
    expect(formatChange(0.123, L)).toBe("+12.3%");
    expect(formatChange(-0.5, L)).toBe("-50.0%");
    expect(formatChange(0, L)).toBe("0.0%");
  });
});

describe("moneyDisplay", () => {
  const usd = { currency: "USD", micros: "1000000" };
  const eur = { currency: "EUR", micros: "2000000" };

  it("prefers the reporting value, then a single native value", () => {
    expect(moneyDisplay({ native: [eur], reporting: usd })).toEqual({
      kind: "reporting",
      money: usd,
    });
    expect(moneyDisplay({ native: [eur] })).toEqual({ kind: "native", money: eur });
  });

  it("never sums different currencies", () => {
    expect(moneyDisplay({ native: [eur, usd] })).toEqual({ kind: "multiple", native: [eur, usd] });
    expect(moneyDisplay(undefined)).toEqual({ kind: "none" });
    expect(moneyDisplay({ native: [] })).toEqual({ kind: "none" });
  });
});
