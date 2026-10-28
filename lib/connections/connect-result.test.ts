import { describe, expect, it } from "vitest";
import { apiError } from "@/convex/lib/errors";
import {
  CALLBACK_ERRORS,
  claimErrorNotice,
  CONNECT_RESULT_PARAMS,
  connectResultNotice,
  parseConnectResult,
  withoutConnectResult,
  type ConnectResult,
} from "./connect-result";

const ID = "jd7c8a3r9x2m4k6p1q5s0t7v8w9y2z3b";
const CLAIM = "Aa0_-".repeat(8) + "xyz"; // 43 base64url characters
const parse = (query: string) => parseConnectResult(new URLSearchParams(query));

describe("parseConnectResult", () => {
  it("is none without result parameters (filters only)", () => {
    expect(parse("")).toEqual({ kind: "none" });
    expect(parse("from=2026-03-01&to=2026-03-07&accounts=a1")).toEqual({ kind: "none" });
    // A provider hint alone is not a result.
    expect(parse("connect=meta")).toEqual({ kind: "none" });
  });

  it("reads exactly one known provider hint, and ignores any other", () => {
    expect(parse(`status=connected&connection=${ID}&connect=meta`)).toEqual({
      kind: "connected",
      connectionId: ID,
      discoveryFailed: false,
      provider: "meta",
    });
    expect(parse("status=error&error=identity_mismatch&connect=google_ads")).toEqual({
      kind: "error",
      error: "identity_mismatch",
      provider: "google_ads",
    });
    for (const hint of ["instagram", "META", "", "meta&connect=meta", "google_ads&connect=meta"]) {
      expect(parse(`status=error&error=internal&connect=${hint}`)).toEqual({
        kind: "error",
        error: "internal",
      });
    }
    expect(parse("status=nope&connect=meta")).toEqual({ kind: "malformed", provider: "meta" });
  });

  it("reads a successful connection", () => {
    expect(parse(`status=connected&connection=${ID}`)).toEqual({
      kind: "connected",
      connectionId: ID,
      discoveryFailed: false,
    });
  });

  it("reads a connection whose discovery failed", () => {
    expect(parse(`status=connected&connection=${ID}&warning=discovery_failed`)).toEqual({
      kind: "connected",
      connectionId: ID,
      discoveryFailed: true,
    });
  });

  it("ignores an unknown warning (never displayed)", () => {
    expect(parse(`status=connected&connection=${ID}&warning=something_new`)).toEqual({
      kind: "connected",
      connectionId: ID,
      discoveryFailed: false,
    });
  });

  it.each(CALLBACK_ERRORS)("reads the callback error %s", (code) => {
    expect(parse(`status=error&error=${code}`)).toEqual({ kind: "error", error: code });
  });

  it.each([
    ["missing", "status=error"],
    ["empty", "status=error&error="],
    ["unlisted", "status=error&error=invalid_client"],
    ["differently cased", "status=error&error=ACCESS_DENIED"],
    ["prototype key", "status=error&error=toString"],
    ["markup", "status=error&error=%3Cscript%3Ealert(1)%3C%2Fscript%3E"],
  ])("collapses a %s error code to unknown", (_label, query) => {
    expect(parse(query)).toEqual({ kind: "error", error: "unknown" });
  });

  it.each([
    ["an unknown status", "status=pending"],
    ["an empty status", "status="],
    ["a status-less connection id", `connection=${ID}`],
    ["a status-less error", "error=access_denied"],
    ["connected without an id", "status=connected"],
    ["connected with an empty id", "status=connected&connection="],
    ["connected with an upper-case id", `status=connected&connection=${ID.toUpperCase()}`],
    ["connected with a path", "status=connected&connection=..%2Fadmin"],
    ["connected with markup", "status=connected&connection=%3Cimg%3E"],
    ["connected with an over-long id", `status=connected&connection=${"a".repeat(65)}`],
    ["connected and an error", `status=connected&connection=${ID}&error=internal`],
    ["a repeated status", `status=connected&status=error&connection=${ID}`],
    ["a repeated connection", `status=connected&connection=${ID}&connection=abc`],
    ["a repeated error", "status=error&error=internal&error=access_denied"],
    ["a repeated warning", `status=connected&connection=${ID}&warning=a&warning=b`],
  ])("treats %s as malformed", (_label, query) => {
    expect(parse(query)).toEqual({ kind: "malformed" });
  });

  it("reads a pending consent with its one-time claim code (S2)", () => {
    expect(parse(`status=pending&claim=${CLAIM}&connect=meta`)).toEqual({
      kind: "pending",
      claim: CLAIM,
      provider: "meta",
    });
  });

  it("treats a malformed or contradictory pending result as malformed", () => {
    for (const query of [
      "status=pending",
      "status=pending&claim=short",
      `status=pending&claim=${CLAIM}x`,
      `status=pending&claim=${CLAIM.slice(0, 42)}%21`,
      `status=pending&claim=${CLAIM}&claim=${CLAIM}`,
      `status=pending&claim=${CLAIM}&connection=${ID}`,
      `status=pending&claim=${CLAIM}&error=internal`,
      `status=connected&connection=${ID}&claim=${CLAIM}`,
    ]) {
      expect(parse(query).kind, query).toBe("malformed");
    }
  });

  it("accepts a read-only params object (Next's useSearchParams)", () => {
    const params = new URLSearchParams(`status=connected&connection=${ID}`);
    const readOnly = { get: params.get.bind(params), getAll: params.getAll.bind(params) };
    expect(parseConnectResult(readOnly)).toMatchObject({ kind: "connected" });
  });
});

