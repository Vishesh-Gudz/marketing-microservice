import { describe, expect, it } from "vitest";
import {
  addMicros,
  currencyMinorUnits,
  microsToDecimalString,
  MoneyParseError,
  numberToMicros,
  parseDecimalToMicros,
  sumMicros,
  toMoneyDto,
} from "./money";

describe("parseDecimalToMicros", () => {
  it.each([
    ["0", 0n],
    ["123.45", 123_450_000n],
    ["0.1", 100_000n],
    ["0.000001", 1n],
    ["-7.5", -7_500_000n],
    ["+3", 3_000_000n],
    [" 42.000000 ", 42_000_000n],
    ["1.0000004", 1_000_000n],
    ["1.0000005", 1_000_001n],
    ["-1.0000005", -1_000_001n],
    ["0.9999995", 1_000_000n],
  ])("parses %j exactly", (input, expected) => {
    expect(parseDecimalToMicros(input)).toBe(expected);
  });

  it("is exact beyond Number.MAX_SAFE_INTEGER micros", () => {
    // 12 billion IDR ≈ 1.2e16 micros: not representable exactly as a float.
    expect(parseDecimalToMicros("12000000000.123457")).toBe(12_000_000_000_123_457n);
  });

  it.each(["", "abc", "1e3", ".5", "1.", "1,000.00", "--1", "NaN"])("rejects %j", (input) => {
    expect(() => parseDecimalToMicros(input)).toThrow(MoneyParseError);
  });
});

describe("numberToMicros", () => {
  it("rounds half away from zero", () => {
    expect(numberToMicros(12.3456789)).toBe(12_345_679n);
    expect(numberToMicros(-12.3456785)).toBe(-12_345_679n);
    expect(numberToMicros(0.1 + 0.2)).toBe(300_000n);
  });

  it("rejects non-finite and out-of-range values", () => {
    expect(() => numberToMicros(Number.NaN)).toThrow(MoneyParseError);
    expect(() => numberToMicros(Infinity)).toThrow(MoneyParseError);
    expect(() => numberToMicros(1e22)).toThrow(MoneyParseError);
  });
});

describe("microsToDecimalString", () => {
  it.each([
    [0n, "0"],
    [123_450_000n, "123.45"],
    [1n, "0.000001"],
    [-500_000n, "-0.5"],
    [42_000_000n, "42"],
  ])("formats %s as %s", (micros, expected) => {
    expect(microsToDecimalString(micros)).toBe(expected);
  });

  it("round-trips with parseDecimalToMicros", () => {
    for (const text of ["19.99", "-0.000001", "123456789012.5"]) {
      expect(microsToDecimalString(parseDecimalToMicros(text))).toBe(text);
    }
  });
});

describe("sums keep missing-data semantics", () => {
  it("returns undefined when nothing is present", () => {
    expect(sumMicros([])).toBeUndefined();
    expect(sumMicros([undefined, undefined])).toBeUndefined();
    expect(addMicros(undefined, undefined)).toBeUndefined();
  });

  it("sums only present values, and keeps reported zeros", () => {
    expect(sumMicros([1n, undefined, 2n])).toBe(3n);
    expect(sumMicros([0n, undefined])).toBe(0n);
    expect(addMicros(5n, undefined)).toBe(5n);
  });
});

describe("currencies and DTOs", () => {
  it("knows minor units", () => {
    expect(currencyMinorUnits("USD")).toBe(2);
    expect(currencyMinorUnits("JPY")).toBe(0);
    expect(currencyMinorUnits("KWD")).toBe(3);
  });

  it("serializes micros as a decimal string", () => {
    expect(toMoneyDto(12_000_000_000_123_457n, "IDR")).toEqual({
      currency: "IDR",
      micros: "12000000000123457",
    });
  });
});
