import { describe, expect, it } from "vitest";
import { CONFIRMATION_CODE } from "./config";
import { FAKE_CALLBACK_SECRET, payloadFor, signRequest } from "./signedRequest.fixtures";
import { newConfirmationCode, requestKeyOf, verifySignedRequest } from "./signedRequest";

// Meta's signed_request (ADR 0017 IM6): verified over the payload segment as sent, before the
// payload is read; then only HMAC-SHA256 and a decimal user id are accepted.

const USER = "9000000000000301";

async function verify(value: string, secret = FAKE_CALLBACK_SECRET) {
  return await verifySignedRequest(value, secret);
}

describe("verifySignedRequest", () => {
  it("accepts Meta's documented format and returns the user id and payload segment", async () => {
    const signed = await signRequest(payloadFor(USER, 1_793_000_000));
    expect(await verify(signed)).toEqual({
      ok: true,
      request: {
        userId: USER,
        issuedAtMs: 1_793_000_000_000,
        payloadSegment: signed.split(".")[1],
      },
    });
    // Padding is tolerated on both segments (base64url with "=").
    const [sig, payload] = signed.split(".");
    const padded = await verify(`${sig}=.${payload}`);
    expect(padded.ok).toBe(true);
  });

  it("refuses another secret and any change to the payload", async () => {
    const signed = await signRequest(payloadFor(USER));
    expect(await verify(signed, "another-secret-value")).toEqual({
      ok: false,
      reason: "signature",
    });
    const other = (await signRequest(payloadFor("9000000000000999"))).split(".")[1];
    expect(await verify(`${signed.split(".")[0]}.${other}`)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it.each([
    ["empty", ""],
    ["no separator", "abcdef"],
    ["empty signature", ".eyJ9"],
    ["a third segment", "abc.def.ghi"],
    ["characters outside base64url", "ab+c.def"],
    ["a short signature", "YWJj.eyJ9"],
    ["oversized", `${"a".repeat(43)}.${"b".repeat(5000)}`],
  ])("refuses a malformed value (%s) without checking it", async (_case, value) => {
    expect(await verify(value)).toEqual({ ok: false, reason: "malformed" });
  });

  it.each([
    ["another algorithm", { ...payloadFor(USER), algorithm: "HMAC-SHA1" }],
    ["no algorithm", { user_id: USER }],
    ["no user id", { algorithm: "HMAC-SHA256" }],
    ["a numeric user id", { algorithm: "HMAC-SHA256", user_id: 9000000000000301 }],
    ["a non-decimal user id", { algorithm: "HMAC-SHA256", user_id: "abc" }],
    ["a non-numeric issued_at", { ...payloadFor(USER), issued_at: "soon" }],
    ["a negative issued_at", { ...payloadFor(USER), issued_at: -1 }],
    ["an array", [USER]],
  ])("refuses a correctly signed payload with %s", async (_case, payload) => {
    expect(await verify(await signRequest(payload))).toEqual({ ok: false, reason: "payload" });
  });

  it("refuses a correctly signed segment that is not JSON", async () => {
    const encoder = new TextEncoder();
    const segment = btoa("not json").replace(/=+$/, "");
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(FAKE_CALLBACK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(segment)));
    const sigSegment = btoa(String.fromCharCode(...sig))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verify(`${sigSegment}.${segment}`)).toEqual({ ok: false, reason: "payload" });
  });
});

describe("helpers", () => {
  it("keys the request key with the secret and the callback kind", async () => {
    const key = await requestKeyOf("secret-one-value", "data_deletion", "payload");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await requestKeyOf("secret-one-value", "data_deletion", "payload")).toBe(key);
    expect(await requestKeyOf("secret-two-value", "data_deletion", "payload")).not.toBe(key);
    expect(await requestKeyOf("secret-one-value", "data_deletion", "payload2")).not.toBe(key);
  });

  it("draws unbiased alphanumeric confirmation codes", () => {
    const codes = new Set(Array.from({ length: 50 }, () => newConfirmationCode()));
    expect(codes.size).toBe(50);
    for (const code of codes) expect(code).toMatch(CONFIRMATION_CODE);
  });
});
