import { describe, expect, it } from "vitest";
import { apiError } from "@/convex/lib/errors";
import {
  COMMON_CURRENCIES,
  currencyGroups,
  currencyLabel,
  settingsErrorNotice,
  soleAccountCurrency,
  timeZoneGroups,
  zoneOffset,
} from "./reporting";

// The reporting settings' choices and words (C1).

const AT = Date.parse("2026-11-09T12:00:00.000Z");

describe("currency choices", () => {
  it("offers India's and the usual currencies first, then every other code once", () => {
    const [common, all] = currencyGroups("INR", "en-US");
    expect(common!.options.map((o) => o.value)).toEqual([...COMMON_CURRENCIES]);
    expect(common!.options[0]!.label).toBe("INR · Indian Rupee");
    const codes = all!.options.map((o) => o.value);
    expect(codes).toContain("JPY");
    expect(codes).not.toContain("INR");
    expect([...codes].sort()).toEqual(codes);
  });

  it("keeps a current code the browser does not list", () => {
    const [, all] = currencyGroups("XTS", "en-US");
    expect(all!.options.map((o) => o.value)).toContain("XTS");
  });

  it("falls back to the bare code without a name", () => {
    expect(currencyLabel("ZZZ", "en-US")).toBe("ZZZ");
  });
});

describe("time zone choices", () => {
  it("suggests the browser's zone and India's, then lists every zone and UTC once", () => {
    const [suggested, all] = timeZoneGroups("UTC", "Europe/Berlin", AT, "en-US");
    expect(suggested!.options.map((o) => o.value)).toEqual(["Europe/Berlin", "Asia/Kolkata"]);
    expect(suggested!.options[1]!.label).toBe("Asia/Kolkata · GMT+5:30");
    const zones = all!.options.map((o) => o.value);
    expect(zones).toContain("UTC");
    expect(zones).toContain("America/New_York");
    expect(zones).not.toContain("Asia/Kolkata");
    expect(zones).not.toContain("Europe/Berlin");
  });

  it("suggests India once when the browser is in India", () => {
    const [suggested] = timeZoneGroups("Asia/Kolkata", "Asia/Kolkata", AT, "en-US");
    expect(suggested!.options.map((o) => o.value)).toEqual(["Asia/Kolkata"]);
  });

  it("names the offset at the given moment", () => {
    expect(zoneOffset("Asia/Kolkata", AT)).toBe("GMT+5:30");
    expect(zoneOffset("Not/AZone", AT)).toBe("");
  });
});

describe("soleAccountCurrency", () => {
  const account = (currency: string, linked = true, isManager = false) => ({
    currency,
    linked,
    isManager,
  });

  it("is the one currency of the linked accounts", () => {
    expect(soleAccountCurrency([account("INR"), account("INR")])).toBe("INR");
    expect(soleAccountCurrency([account("INR"), account("USD", false)])).toBe("INR");
    expect(soleAccountCurrency([account("INR"), account("USD", true, true)])).toBe("INR");
  });

  it("is undefined for several currencies, no accounts or before they load", () => {
    expect(soleAccountCurrency([account("INR"), account("JPY")])).toBeUndefined();
    expect(soleAccountCurrency([])).toBeUndefined();
    expect(soleAccountCurrency(undefined)).toBeUndefined();
  });
});

describe("settingsErrorNotice", () => {
  it("explains refusals in fixed words", () => {
    expect(settingsErrorNotice(apiError("INVALID_ARGUMENT", "raw"))).toMatchObject({
      tone: "error",
      title: "Setting not valid",
    });
    expect(settingsErrorNotice(apiError("FORBIDDEN", "raw"))).toMatchObject({
      title: "Only admins can change these",
    });
    expect(settingsErrorNotice(new Error("network"))).toMatchObject({ title: "Not saved" });
  });
});
