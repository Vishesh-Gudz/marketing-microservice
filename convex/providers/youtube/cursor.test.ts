import { describe, expect, it } from "vitest";
import { isProviderError } from "../errors";
import {
  decodeYouTubeCursor,
  encodeYouTubeCursor,
  MAX_CURSOR_LENGTH,
  youtubeRequestFingerprint,
} from "./cursor";

// ADR 0016: yt1. cursors are bound to their request and carry only a playlist id and a page
// token; anything else fails closed.

const OP = "listSocialPosts" as const;
const FP = youtubeRequestFingerprint(OP, ["UCfakeChannel0000000000a"]);
const POSITION = { playlistId: "UUfakeChannel0000000000a", pageToken: "EAAaBlBUOkNESQ" };

function base64Url(value: string) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function errorOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

describe("YouTube cursor", () => {
  it("round-trips a position for the same request", () => {
    const cursor = encodeYouTubeCursor(FP, OP, POSITION);
    expect(cursor.startsWith("yt1.")).toBe(true);
    expect(cursor).not.toContain(POSITION.pageToken);
    expect(decodeYouTubeCursor(cursor, FP, OP)).toEqual(POSITION);
  });

  it("is bound to the request fingerprint", () => {
    const cursor = encodeYouTubeCursor(FP, OP, POSITION);
    const other = youtubeRequestFingerprint(OP, ["UCotherChannel000000000a"]);
    const error = errorOf(() => decodeYouTubeCursor(cursor, other, OP));
    expect(isProviderError(error) && [error.kind, error.providerCode]).toEqual([
      "invalid_request",
      "cursor_invalid",
    ]);
  });

  it.each([
    ["another prefix", "ig1.abc"],
    ["not base64url", "yt1.***"],
    ["not JSON", `yt1.${base64Url("nope")}`],
    [
      "an extra key",
      `yt1.${base64Url(JSON.stringify({ v: 1, fp: FP, ...{ p: POSITION.playlistId, t: "x" }, x: 1 }))}`,
    ],
    [
      "another version",
      `yt1.${base64Url(JSON.stringify({ v: 2, fp: FP, p: POSITION.playlistId, t: "x" }))}`,
    ],
    ["a bad playlist id", `yt1.${base64Url(JSON.stringify({ v: 1, fp: FP, p: "a/b", t: "x" }))}`],
    [
      "a bad page token",
      `yt1.${base64Url(JSON.stringify({ v: 1, fp: FP, p: POSITION.playlistId, t: "a b" }))}`,
    ],
    ["an oversized cursor", `yt1.${"A".repeat(MAX_CURSOR_LENGTH)}`],
  ])("rejects %s", (_label, cursor) => {
    const error = errorOf(() => decodeYouTubeCursor(cursor, FP, OP));
    expect(isProviderError(error) && error.kind).toBe("invalid_request");
  });

  it("refuses to encode a position it cannot carry safely", () => {
    const error = errorOf(() =>
      encodeYouTubeCursor(FP, OP, { playlistId: POSITION.playlistId, pageToken: "has space" }),
    );
    expect(isProviderError(error) && [error.kind, error.providerCode]).toEqual([
      "data",
      "cursor_unexpected",
    ]);
  });
});
