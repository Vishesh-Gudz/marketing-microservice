import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetaAdsProvider } from ".";
import { expectProviderError } from "../contract.suite";
import type { MetaCredential } from "./credential";
import {
  CursorTooLargeError,
  decodeMetaCursor,
  decodeMetaCursorPosition,
  encodeMetaCursor,
  encodeMetaPosition,
  MAX_CURSOR_LENGTH,
} from "./cursor";
import { FAKE_APP_ID, FAKE_APP_SECRET, installFakeGraph } from "./fakeGraph.fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
});

const credential: MetaCredential = {
  kind: "meta",
  v: 1,
  accessToken: "test-long-u1",
  tokenType: "user",
  appId: FAKE_APP_ID,
  issuedAt: 1,
};

describe("Meta cursor codec (D15)", () => {
  it("round-trips Meta's after value for the same request fingerprint", () => {
    const cursor = encodeMetaCursor("fp1", "QVFIUmFiYzEyMw");
    expect(cursor.startsWith("m1.")).toBe(true);
    expect(decodeMetaCursor(cursor, "fp1", "listCampaigns")).toBe("QVFIUmFiYzEyMw");
  });

  it.each([
    ["another request", encodeMetaCursor("fp1", "abc"), "fp2"],
    ["garbage", "garbage", "fp1"],
    ["foreign prefix", "v1.3.abc", "fp1"],
    ["bad base64", "m1.***", "fp1"],
    ["garbage payload", `m1.${"A".repeat(5_000)}`, "fp1"],
    ["oversized", `m1.${"A".repeat(MAX_CURSOR_LENGTH)}`, "fp1"],
  ])("rejects %s with invalid_request", (_label, cursor, fp) => {
    expect(() => decodeMetaCursor(cursor, fp, "listCampaigns")).toThrow(
      expect.objectContaining({ kind: "invalid_request", providerCode: "cursor_invalid" }),
    );
  });

  it("refuses to encode a non-printable after value", () => {
    expect(() => encodeMetaCursor("fp", "has space")).toThrow();
  });

  it("carries the insights stage; a later stage may start without an after value (D16)", () => {
    const start = encodeMetaCursor("fp1", undefined, 1);
    expect(decodeMetaCursorPosition(start, "fp1", "fetchDailyMetrics")).toEqual({ stage: 1 });
    const inside = encodeMetaCursor("fp1", "QVFI", 1);
    expect(decodeMetaCursorPosition(inside, "fp1", "fetchDailyMetrics")).toEqual({
      stage: 1,
      after: "QVFI",
    });
    // Stage-0 cursors keep their Stage A encoding; decodeMetaCursor accepts stage 0 only.
    expect(decodeMetaCursorPosition(encodeMetaCursor("fp1", "abc"), "fp1", "listAds")).toEqual({
      stage: 0,
      after: "abc",
    });
    expect(() => decodeMetaCursor(inside, "fp1", "listAds")).toThrow(
      expect.objectContaining({ kind: "invalid_request" }),
    );
    expect(() => encodeMetaCursor("fp1", undefined, 0)).toThrow();
    expect(() => encodeMetaCursor("fp1", "abc", 99)).toThrow();
  });

  it("carries accumulated records and a flush marker (R9)", () => {
    const carry = [{ r: { entityExternalId: "4004", date: "2026-03-02", placement: "other" } }];
    const within = encodeMetaPosition("fp1", { stage: 1, after: "QVFI", carry });
    expect(decodeMetaCursorPosition(within, "fp1", "fetchDailyMetrics")).toEqual({
      stage: 1,
      after: "QVFI",
      carry,
    });
    const flush = encodeMetaPosition("fp1", { stage: 1, flush: true, carry });
    expect(decodeMetaCursorPosition(flush, "fp1", "fetchDailyMetrics")).toEqual({
      stage: 1,
      flush: true,
      carry,
    });
    // Listing cursors never accept stages, flushes or carries.
    expect(() => decodeMetaCursor(within, "fp1", "listAds")).toThrow();
    // A flush needs a carry and no paging cursor; a stage start carries nothing.
    expect(() => encodeMetaPosition("fp1", { stage: 1, flush: true })).toThrow();
    expect(() => encodeMetaPosition("fp1", { stage: 1, flush: true, after: "x", carry })).toThrow();
    expect(() => encodeMetaPosition("fp1", { stage: 1, carry })).toThrow();
  });

  it("carries the Graph row count of the next page together with the after value", () => {
    const cursor = encodeMetaPosition("fp1", { stage: 1, after: "QVFI", rows: 15 });
    expect(decodeMetaCursorPosition(cursor, "fp1", "fetchActionMetrics")).toEqual({
      stage: 1,
      after: "QVFI",
      rows: 15,
    });
    // A plain (entity listing) cursor never carries a row count.
    const stage0 = encodeMetaPosition("fp1", { stage: 0, after: "QVFI", rows: 15 });
    expect(() => decodeMetaCursor(stage0, "fp1", "listCampaigns")).toThrow(
      expect.objectContaining({ providerCode: "cursor_invalid" }),
    );
    for (const rows of [0, 1.5, 5001]) {
      expect(() => encodeMetaPosition("fp1", { stage: 0, after: "QVFI", rows })).toThrow();
    }
    expect(() => encodeMetaPosition("fp1", { stage: 1, rows: 15 })).toThrow();
  });

  it("refuses to build a cursor beyond the size cap (the engine fails closed)", () => {
    const carry = Array.from({ length: 5_000 }, (_, i) => ({
      r: { entityExternalId: String(i), date: "2026-03-02", placement: "other", impressions: i },
    }));
    expect(() => encodeMetaPosition("fp1", { stage: 1, after: "QVFI", carry })).toThrow(
      CursorTooLargeError,
    );
  });

  it.each([
    ["stage 0 without after", { v: 1, fp: "fp1" }],
    ["flush without carry", { v: 1, fp: "fp1", s: 1, f: 1 }],
    ["flush with after", { v: 1, fp: "fp1", s: 1, f: 1, after: "x", c: [{}] }],
    ["carry at a stage start", { v: 1, fp: "fp1", s: 1, c: [{}] }],
    ["empty carry", { v: 1, fp: "fp1", s: 1, after: "x", c: [] }],
    ["bad flush flag", { v: 1, fp: "fp1", s: 1, f: true, c: [{}] }],
    ["explicit stage 0", { v: 1, fp: "fp1", s: 0, after: "abc" }],
    ["negative stage", { v: 1, fp: "fp1", s: -1 }],
    ["fractional stage", { v: 1, fp: "fp1", s: 1.5 }],
    ["stage out of range", { v: 1, fp: "fp1", s: 8 }],
    ["row count without after", { v: 1, fp: "fp1", s: 1, l: 5 }],
    ["row count on a flush", { v: 1, fp: "fp1", s: 1, f: 1, l: 5, c: [{}] }],
    ["zero row count", { v: 1, fp: "fp1", after: "x", l: 0 }],
    ["fractional row count", { v: 1, fp: "fp1", after: "x", l: 2.5 }],
    ["row count beyond Graph's page size", { v: 1, fp: "fp1", after: "x", l: 5001 }],
    ["string row count", { v: 1, fp: "fp1", after: "x", l: "5" }],
  ])("rejects a forged cursor: %s", (_label, payload) => {
    const forged = `m1.${btoa(JSON.stringify(payload)).replace(/=+$/, "")}`;
    expect(() => decodeMetaCursorPosition(forged, "fp1", "fetchDailyMetrics")).toThrow(
      expect.objectContaining({ kind: "invalid_request", providerCode: "cursor_invalid" }),
    );
  });

  it("never contains tokens or URLs", async () => {
    installFakeGraph();
    const provider = createMetaAdsProvider({
      appId: FAKE_APP_ID,
      appSecret: FAKE_APP_SECRET,
    });
    const page = await provider.listCampaigns(
      { credential, attempt: 1 },
      { accountExternalId: "1001", pageSize: 1 },
    );
    const decoded = atob(page.nextCursor!.slice(3).replace(/-/g, "+").replace(/_/g, "/"));
    expect(decoded).not.toContain("test-long");
    expect(decoded).not.toContain("http");
    expect(decoded).not.toContain(FAKE_APP_SECRET);
  });

  it("binds cursors to the API version: a v26.0 cursor is rejected under v27.0 (D1)", async () => {
    installFakeGraph();
    const make = (version?: string) =>
      createMetaAdsProvider({
        ...(version ? { version } : {}),
        appId: FAKE_APP_ID,
        appSecret: FAKE_APP_SECRET,
      });
    const ctx = { credential, attempt: 1 };
    const first = await make().listCampaigns(ctx, { accountExternalId: "1001", pageSize: 1 });
    expect(first.nextCursor).toBeDefined();
    await expectProviderError(
      make("v27.0").listCampaigns(ctx, { accountExternalId: "1001", cursor: first.nextCursor! }),
      "invalid_request",
    );
    const same = await make().listCampaigns(ctx, {
      accountExternalId: "1001",
      cursor: first.nextCursor!,
    });
    expect(same.items.map((c) => c.externalId)).toEqual(["2002", "2003", "2004"]);
  });
});
