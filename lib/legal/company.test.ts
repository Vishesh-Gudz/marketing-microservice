import { describe, expect, it } from "vitest";
import { formatLegalDate, LEGAL, LEGAL_PLACEHOLDER } from "./company";

// Release gate for the public Privacy Policy and Data Deletion pages: they show these details
// to Meta, Google and every visitor, so a placeholder must never reach production.

describe("legal details", () => {
  it("has no placeholder left", () => {
    for (const [field, value] of Object.entries(LEGAL)) {
      expect(value, field).not.toBe(LEGAL_PLACEHOLDER);
      expect(value.trim(), field).not.toBe("");
    }
  });

  it("has a usable contact email and service URL", () => {
    expect(LEGAL.contactEmail).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    expect(LEGAL.serviceUrl).toMatch(/^https:\/\//);
  });

  it("has a valid effective date", () => {
    expect(LEGAL.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatLegalDate(LEGAL.effectiveDate)).not.toBe("Invalid Date");
  });

  it("formats the effective date in words", () => {
    expect(formatLegalDate("2026-11-03")).toBe("3 November 2026");
  });
});
