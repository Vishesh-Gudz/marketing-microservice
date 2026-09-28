import { describe, expect, it } from "vitest";
import { isProviderError } from "../errors";
import {
  decodeInstagramCursor,
  encodeInstagramCursor,
  instagramRequestFingerprint,
  MAX_CURSOR_LENGTH,
} from "./cursor";

// The Instagram provider cursor: opaque, request-bound, versioned, bounded, tamper-evident.

const OP = "listSocialPosts" as const;
const fp = instagramRequestFingerprint(OP, ["17841400000000101", 100]);
const SDK_CURSOR = "social-v1.%5B%22scope%22%2C%22QVFIUmx0%22%5D";

async function rejects(
  cursor: string,
  expectedFp = fp,
  operation: typeof OP | "fetchPostMetrics" = OP,
) {
  const error = await decodeInstagramCursor(cursor, expectedFp, operation).catch((e: unknown) => e);
  expect(
    isProviderError(error) &&
      error.kind === "invalid_request" &&
      error.providerCode === "cursor_invalid",
  ).toBe(true);
}

describe("Instagram cursor", () => {
  it("round-trips the inner position for the same request", async () => {
    const cursor = await encodeInstagramCursor(fp, OP, SDK_CURSOR);
    expect(cursor.startsWith("ig1.")).toBe(true);
    expect(cursor).not.toContain("social-v1");
    expect(await decodeInstagramCursor(cursor, fp, OP)).toBe(SDK_CURSOR);
  });

  it("is bound to the request fingerprint, the operation and the provider version", async () => {
    const cursor = await encodeInstagramCursor(fp, OP, SDK_CURSOR);
    await rejects(cursor, instagramRequestFingerprint(OP, ["17841400000000102", 100]));
    await rejects(cursor, instagramRequestFingerprint(OP, ["17841400000000101", 50]));
    await rejects(cursor, fp, "fetchPostMetrics");
  });

  it("detects tampering and truncation", async () => {
    const cursor = await encodeInstagramCursor(fp, OP, SDK_CURSOR);
    const [prefix, body, check] = [
      cursor.slice(0, 4),
      cursor.slice(4, cursor.lastIndexOf(".")),
      cursor.slice(cursor.lastIndexOf(".") + 1),
    ];
    const flipped = body.slice(0, -1) + (body.endsWith("A") ? "B" : "A");
    await rejects(`${prefix}${flipped}.${check}`);
    await rejects(`${prefix}${body}.${check.replace(/.$/, check.endsWith("0") ? "1" : "0")}`);
    await rejects(cursor.slice(0, -5));
    await rejects(`${prefix}${body}`);
    // A body re-encoded with a forged payload but the old checksum.
    const forged = btoa(JSON.stringify({ v: 1, fp, op: OP, c: "other" })).replace(/=+$/, "");
    await rejects(`${prefix}${forged}.${check}`);
  });

  it("rejects foreign, malformed and oversized cursors", async () => {
    for (const bad of [
      "",
      SDK_CURSOR,
      "m1.eyJ2IjoxfQ",
      "v1.10.abc",
      "ig1.",
      "ig1.!!!.00",
      `ig1.${"A".repeat(MAX_CURSOR_LENGTH)}.0`,
    ]) {
      await rejects(bad);
    }
  });

  it("refuses to carry unexpected inner positions", async () => {
    for (const inner of ["", "has space", "x".repeat(4_097), "café"]) {
      const error = await encodeInstagramCursor(fp, OP, inner).catch((e: unknown) => e);
      expect(isProviderError(error) && error.kind === "data").toBe(true);
    }
  });
});
