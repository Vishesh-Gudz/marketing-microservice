import { describe, expect, it } from "vitest";
import { readConvexUrl } from "./env";

describe("readConvexUrl", () => {
  it("returns a valid URL unchanged", () => {
    expect(readConvexUrl("http://127.0.0.1:3210")).toBe("http://127.0.0.1:3210");
  });

  it("throws a setup hint when missing", () => {
    expect(() => readConvexUrl("")).toThrow(/NEXT_PUBLIC_CONVEX_URL is not set/);
  });

  it("rejects malformed values", () => {
    expect(() => readConvexUrl("not a url")).toThrow(/not a valid URL/);
  });
});
