import { describe, expect, it, vi } from "vitest";
import type { Connection } from "@/lib/analytics/types";
import {
  accountAnalyticsHref,
  connectReturnUrl,
  googleAdsConnections,
  navigateToAuthorization,
  pickConnection,
} from "./navigation";

function connection(overrides: Partial<Connection>): Connection {
  return {
    id: "c1",
    provider: "google_ads",
    status: "active",
    grantedScopes: [],
    missingScopes: [],
    expiresSoon: false,
    connectedAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("connectReturnUrl", () => {
  it("returns to /connections on the same origin", () => {
    expect(connectReturnUrl("http://localhost:3000", new URLSearchParams())).toBe(
      "http://localhost:3000/connections",
    );
  });

  it("carries only the global filters (never page or callback parameters)", () => {
    const current = new URLSearchParams(
      "preset=last_7_days&accounts=a1&status=connected&connection=c9&error=x&code=4%2Fc&state=s&tab=t",
    );
    expect(connectReturnUrl("https://app.example.test", current)).toBe(
      "https://app.example.test/connections?preset=last_7_days&accounts=a1",
    );
  });
});

describe("accountAnalyticsHref", () => {
  it("filters the Overview to the account", () => {
    expect(accountAnalyticsHref("a2", new URLSearchParams())).toBe("/?accounts=a2");
  });

  it("keeps the period, replaces other account and platform filters, drops page params", () => {
    expect(
      accountAnalyticsHref(
        "a2",
        new URLSearchParams("preset=last_7_days&platforms=meta&accounts=a1,a3&status=connected"),
      ),
    ).toBe("/?preset=last_7_days&accounts=a2");
  });
});

describe("navigateToAuthorization", () => {
  it.each([
    "https://accounts.google.com/o/oauth2/v2/auth?state=s&code_challenge=c",
    "http://127.0.0.1:3211/oauth/callback?state=s&code=mock",
  ])("follows an http(s) URL in the same tab: %s", (url) => {
    const assign = vi.fn();
    navigateToAuthorization(url, assign);
    expect(assign).toHaveBeenCalledExactlyOnceWith(url);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "not a url",
    "",
  ])("never follows %s", (url) => {
    const assign = vi.fn();
    expect(() => navigateToAuthorization(url, assign)).toThrow();
    expect(assign).not.toHaveBeenCalled();
  });

  it("does not put the URL into the error", () => {
    const error = (() => {
      try {
        navigateToAuthorization("javascript:secret-state", vi.fn());
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).not.toContain("secret-state");
  });
});

describe("Google Ads connection choice", () => {
  const meta = connection({ id: "m1", provider: "meta" });
  const old = connection({ id: "g1", connectedAt: "2026-01-01T00:00:00.000Z" });
  const recent = connection({ id: "g2", connectedAt: "2026-03-01T00:00:00.000Z" });
  const broken = connection({
    id: "g3",
    status: "needs_reauth",
    connectedAt: "2026-04-01T00:00:00.000Z",
  });
  const revoked = connection({
    id: "g4",
    status: "revoked",
    connectedAt: "2026-05-01T00:00:00.000Z",
  });

  it("keeps usable Google Ads connections only, newest first", () => {
    expect(googleAdsConnections([old, meta, revoked, broken, recent]).map((c) => c.id)).toEqual([
      "g3",
      "g2",
      "g1",
    ]);
  });

  it("prefers the requested connection, else the newest active, else the newest", () => {
    const usable = googleAdsConnections([old, broken, recent]);
    expect(pickConnection(usable, "g1")?.id).toBe("g1");
    expect(pickConnection(usable, undefined)?.id).toBe("g2");
    expect(pickConnection(usable, "unknown-id")?.id).toBe("g2");
    expect(pickConnection(googleAdsConnections([broken]), undefined)?.id).toBe("g3");
    expect(pickConnection([], "g1")).toBeUndefined();
  });

  it("never picks another provider's or a revoked connection", () => {
    expect(pickConnection(googleAdsConnections([meta, revoked]), "g4")).toBeUndefined();
  });
});
