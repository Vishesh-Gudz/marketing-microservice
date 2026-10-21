import { describe, expect, it } from "vitest";
import {
  CALLBACK_ERRORS,
  CONNECT_RESULT_PARAMS,
  connectResultNotice,
  parseConnectResult,
  withoutConnectResult,
  type ConnectResult,
} from "./connect-result";

const ID = "jd7c8a3r9x2m4k6p1q5s0t7v8w9y2z3b";
const parse = (query: string) => parseConnectResult(new URLSearchParams(query));

describe("parseConnectResult", () => {
  it("is none without result parameters (filters only)", () => {
    expect(parse("")).toEqual({ kind: "none" });
    expect(parse("from=2026-03-01&to=2026-03-07&accounts=a1")).toEqual({ kind: "none" });
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

  it("removes repeated result parameters and any stray OAuth code / state", () => {
    const next = withoutConnectResult(
      new URLSearchParams("status=a&status=b&code=4%2Fabc&state=s3cr3t&tab=x"),
    );
    expect(next.toString()).toBe("tab=x");
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

  it("confirms a connection, or warns when discovery failed", () => {
    expect(
      connectResultNotice({ kind: "connected", connectionId: ID, discoveryFailed: false }),
    ).toMatchObject({ tone: "success", title: "Google Ads connected" });
    expect(
      connectResultNotice({ kind: "connected", connectionId: ID, discoveryFailed: true }),
    ).toMatchObject({ tone: "warning" });
  });

  it("has fixed text for every callback error and for unknown codes", () => {
    const seen = new Set<string>();
    for (const error of [...CALLBACK_ERRORS, "unknown" as const]) {
      const notice = connectResultNotice({ kind: "error", error })!;
      expect(notice.title.length).toBeGreaterThan(0);
      expect(notice.message.length).toBeGreaterThan(0);
      expect(["warning", "error"]).toContain(notice.tone);
      // The raw code is never part of the text.
      expect(`${notice.title} ${notice.message}`).not.toContain(error);
      seen.add(notice.title);
    }
    expect(seen.size).toBe(CALLBACK_ERRORS.length + 1);
  });

  it("access_denied is a warning (the user's choice), not a failure", () => {
    expect(connectResultNotice({ kind: "error", error: "access_denied" })!.tone).toBe("warning");
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
