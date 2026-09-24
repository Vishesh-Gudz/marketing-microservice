import { describe, expect, it } from "vitest";
import { isProviderError } from "./errors";
import {
  clampPageSize,
  collectAll,
  decodeOffsetCursor,
  encodeOffsetCursor,
  paginateArray,
} from "./pagination";

const options = {
  requestFingerprint: "abc123",
  defaultPageSize: 3,
  maxPageSize: 5,
  platform: "meta" as const,
  operation: "listCampaigns" as const,
};
const items = Array.from({ length: 11 }, (_, i) => i);

describe("page size", () => {
  it("clamps to 1..max with a default", () => {
    expect(clampPageSize(undefined, 3, 5)).toBe(3);
    expect(clampPageSize(0, 3, 5)).toBe(1);
    expect(clampPageSize(-4, 3, 5)).toBe(1);
    expect(clampPageSize(2.9, 3, 5)).toBe(2);
    expect(clampPageSize(99, 3, 5)).toBe(5);
    expect(clampPageSize(Number.NaN, 3, 5)).toBe(3);
  });
});

describe("cursors", () => {
  it("round-trip and are bound to their request", () => {
    const cursor = encodeOffsetCursor(6, "abc123");
    expect(decodeOffsetCursor(cursor, "abc123", "meta", "listAds")).toBe(6);
    for (const bad of [encodeOffsetCursor(6, "other"), "v1.x.abc123", "garbage", ""]) {
      let caught: unknown;
      try {
        decodeOffsetCursor(bad, "abc123", "meta", "listAds");
      } catch (error) {
        caught = error;
      }
      expect(isProviderError(caught) && caught.kind, bad).toBe("invalid_request");
    }
  });
});

describe("paginateArray", () => {
  it("returns every item exactly once across pages", async () => {
    for (const pageSize of [1, 2, 3, 5, 100]) {
      const { items: all, pages } = await collectAll(async (cursor) =>
        paginateArray(items, cursor ? { cursor, pageSize } : { pageSize }, options),
      );
      expect(all, `pageSize ${pageSize}`).toEqual(items);
      expect(pages).toBe(Math.ceil(items.length / Math.min(pageSize, 5)));
    }
  });

  it("omits nextCursor on the last page and handles empty results", () => {
    expect(paginateArray([], {}, options)).toEqual({ items: [] });
    const last = paginateArray(items, { cursor: encodeOffsetCursor(9, "abc123") }, options);
    expect(last).toEqual({ items: [9, 10] });
  });

  it("rejects cursors past the end", () => {
    expect(() =>
      paginateArray(items, { cursor: encodeOffsetCursor(50, "abc123") }, options),
    ).toThrow();
  });
});

describe("collectAll", () => {
  it("follows empty pages that still carry a cursor", async () => {
    const pages = [{ items: [], nextCursor: "a" }, { items: [1], nextCursor: "b" }, { items: [2] }];
    let i = 0;
    const result = await collectAll(async () => pages[i++]!);
    expect(result).toEqual({ items: [1, 2], pages: 3 });
  });

  it("fails instead of looping forever", async () => {
    await expect(
      collectAll(async () => ({ items: [], nextCursor: "loop" }), { maxPages: 5 }),
    ).rejects.toThrow(/did not terminate/);
  });
});
