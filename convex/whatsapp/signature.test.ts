import { describe, expect, it } from "vitest";
import { FAKE_WA_APP_SECRET, signBody } from "./fakeWebhook.fixtures";
import { timingSafeEqualString, verifyWebhookSignature } from "./signature";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).buffer as ArrayBuffer;

describe("verifyWebhookSignature", () => {
  const body = '{"object":"whatsapp_business_account","entry":[]}';

  it("accepts the HMAC-SHA256 of the exact body under the app secret", async () => {
    const header = await signBody(body);
    expect(await verifyWebhookSignature(bytes(body), header, FAKE_WA_APP_SECRET)).toBe(true);
    expect(
      await verifyWebhookSignature(
        bytes(body),
        header.toUpperCase().replace("SHA256=", "sha256="),
        FAKE_WA_APP_SECRET,
      ),
    ).toBe(true);
  });

  it("rejects a signature made with another secret", async () => {
    const header = await signBody(body, "another-app-secret");
    expect(await verifyWebhookSignature(bytes(body), header, FAKE_WA_APP_SECRET)).toBe(false);
  });

  it("rejects any change to the body, including re-serialization", async () => {
    const header = await signBody(body);
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    expect(await verifyWebhookSignature(bytes(pretty), header, FAKE_WA_APP_SECRET)).toBe(false);
    expect(await verifyWebhookSignature(bytes(body + " "), header, FAKE_WA_APP_SECRET)).toBe(false);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["no prefix", "abc"],
    ["sha1 prefix", `sha1=${"a".repeat(40)}`],
    ["short digest", `sha256=${"a".repeat(63)}`],
    ["long digest", `sha256=${"a".repeat(65)}`],
    ["non-hex digest", `sha256=${"g".repeat(64)}`],
    ["two signatures", `sha256=${"a".repeat(64)},sha256=${"b".repeat(64)}`],
  ])("rejects a %s header", async (_label, header) => {
    expect(await verifyWebhookSignature(bytes(body), header, FAKE_WA_APP_SECRET)).toBe(false);
  });
});

describe("timingSafeEqualString", () => {
  it("compares by value", async () => {
    expect(await timingSafeEqualString("verify-token", "verify-token")).toBe(true);
    expect(await timingSafeEqualString("verify-token", "verify-tokeN")).toBe(false);
    expect(await timingSafeEqualString("verify-token", "verify-token-longer")).toBe(false);
    expect(await timingSafeEqualString("", "x")).toBe(false);
  });
});
