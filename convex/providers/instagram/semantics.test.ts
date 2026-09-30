import { describe, expect, it } from "vitest";
import { SOCIAL_ACCOUNT_METRICS, SOCIAL_POST_METRICS } from "../../domain/metrics";
import { INSTAGRAM_CAPABILITIES } from "./capabilities";
import {
  ACCOUNT_DAYS_PER_CALL,
  ACCOUNT_INSIGHT_METRICS,
  ACCOUNT_INSIGHT_TARGETS,
  ACCOUNT_REQUESTS_PER_DAY,
  allowedPermalink,
  FOLLOW_TYPE_BREAKDOWN,
  FOLLOWS_METRIC,
  INSTAGRAM_ACCOUNT_METRICS,
  INSTAGRAM_POST_METRICS,
  NEVER_REQUESTED_METRICS,
  READER_POST_METRICS,
  SDK_POST_METRIC_COLUMNS,
} from "./semantics";
import { assertAllowedRequest, SDK_POST_METRICS, TransportBlockedError } from "./transport";

// Phase 10 Stage B: the semantics table is consistent with the canonical catalogs and with
// the (independent) transport allowlist, and names nothing forbidden.

const G = "https://graph.instagram.com/v25.0";
const DAY = "since=1790000000&until=1790086400";

function allowed(caller: "graph_reader" | "sdk", url: string): boolean {
  try {
    assertAllowedRequest(caller, {
      method: "GET",
      url: new URL(url),
      headers: new Headers({ authorization: "Bearer IGAAfake" }),
      hasBody: false,
    });
    return true;
  } catch (error) {
    if (error instanceof TransportBlockedError) return false;
    throw error;
  }
}

describe("Instagram semantics", () => {
  it("every request the provider makes passes the transport allowlist", () => {
    expect(
      allowed(
        "graph_reader",
        `${G}/17900000000000001/insights?metric=${READER_POST_METRICS.join(",")}&period=lifetime`,
      ),
    ).toBe(true);
    expect(
      allowed(
        "graph_reader",
        `${G}/17841400000000101/insights?metric=${ACCOUNT_INSIGHT_METRICS.join(",")}&period=day&metric_type=total_value&${DAY}`,
      ),
    ).toBe(true);
    expect(
      allowed(
        "graph_reader",
        `${G}/17841400000000101/insights?metric=${FOLLOWS_METRIC}&period=day&metric_type=total_value&breakdown=${FOLLOW_TYPE_BREAKDOWN}&${DAY}`,
      ),
    ).toBe(true);
    expect(SDK_POST_METRICS[0].split(",").sort()).toEqual(
      Object.keys(SDK_POST_METRIC_COLUMNS).sort(),
    );
  });

  it("never names a forbidden metric, and the transport refuses each one", () => {
    const requested = [
      ...READER_POST_METRICS,
      ...ACCOUNT_INSIGHT_METRICS,
      FOLLOWS_METRIC,
      ...Object.keys(SDK_POST_METRIC_COLUMNS),
    ];
    for (const metric of NEVER_REQUESTED_METRICS) {
      expect(requested).not.toContain(metric);
      expect(
        allowed("graph_reader", `${G}/17900000000000001/insights?metric=${metric}&period=lifetime`),
      ).toBe(false);
      expect(
        allowed(
          "graph_reader",
          `${G}/17841400000000101/insights?metric=${metric}&period=day&metric_type=total_value&${DAY}`,
        ),
      ).toBe(false);
    }
    expect(
      requested.some((metric) => metric.startsWith("total_") && metric !== "total_interactions"),
    ).toBe(false);
  });

  it("fills only canonical columns, never deprecated or profile-group ones", () => {
    for (const column of INSTAGRAM_POST_METRICS) expect(SOCIAL_POST_METRICS).toHaveProperty(column);
    for (const column of INSTAGRAM_ACCOUNT_METRICS) {
      expect(SOCIAL_ACCOUNT_METRICS).toHaveProperty(column);
    }
    expect(INSTAGRAM_POST_METRICS).not.toContain("videoViews");
    expect(INSTAGRAM_ACCOUNT_METRICS).not.toContain("profileViews");
    expect(INSTAGRAM_ACCOUNT_METRICS).not.toContain("websiteClicks");
    // followers is the profile column group (captured by the preflight), not an insight.
    expect(INSTAGRAM_ACCOUNT_METRICS).not.toContain("followers");
    // F4: profile_links_taps is an extra, never websiteClicks.
    expect(ACCOUNT_INSIGHT_TARGETS.profile_links_taps).toEqual({ extra: "profileLinksTaps" });
    expect(
      Object.values(ACCOUNT_INSIGHT_TARGETS)
        .flatMap((t) => ("extra" in t ? [t.extra] : []))
        .sort(),
    ).toEqual(["comments", "likes", "profileLinksTaps", "replies", "saves", "shares"]);
  });

  it("stays inside the approved request budget", () => {
    const budget = INSTAGRAM_CAPABILITIES.requestBudget;
    expect(ACCOUNT_DAYS_PER_CALL * ACCOUNT_REQUESTS_PER_DAY).toBeLessThanOrEqual(
      budget.maxRequestsPerProviderCall,
    );
    expect(
      1 + INSTAGRAM_CAPABILITIES.postMetricsPageSize * budget.requestsPerPostSnapshot,
    ).toBeLessThanOrEqual(budget.maxRequestsPerProviderCall);
    expect(budget.requestsPerPostSnapshot).toBe(3);
    expect(budget.maxConcurrentRequests).toBe(3);
  });
});

describe("R1b permalink", () => {
  it.each([
    ["https://www.instagram.com/p/Cfake123/", "https://www.instagram.com/p/Cfake123/"],
    ["https://instagram.com/reel/Cfake/", "https://instagram.com/reel/Cfake/"],
    ["https://WWW.Instagram.com/p/X/", "https://www.instagram.com/p/X/"],
    ["https://www.instagram.com:443/p/X/", "https://www.instagram.com/p/X/"],
  ])("stores %s", (raw, stored) => {
    expect(allowedPermalink(raw)).toBe(stored);
  });

  it.each([
    ["http", "http://www.instagram.com/p/X/"],
    ["another host", "https://scontent.cdninstagram.com/v/t51/x.jpg"],
    ["a lookalike host", "https://www.instagram.com.evil.example/p/X/"],
    ["a subdomain", "https://l.instagram.com/?u=https://evil.example"],
    ["user info", "https://user:pass@www.instagram.com/p/X/"],
    ["a user name only", "https://user@www.instagram.com/p/X/"],
    ["a non-default port", "https://www.instagram.com:8443/p/X/"],
    ["javascript:", "javascript:alert(1)"],
    ["not a URL", "www.instagram.com/p/X/"],
    ["empty", ""],
    ["too long", `https://www.instagram.com/p/${"a".repeat(2_048)}/`],
  ])("refuses %s", (_label, raw) => {
    expect(allowedPermalink(raw)).toBeUndefined();
  });

  it("refuses non-strings", () => {
    expect(allowedPermalink(undefined)).toBeUndefined();
    expect(allowedPermalink(42)).toBeUndefined();
  });
});
