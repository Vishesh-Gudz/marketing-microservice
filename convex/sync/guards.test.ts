import { describe, expect, it } from "vitest";
import { INSTAGRAM_CAPABILITIES } from "../providers/instagram/capabilities";
import { META_MOCK_CAPABILITIES } from "../providers/mock/meta";
import type { ProviderMetricRow } from "../providers/types";
import { YOUTUBE_CAPABILITIES } from "../providers/youtube/capabilities";
import { SYNC_LIMITS } from "./config";
import {
  applyCaps,
  checkPageShape,
  checkRecordsInScope,
  checkSocialRecordsInScope,
  SOCIAL_OPERATION_RECORD_KIND,
  socialMaxPageSize,
  type RecordScope,
  type SocialRecordScope,
} from "./guards";

const shape = {
  itemCount: 10,
  nextCursor: "c2",
  requestCursor: "c1",
  previousCursor: "c0",
  pagesSoFar: 3,
  emptyPagesInRow: 0,
  maxPageSize: 100,
};

describe("page shape", () => {
  it("accepts normal pages, empty pages with a cursor, and final pages", () => {
    expect(checkPageShape(shape)).toBeUndefined();
    expect(checkPageShape({ ...shape, itemCount: 0 })).toBeUndefined();
    expect(checkPageShape({ ...shape, nextCursor: undefined })).toBeUndefined();
  });

  it("detects cursor loops (same or previous cursor)", () => {
    expect(checkPageShape({ ...shape, nextCursor: "c1" })).toBe("cursor_loop");
    expect(checkPageShape({ ...shape, nextCursor: "c0" })).toBe("cursor_loop");
  });

  it("caps pages, consecutive empty pages and page size", () => {
    expect(checkPageShape({ ...shape, pagesSoFar: SYNC_LIMITS.maxPagesPerTask - 1 })).toBe(
      "page_limit",
    );
    expect(
      checkPageShape({
        ...shape,
        itemCount: 0,
        emptyPagesInRow: SYNC_LIMITS.maxConsecutiveEmptyPages - 1,
      }),
    ).toBe("empty_page_limit");
    expect(checkPageShape({ ...shape, itemCount: 101 })).toBe("page_too_large");
    expect(checkPageShape({ ...shape, itemCount: 501, maxPageSize: 10_000 })).toBe(
      "page_too_large",
    );
  });
});

const row: ProviderMetricRow = {
  platform: "meta",
  accountExternalId: "1001",
  entityExternalId: "1001",
  level: "account",
  date: "2026-04-05",
  placement: "all",
  currency: "USD",
  spendMicros: 1_000_000n,
  impressions: 10,
};
const scope: RecordScope = {
  operation: "fetchDailyMetrics",
  platform: "meta",
  accountExternalId: "1001",
  currency: "USD",
  level: "account",
  from: "2026-04-01",
  to: "2026-04-10",
  breakdown: "none",
  capabilities: META_MOCK_CAPABILITIES,
};

describe("records in scope", () => {
  it("accepts rows of the requested account, level, window and placements", () => {
    expect(checkRecordsInScope("metricRow", [row], scope)).toBeUndefined();
    expect(
      checkRecordsInScope("metricRow", [row, { ...row, placement: "instagram" }], {
        ...scope,
        breakdown: "placement",
      }),
    ).toBeUndefined();
  });

  it.each([
    ["date before the window", { date: "2026-03-31" }],
    ["date after the window", { date: "2026-04-11" }],
    ["another level", { level: "campaign", entityExternalId: "5" }],
    ["another account", { accountExternalId: "1002", entityExternalId: "1002" }],
    ["another currency", { currency: "EUR" }],
    [
      "another platform",
      { platform: "google_ads", accountExternalId: "1112223333", entityExternalId: "1112223333" },
    ],
    ["a placement the request did not ask for", { placement: "instagram" }],
  ])("rejects %s", (_label, change) => {
    const result = checkRecordsInScope("metricRow", [{ ...row, ...change }], scope);
    expect(["out_of_scope", "invalid_record"]).toContain(result);
  });

  it("rejects placements outside the provider capabilities even with a breakdown", () => {
    expect(
      checkRecordsInScope("metricRow", [{ ...row, placement: "youtube" }], {
        ...scope,
        breakdown: "placement",
      }),
    ).toBe("out_of_scope");
  });

  it("rejects duplicate natural keys in one page", () => {
    expect(checkRecordsInScope("metricRow", [row, { ...row }], scope)).toBe("duplicate_keys");
  });

  it("rejects smuggled tenant fields and invalid records", () => {
    expect(checkRecordsInScope("metricRow", [{ ...row, orgId: "x" }], scope)).toBe(
      "invalid_record",
    );
    expect(checkRecordsInScope("metricRow", [{ ...row, spendMicros: -1n }], scope)).toBe(
      "invalid_record",
    );
  });

  it("requires exactly the requested account for getAccount", () => {
    const account = {
      platform: "meta",
      externalId: "1001",
      name: "A",
      currency: "USD",
      timezone: "UTC",
      status: "active",
      isManager: false,
    };
    const accountScope = { ...scope, operation: "getAccount" as const };
    expect(checkRecordsInScope("adAccount", [account], accountScope)).toBeUndefined();
    expect(
      checkRecordsInScope("adAccount", [{ ...account, externalId: "1002" }], accountScope),
    ).toBe("out_of_scope");
    expect(checkRecordsInScope("adAccount", [], accountScope)).toBe("out_of_scope");
  });
});

