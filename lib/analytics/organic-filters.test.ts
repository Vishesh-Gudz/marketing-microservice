import { describe, expect, it } from "vitest";
import { resolvePreset } from "@/convex/analytics/periods";
import { todayIn } from "@/convex/lib/dates";
import { DEFAULT_FILTERS, resolveRange } from "./filters";
import { parseSocialParams, postPublishFilter } from "./organic-filters";

// /social URL state: the account and post order params; account-metric presets resolve
// against today in UTC (the org timezone only applies to post publish days).

describe("parseSocialParams", () => {
  it("reads the account and the post order with safe fallbacks", () => {
    expect(parseSocialParams(new URLSearchParams("account=acct_1&pdir=asc"))).toEqual({
      account: "acct_1",
      postOrder: "asc",
    });
    expect(parseSocialParams(new URLSearchParams("pdir=sideways"))).toEqual({ postOrder: "desc" });
    expect(parseSocialParams(new URLSearchParams("account=<script>"))).toEqual({
      postOrder: "desc",
    });
  });
});

describe("UTC presets", () => {
  it("resolve against today's UTC day, not the org's", () => {
    // 02:00 UTC on Sep 26 is still Sep 25 in New York.
    const now = Date.UTC(2026, 8, 26, 2);
    const utc = resolveRange(DEFAULT_FILTERS, todayIn("UTC", now));
    const org = resolveRange(DEFAULT_FILTERS, todayIn("America/New_York", now));
    expect(utc).toEqual({ from: "2026-08-27", to: "2026-09-25" });
    expect(org).toEqual({ from: "2026-08-26", to: "2026-09-24" });
    expect(utc).toEqual(resolvePreset("last_30_days", "2026-09-26"));
  });
});

describe("postPublishFilter", () => {
  it("passes the inclusive range as publish days (the API applies the org timezone)", () => {
    expect(postPublishFilter({ from: "2026-09-01", to: "2026-09-07" })).toEqual({
      publishedFrom: "2026-09-01",
      publishedTo: "2026-09-07",
    });
  });
});
