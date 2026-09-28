import { describe, expect, it } from "vitest";
import {
  CursorTooLargeError,
  decodeGoogleCursor,
  encodeGoogleCursor,
  MAX_CURSOR_LENGTH,
  type GoogleCursorPosition,
} from "./cursor";

// Phase 9: the request-bound staged cursor (stage, page token, offset, route, carry, flush,
// discovery state), strictly validated and size-capped.

const forged = (payload: unknown) =>
  `g1.${btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

describe("Google cursor codec", () => {
  it.each<GoogleCursorPosition>([
    { stage: 0, offset: 500, route: "1110000001" },
    { stage: 0, pageToken: "pt_abc_10000", offset: 1500, route: "2220000001" },
    { stage: 1, route: "2220000001" },
    { stage: 1, pageToken: "pt_x", route: "2220000001", carry: [{ r: { a: 1 } }] },
    { stage: 1, flush: true, carry: [{ r: { a: 1 } }], route: "2220000001" },
    { stage: 0, index: 2, seen: ["1110000001", "2220000001"] },
    { stage: 0, hierarchy: true, pageToken: "pt_y", offset: 3, seen: ["1110000001"] },
    {
      stage: 1,
      route: "2220000001",
      lookup: { included: ["900000001"], excluded: ["900000002"] },
    },
    {
      stage: 0,
      offset: 2,
      route: "2220000001",
      lookup: { included: [], excluded: [] },
    },
  ])("round-trips %j", (position) => {
    const cursor = encodeGoogleCursor("fp1", position);
    expect(cursor.startsWith("g1.")).toBe(true);
    expect(decodeGoogleCursor(cursor, "fp1", "fetchDailyMetrics")).toEqual(position);
  });

  it.each<[string, GoogleCursorPosition]>([
    ["a first page", { stage: 0 }],
    ["a route only", { stage: 0, route: "2220000001" }],
    ["offset 0", { stage: 0, offset: 0 }],
    ["offset beyond a Google page", { stage: 0, offset: 10_001 }],
    ["a malformed route", { stage: 1, route: "123" }],
    ["a flush without carry", { stage: 1, flush: true }],
    ["a flush with a page", { stage: 1, flush: true, carry: [{}], pageToken: "x" }],
    ["an empty carry", { stage: 1, carry: [] }],
    ["a non-printable page token", { stage: 0, pageToken: "has space" }],
    ["a bad seen id", { stage: 0, index: 1, seen: ["abc"] }],
    ["stage out of range", { stage: 8, route: "2220000001" }],
    ["a lookup id that is not digits", { stage: 1, lookup: { included: ["x"], excluded: [] } }],
    [
      "an id both included and excluded",
      { stage: 1, lookup: { included: ["1"], excluded: ["1"] } },
    ],
  ])("refuses to encode %s", (_label, position) => {
    expect(() => encodeGoogleCursor("fp1", position)).toThrow();
  });

  it.each([
    ["another request", encodeGoogleCursor("fp1", { stage: 1 }), "fp2"],
    ["garbage", "garbage", "fp1"],
    ["the Meta prefix", "m1.eyJ2IjoxfQ", "fp1"],
    ["bad base64", "g1.***", "fp1"],
    ["oversized", `g1.${"A".repeat(MAX_CURSOR_LENGTH)}`, "fp1"],
    ["an unknown key", forged({ v: 1, fp: "fp1", s: 1, x: 1 }), "fp1"],
    ["explicit stage 0", forged({ v: 1, fp: "fp1", s: 0, o: 5 }), "fp1"],
    ["a forged first page", forged({ v: 1, fp: "fp1" }), "fp1"],
    ["a non-string token", forged({ v: 1, fp: "fp1", t: 5 }), "fp1"],
    ["a bad flush flag", forged({ v: 1, fp: "fp1", s: 1, f: true, c: [{}] }), "fp1"],
    ["a bad phase", forged({ v: 1, fp: "fp1", p: "x", i: 1 }), "fp1"],
    ["a negative offset", forged({ v: 1, fp: "fp1", o: -1 }), "fp1"],
    ["a lookup of the wrong shape", forged({ v: 1, fp: "fp1", s: 1, l: ["1"] }), "fp1"],
    [
      "a lookup with extra keys",
      forged({ v: 1, fp: "fp1", s: 1, l: { y: [], n: [], z: [] } }),
      "fp1",
    ],
    ["a lookup with bad ids", forged({ v: 1, fp: "fp1", s: 1, l: { y: ["a"], n: [] } }), "fp1"],
  ])("rejects %s with invalid_request", (_label, cursor, fp) => {
    expect(() => decodeGoogleCursor(cursor, fp, "listCampaigns")).toThrow(
      expect.objectContaining({ kind: "invalid_request", providerCode: "cursor_invalid" }),
    );
  });

  it("refuses to build a cursor beyond the size cap", () => {
    const carry = Array.from({ length: 5_000 }, (_, i) => ({
      r: { entityExternalId: String(i), date: "2026-03-02", placement: "other", impressions: i },
    }));
    expect(() =>
      encodeGoogleCursor("fp1", { stage: 1, pageToken: "pt", carry, route: "2220000001" }),
    ).toThrow(CursorTooLargeError);
  });

  it("never contains tokens or URLs", () => {
    const cursor = encodeGoogleCursor("fp1", {
      stage: 0,
      pageToken: "pt_a_1",
      route: "2220000001",
    });
    const decoded = atob(cursor.slice(3).replace(/-/g, "+").replace(/_/g, "/"));
    expect(decoded).not.toMatch(/test-(access|refresh)|http|developer/);
  });
});