describe("per-video analytics records in scope (ADR 0016 Checkpoint 8)", () => {
  const CHANNEL = "UCfakeChannel0000000000a";
  const record = (overrides: Record<string, unknown> = {}) => ({
    platform: "youtube",
    accountExternalId: CHANNEL,
    postExternalId: "vid00000000",
    window: "last28",
    from: "2026-09-20",
    to: "2026-10-17",
    views: 10,
    averageViewPercentage: 41.5,
    ...overrides,
  });
  const scope: SocialRecordScope = {
    operation: "fetchVideoAnalytics",
    platform: "youtube",
    accountExternalId: CHANNEL,
    from: "2026-09-20",
    to: "2026-10-17",
    videoWindow: "last28",
    capabilities: YOUTUBE_CAPABILITIES,
    now: Date.UTC(2026, 9, 20, 12),
  };
  const check = (records: unknown[], overrides: Partial<SocialRecordScope> = {}) =>
    checkSocialRecordsInScope("youtubeVideoAnalytics", records, { ...scope, ...overrides });

  it("accepts records of exactly the task's channel, window and days", () => {
    expect(SOCIAL_OPERATION_RECORD_KIND.fetchVideoAnalytics).toBe("youtubeVideoAnalytics");
    expect(check([record(), record({ postExternalId: "vid00000001" })])).toBeUndefined();
    expect(check([])).toBeUndefined(); // an empty report empties the window
  });

  it("rejects another window, other days, another channel, duplicates and smuggled fields", () => {
    expect(check([record({ window: "lifetime" })])).toBe("out_of_scope");
    expect(check([record({ from: "2026-09-21" })])).toBe("out_of_scope");
    expect(check([record({ to: "2026-10-16" })])).toBe("out_of_scope");
    expect(check([record()], { videoWindow: undefined })).toBe("out_of_scope");
    expect(check([record({ accountExternalId: "UCotherChannel000000000a" })])).toBe("out_of_scope");
    expect(check([record(), record()])).toBe("duplicate_keys");
    expect(check([record({ orgId: "x" })])).toBe("invalid_record");
    expect(check([record({ postId: "x" })])).toBe("invalid_record");
    expect(check([record({ views: -1 })])).toBe("invalid_record");
  });

  it("allows at most the declared top-N rows per page (none for a platform without it)", () => {
    expect(socialMaxPageSize("fetchVideoAnalytics", YOUTUBE_CAPABILITIES)).toBe(200);
    expect(socialMaxPageSize("fetchVideoAnalytics", INSTAGRAM_CAPABILITIES)).toBe(0);
  });
});

describe("size caps", () => {
  it("caps attributes, extras and text arrays deterministically", () => {
    const attributes = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`k${String(i).padStart(2, "0")}`, "v"]),
    );
    attributes.long = "x".repeat(2_000);
    const extras = Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`e${i}`, i]));
    const { value, truncated } = applyCaps({
      name: "n",
      attributes,
      extras,
      headlines: Array.from({ length: 25 }, () => "h"),
    });
    expect(Object.keys(value.attributes!)).toHaveLength(50);
    expect(Object.keys(value.extras!)).toHaveLength(50);
    expect(value.headlines).toHaveLength(20);
    expect(truncated).toBeGreaterThan(0);
    expect(applyCaps({ name: "n" })).toEqual({ value: { name: "n" }, truncated: 0 });
  });
});