describe("withoutConnectResult", () => {
  it("removes every result parameter and keeps the rest", () => {
    const next = withoutConnectResult(
      new URLSearchParams(
        `from=2026-03-01&status=connected&connection=${ID}&warning=discovery_failed&accounts=a1,a2&error=x`,
      ),
    );
    expect(next.toString()).toBe("from=2026-03-01&accounts=a1%2Ca2");
    for (const name of CONNECT_RESULT_PARAMS) expect(next.has(name)).toBe(false);
  });

  it("removes repeated result parameters, the provider hint and any stray OAuth code / state", () => {
    const next = withoutConnectResult(
      new URLSearchParams("status=a&status=b&code=4%2Fabc&state=s3cr3t&tab=x&connect=meta"),
    );
    expect(next.toString()).toBe("tab=x");
  });

  it("removes the claim code (S2), so a reload or a shared link never replays it", () => {
    const next = withoutConnectResult(
      new URLSearchParams(`from=2026-03-01&status=pending&claim=${CLAIM}&connect=meta`),
    );
    expect(next.toString()).toBe("from=2026-03-01");
  });

  it("returns a copy", () => {
    const params = new URLSearchParams("status=connected");
    withoutConnectResult(params);
    expect(params.get("status")).toBe("connected");
  });
});

