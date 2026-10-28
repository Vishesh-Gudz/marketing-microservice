import { describe, expect, it } from "vitest";
import {
  AD_CONNECTION_PROVIDERS,
  CONNECTION_PROVIDERS,
  isAdConnectionProvider,
  isConnectionProvider,
  PROVIDERS,
} from "./providers";

describe("ad connection providers", () => {
  it("are Google Ads and Meta Ads only (Instagram organic stays off the Connections page)", () => {
    expect([...AD_CONNECTION_PROVIDERS]).toEqual(["google_ads", "meta"]);
    expect(isAdConnectionProvider("meta")).toBe(true);
    expect(isAdConnectionProvider("google_ads")).toBe(true);
    for (const value of ["instagram", "META", "", undefined, null, 1]) {
      expect(isAdConnectionProvider(value)).toBe(false);
    }
  });

  it("show Google customer ids with dashes and Meta ad account ids as Meta shows them", () => {
    expect(PROVIDERS.google_ads.formatAccountId("1234567890")).toBe("123-456-7890");
    expect(PROVIDERS.meta.formatAccountId("1234567890")).toBe("1234567890");
    expect(PROVIDERS.meta.formatAccountId("238470000000001")).toBe("238470000000001");
  });

  it("name each platform in its own words", () => {
    expect(PROVIDERS.google_ads).toMatchObject({
      name: "Google Ads",
      platform: "Google",
      identity: "Google account",
      reportsAccountType: true,
      parentLabel: "Manager",
    });
    expect(PROVIDERS.meta).toMatchObject({
      name: "Meta Ads",
      platform: "Meta",
      identity: "Facebook account",
      reportsAccountType: false,
      parentLabel: "Business",
    });
    expect(JSON.stringify(PROVIDERS.meta)).not.toContain("Google");
  });
});

describe("YouTube on the Connections page (ADR 0016)", () => {
  it("is a connection provider, but never an ad connection provider", () => {
    expect([...CONNECTION_PROVIDERS]).toEqual(["google_ads", "meta", "youtube"]);
    expect(isConnectionProvider("youtube")).toBe(true);
    expect(isAdConnectionProvider("youtube")).toBe(false);
    for (const value of ["instagram", "YouTube", "", undefined]) {
      expect(isConnectionProvider(value)).toBe(false);
    }
  });

  it("names YouTube in its own words and shows channel ids as they are", () => {
    expect(PROVIDERS.youtube).toMatchObject({
      name: "YouTube",
      platform: "Google",
      identity: "Google account",
      accountNoun: "YouTube channel",
    });
    expect(PROVIDERS.youtube.formatAccountId("UCfakeChannel0000000000a")).toBe(
      "UCfakeChannel0000000000a",
    );
    expect(JSON.stringify(PROVIDERS.youtube)).not.toContain("Ads");
  });
});
