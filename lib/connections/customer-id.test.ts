import { describe, expect, it } from "vitest";
import { formatCustomerId, isGoogleCustomerId } from "./customer-id";

describe("Google Ads customer ids", () => {
  it("formats a 10-digit id as 123-456-7890", () => {
    expect(formatCustomerId("1234567890")).toBe("123-456-7890");
    expect(formatCustomerId("0000000001")).toBe("000-000-0001");
    expect(isGoogleCustomerId("1234567890")).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["too short", "123456789"],
    ["too long", "12345678901"],
    ["already formatted", "123-456-7890"],
    ["letters", "abcdefghij"],
    ["mixed", "12345abcde"],
    ["surrounding whitespace", " 1234567890 "],
    ["non-ASCII digits", "١٢٣٤٥٦٧٨٩٠"],
    ["full-width digits", "１２３４５６７８９０"],
    ["markup", "<b>12345</b>"],
    ["a Meta-style id", "act_1234567890"],
  ])("leaves an invalid id (%s) unchanged", (_label, value) => {
    expect(isGoogleCustomerId(value)).toBe(false);
    expect(formatCustomerId(value)).toBe(value);
  });

  it.each([undefined, null, 1234567890, {}, ["1234567890"]])("rejects non-string %s", (value) => {
    expect(isGoogleCustomerId(value)).toBe(false);
  });
});