describe("connectResultNotice", () => {
  it("shows nothing without a result", () => {
    expect(connectResultNotice({ kind: "none" })).toBeNull();
  });

  it("confirms a connection, or warns when discovery failed, in the hinted provider's words", () => {
    const connected = (provider?: "google_ads" | "meta", discoveryFailed = false) =>
      connectResultNotice({
        kind: "connected",
        connectionId: ID,
        discoveryFailed,
        ...(provider ? { provider } : {}),
      });
    expect(connected("google_ads")).toMatchObject({
      tone: "success",
      title: "Google Ads connected",
    });
    expect(connected("meta")).toMatchObject({ tone: "success", title: "Meta Ads connected" });
    expect(connected()).toMatchObject({ tone: "success", title: "Connected" });
    expect(connected("google_ads", true)).toMatchObject({
      tone: "warning",
      title: "Google Ads connected, but your accounts could not be loaded",
    });
    expect(connected("meta", true)).toMatchObject({
      tone: "warning",
      title: "Meta Ads connected, but your accounts could not be loaded",
    });
  });

  it.each([["google_ads"], ["meta"], [undefined]] as const)(
    "has fixed text for every callback error and for unknown codes (provider %s)",
    (provider) => {
      const seen = new Set<string>();
      for (const error of [...CALLBACK_ERRORS, "unknown" as const]) {
        const notice = connectResultNotice({
          kind: "error",
          error,
          ...(provider ? { provider } : {}),
        })!;
        expect(notice.title.length).toBeGreaterThan(0);
        expect(notice.message.length).toBeGreaterThan(0);
        expect(["warning", "error"]).toContain(notice.tone);
        // The raw code is never part of the text.
        expect(`${notice.title} ${notice.message}`).not.toContain(error);
        // Never another provider's wording.
        const text = `${notice.title} ${notice.message}`;
        if (provider !== "google_ads") expect(text).not.toContain("Google");
        if (provider !== "meta") expect(text).not.toMatch(/Meta|Facebook/);
        seen.add(notice.title);
      }
      expect(seen.size).toBe(CALLBACK_ERRORS.length + 1);
    },
  );

  it("identity_mismatch explains how to switch accounts, per provider", () => {
    const notice = (provider?: "google_ads" | "meta") =>
      connectResultNotice({
        kind: "error",
        error: "identity_mismatch",
        ...(provider ? { provider } : {}),
      })!;
    expect(notice("google_ads").title).toBe("A different Google account was used");
    expect(notice("google_ads").message).toMatch(/disconnect Google Ads first, then connect again/);
    expect(notice("meta").title).toBe("A different Facebook account was used");
    expect(notice("meta").message).toBe(
      "Reconnect only accepts the Facebook account that created this connection. To use another Facebook account, an admin must disconnect Meta Ads first, then connect again.",
    );
    expect(notice().title).toBe("A different account was used");
  });

  it("exchange_failed names the account the user must sign in with", () => {
    const notice = (provider: "google_ads" | "meta") =>
      connectResultNotice({ kind: "error", error: "exchange_failed", provider })!;
    expect(notice("google_ads")).toMatchObject({
      title: "Google sign-in could not be completed",
      message:
        "Make sure the Google account you sign in with has access to a Google Ads account, then try again.",
    });
    expect(notice("meta")).toMatchObject({
      title: "Meta sign-in could not be completed",
      message:
        "Make sure the Facebook account you sign in with has access to a Meta ad account, then try again.",
    });
  });

  it("access_denied is a warning (the user's choice), not a failure", () => {
    expect(connectResultNotice({ kind: "error", error: "access_denied" })!.tone).toBe("warning");
  });

  it("a pending result says the connection is being finished, without the code", () => {
    const notice = connectResultNotice({ kind: "pending", claim: CLAIM, provider: "meta" });
    expect(notice).toMatchObject({ tone: "info", title: "Finishing the Meta Ads connection…" });
    expect(JSON.stringify(notice)).not.toContain(CLAIM);
  });

  it("a malformed result gets a neutral warning", () => {
    expect(connectResultNotice({ kind: "malformed" })).toMatchObject({ tone: "warning" });
  });

  it("never echoes parameter values, even for hostile input", () => {
    const hostile = [
      "status=error&error=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
      "status=connected&connection=%3Cimg%20src%3Dx%3E",
      "status=error&error=ya29.secret-token&state=s3cr3t&code=4%2Fcode",
      "status=%22%3E%3Cb%3E",
    ];
    for (const query of hostile) {
      const notice = connectResultNotice(parse(query) as ConnectResult);
      const text = JSON.stringify(notice);
      for (const fragment of ["script", "img", "ya29", "s3cr3t", "4/code", "<b>"]) {
        expect(text).not.toContain(fragment);
      }
    }
  });
});

describe("claimErrorNotice (S2)", () => {
  it("explains each refused claim with fixed text", () => {
    const invalid = claimErrorNotice(
      apiError("NOT_FOUND", "server text", { reason: "invalid_claim" }),
      "meta",
    );
    expect(invalid).toMatchObject({ tone: "error", title: "This connection request is not valid" });
    expect(invalid.message).toContain("another user or organization");
    expect(
      claimErrorNotice(apiError("CONFLICT", "server text", { reason: "expired_claim" })).title,
    ).toBe("The connection request expired");
    expect(
      claimErrorNotice(
        apiError("CONFLICT", "server text", { reason: "identity_mismatch" }),
        "google_ads",
      ).title,
    ).toBe("A different Google account was used");
    expect(claimErrorNotice(apiError("FORBIDDEN", "server text")).title).toBe("Admins only");
    expect(
      claimErrorNotice(
        apiError("INVALID_ARGUMENT", "server text", { reason: "connections_disabled" }),
        "meta",
      ).title,
    ).toBe("Meta Ads is not available");
  });

  it("never shows server messages; unknown errors get a generic notice", () => {
    for (const error of [
      new Error("ya29.secret-token"),
      apiError("INTERNAL", "ya29.secret-token"),
      "ya29.secret-token",
    ]) {
      const notice = claimErrorNotice(error, "meta");
      expect(notice.title).toBe("The connection could not be completed");
      expect(JSON.stringify(notice)).not.toContain("ya29");
    }
  });
});

describe("the YouTube provider hint (ADR 0016)", () => {
  it("words the result for YouTube", () => {
    const result = parse(`status=connected&connection=${ID}&connect=youtube`);
    expect(result).toEqual({
      kind: "connected",
      connectionId: ID,
      discoveryFailed: false,
      provider: "youtube",
    });
    expect(connectResultNotice(result)).toMatchObject({ title: "YouTube connected" });
    expect(
      connectResultNotice(parse("status=error&error=access_denied&connect=youtube")),
    ).toMatchObject({
      title: "YouTube access was not granted",
    });
    expect(parse("status=error&error=internal&connect=instagram")).toEqual({
      kind: "error",
      error: "internal",
    });
  });
});
