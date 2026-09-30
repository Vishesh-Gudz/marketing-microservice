import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  credentialAad,
  decryptJson,
  DecryptionError,
  encryptJson,
  EncryptionConfigError,
  loadKeyRing,
  pkceChallengeS256,
  randomToken,
  sha256Base64Url,
} from "./crypto";

const key = (fill: number) => base64UrlEncode(new Uint8Array(32).fill(fill)).replace(/-/g, "+");
const RING_V1 = JSON.stringify({ "1": key(1) });
const RING_V1_V2 = JSON.stringify({ "1": key(1), "2": key(2) });
const AAD = credentialAad("orgA", "meta", "user-1");
const SECRET = { kind: "mock", token: "super-secret-token-value" };

describe("key ring", () => {
  it("uses the highest version as active", async () => {
    expect((await loadKeyRing(RING_V1)).activeVersion).toBe(1);
    expect((await loadKeyRing(RING_V1_V2)).activeVersion).toBe(2);
  });

  it("fails closed when TOKEN_ENCRYPTION_KEYS is unset", async () => {
    const saved = process.env.TOKEN_ENCRYPTION_KEYS;
    delete process.env.TOKEN_ENCRYPTION_KEYS;
    try {
      await expect(loadKeyRing()).rejects.toBeInstanceOf(EncryptionConfigError);
    } finally {
      process.env.TOKEN_ENCRYPTION_KEYS = saved;
    }
  });

  it.each([
    ["empty", ""],
    ["not JSON", "nope"],
    ["an array", "[]"],
    ["no keys", "{}"],
    ["bad version", JSON.stringify({ zero: key(1) })],
    ["short key", JSON.stringify({ "1": base64UrlEncode(new Uint8Array(16)) })],
    ["non-string key", JSON.stringify({ "1": 42 })],
  ])("fails closed when %s", async (_label, raw) => {
    await expect(loadKeyRing(raw)).rejects.toBeInstanceOf(EncryptionConfigError);
  });
});

describe("AES-256-GCM with AAD", () => {
  it("round-trips and never stores plaintext", async () => {
    const ring = await loadKeyRing(RING_V1);
    const payload = await encryptJson(ring, SECRET, AAD);
    const bytes = new TextDecoder("latin1").decode(payload.ciphertext);
    expect(bytes).not.toContain("super-secret-token-value");
    expect(payload.keyVersion).toBe(1);
    expect(await decryptJson(ring, payload, AAD)).toEqual(SECRET);
  });

  it("uses a fresh 96-bit IV every time", async () => {
    const ring = await loadKeyRing(RING_V1);
    const ivs = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const { iv } = await encryptJson(ring, SECRET, AAD);
      expect(iv.byteLength).toBe(12);
      ivs.add(base64UrlEncode(iv));
    }
    expect(ivs.size).toBe(20);
  });

  it("rejects a credential moved to another org, provider or identity (AAD)", async () => {
    const ring = await loadKeyRing(RING_V1);
    const payload = await encryptJson(ring, SECRET, AAD);
    for (const aad of [
      credentialAad("orgB", "meta", "user-1"),
      credentialAad("orgA", "google_ads", "user-1"),
      credentialAad("orgA", "meta", "user-2"),
    ]) {
      await expect(decryptJson(ring, payload, aad)).rejects.toBeInstanceOf(DecryptionError);
    }
  });

  it("rejects tampered ciphertext or IV and unknown key versions", async () => {
    const ring = await loadKeyRing(RING_V1);
    const payload = await encryptJson(ring, SECRET, AAD);
    const flipped = new Uint8Array(payload.ciphertext.slice(0));
    flipped[0] = flipped[0]! ^ 0xff;
    await expect(
      decryptJson(ring, { ...payload, ciphertext: flipped.buffer }, AAD),
    ).rejects.toBeInstanceOf(DecryptionError);
    const iv = new Uint8Array(payload.iv.slice(0));
    iv[0] = iv[0]! ^ 0xff;
    await expect(decryptJson(ring, { ...payload, iv: iv.buffer }, AAD)).rejects.toBeInstanceOf(
      DecryptionError,
    );
    await expect(decryptJson(ring, { ...payload, keyVersion: 9 }, AAD)).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it("decrypts old versions after rotation and encrypts with the new one", async () => {
    const old = await encryptJson(await loadKeyRing(RING_V1), SECRET, AAD);
    const rotated = await loadKeyRing(RING_V1_V2);
    expect(await decryptJson(rotated, old, AAD)).toEqual(SECRET);
    expect((await encryptJson(rotated, SECRET, AAD)).keyVersion).toBe(2);
  });

  it("fails with a different key", async () => {
    const payload = await encryptJson(await loadKeyRing(RING_V1), SECRET, AAD);
    const other = await loadKeyRing(JSON.stringify({ "1": key(9) }));
    await expect(decryptJson(other, payload, AAD)).rejects.toBeInstanceOf(DecryptionError);
  });
});

describe("OAuth randomness and hashing", () => {
  it("produces 256-bit base64url tokens that do not repeat", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => randomToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("matches the RFC 7636 S256 test vector", async () => {
    expect(await pkceChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("hashes deterministically", async () => {
    expect(await sha256Base64Url("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });
});
