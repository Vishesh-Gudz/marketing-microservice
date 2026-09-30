import { describe, expect, it } from "vitest";
import {
  ExternalIdError,
  googleAdExternalId,
  normalizeAdAccountExternalId,
  normalizeGoogleCustomerId,
  normalizeMetaAdAccountId,
  normalizeNumericId,
  normalizeSocialExternalId,
  parseGoogleAdExternalId,
} from "./identity";
import {
  AD_METRICS,
  adMetricFields,
  SOCIAL_ACCOUNT_METRICS,
  SOCIAL_POST_METRICS,
  socialAccountMetricFields,
  socialPostMetricFields,
} from "./metrics";
import { PLACEMENTS } from "./types";
import { placementValidator } from "./validators";

describe("external id normalization", () => {
  it("strips the Meta act_ prefix", () => {
    expect(normalizeMetaAdAccountId("act_123456")).toBe("123456");
    expect(normalizeMetaAdAccountId(" 123456 ")).toBe("123456");
    expect(() => normalizeMetaAdAccountId("act_abc")).toThrow(ExternalIdError);
  });

  it("normalizes Google customer ids to 10 digits", () => {
    expect(normalizeGoogleCustomerId("123-456-7890")).toBe("1234567890");
    expect(normalizeGoogleCustomerId("1234567890")).toBe("1234567890");
    expect(() => normalizeGoogleCustomerId("123-456")).toThrow(ExternalIdError);
  });

  it("dispatches by platform", () => {
    expect(normalizeAdAccountExternalId("meta", "act_9")).toBe("9");
    expect(normalizeAdAccountExternalId("google_ads", "111-222-3333")).toBe("1112223333");
  });

  it("keeps int64-sized ids exact as strings", () => {
    const beyondSafeInteger = "9223372036854775807";
    expect(normalizeNumericId(beyondSafeInteger)).toBe(beyondSafeInteger);
    expect(() => normalizeNumericId("12.5")).toThrow(ExternalIdError);
    expect(() => normalizeNumericId("")).toThrow(ExternalIdError);
  });

  it("builds and parses composite Google ad ids", () => {
    const id = googleAdExternalId("111", "222");
    expect(id).toBe("111~222");
    expect(parseGoogleAdExternalId(id)).toEqual({ adGroupId: "111", adId: "222" });
    expect(() => parseGoogleAdExternalId("222")).toThrow(ExternalIdError);
    expect(() => googleAdExternalId("x", "1")).toThrow(ExternalIdError);
  });

  it("normalizes social ids", () => {
    expect(normalizeSocialExternalId("instagram", "17841400000000001")).toBe("17841400000000001");
    expect(() => normalizeSocialExternalId("facebook", "page-name")).toThrow(ExternalIdError);
  });
});

describe("metric catalog", () => {
  type FieldJson = { fieldType: { type: string }; optional: boolean };
  const json = (field: unknown) => (field as { json: unknown }).json as FieldJson["fieldType"];
  const optional = (field: unknown) => (field as { isOptional: string }).isOptional;

  it.each([
    ["ad", AD_METRICS, adMetricFields],
    ["social post", SOCIAL_POST_METRICS, socialPostMetricFields],
    ["social account", SOCIAL_ACCOUNT_METRICS, socialAccountMetricFields],
  ] as const)("%s columns match the catalog and are all optional", (_label, catalog, columns) => {
    expect(Object.keys(columns).sort()).toEqual([...Object.keys(catalog), "extras"].sort());
    for (const [name, spec] of Object.entries(catalog)) {
      const field = columns[name as keyof typeof columns];
      expect(optional(field), name).toBe("optional");
      expect(json(field).type, name).toBe(spec.kind === "money" ? "bigint" : "number");
    }
  });

  it("marks deduplicated metrics as non-additive", () => {
    expect(AD_METRICS.reach.additive).toBe(false);
    expect(AD_METRICS.spendMicros.additive).toBe(true);
    expect(SOCIAL_ACCOUNT_METRICS.followers.additive).toBe(false);
  });

  it("names every money metric *Micros", () => {
    for (const [name, spec] of Object.entries(AD_METRICS)) {
      expect(name.endsWith("Micros"), name).toBe(spec.kind === "money");
    }
  });
});

describe("validators", () => {
  it("derive literal unions from the const arrays", () => {
    const json = (placementValidator as unknown as { json: { value: { value: string }[] } }).json;
    expect(json.value.map((m) => m.value)).toEqual([...PLACEMENTS]);
  });
});
