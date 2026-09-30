/**
 * Credential encryption and OAuth randomness (Phase 4). Web Crypto only.
 *
 * SECURITY RULES
 * - Call these from ACTIONS only. Query/mutation randomness is a deterministic,
 *   seeded PRNG in Convex, so nonces/verifiers must never be generated there,
 *   and plaintext credentials must never pass through queries/mutations.
 * - `decryptJson` may only be used by convex/connections/credentialStore.ts
 *   (ESLint enforced): it is the single decryption path.
 * - Keys come from the TOKEN_ENCRYPTION_KEYS Convex env var:
 *     {"1":"<base64 32 bytes>", "2":"<base64 32 bytes>"}   (highest version encrypts; all decrypt)
 *   Missing/malformed keys fail closed.
 */

export const CREDENTIAL_ALGORITHM = "AES-256-GCM" as const;
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class EncryptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionConfigError";
  }
}

export class DecryptionError extends Error {
  constructor(message = "Credential could not be decrypted") {
    super(message);
    this.name = "DecryptionError";
  }
}

export type KeyRing = { activeVersion: number; keys: ReadonlyMap<number, CryptoKey> };

export type EncryptedPayload = { ciphertext: ArrayBuffer; iv: ArrayBuffer; keyVersion: number };

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Decode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Parses and imports TOKEN_ENCRYPTION_KEYS. Throws EncryptionConfigError (fail closed). */
export async function loadKeyRing(
  raw: string | undefined = process.env.TOKEN_ENCRYPTION_KEYS,
): Promise<KeyRing> {
  if (!raw || raw.trim() === "") {
    throw new EncryptionConfigError("TOKEN_ENCRYPTION_KEYS is not configured");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EncryptionConfigError("TOKEN_ENCRYPTION_KEYS must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EncryptionConfigError("TOKEN_ENCRYPTION_KEYS must be a JSON object");
  }

  const keys = new Map<number, CryptoKey>();
  for (const [versionText, encoded] of Object.entries(parsed as Record<string, unknown>)) {
    const version = Number(versionText);
    if (!Number.isInteger(version) || version < 1) {
      throw new EncryptionConfigError("Key versions must be positive integers");
    }
    if (typeof encoded !== "string") {
      throw new EncryptionConfigError(`Key ${version} must be a base64 string`);
    }
    let bytes: Uint8Array;
    try {
      bytes = base64Decode(encoded);
    } catch {
      throw new EncryptionConfigError(`Key ${version} is not valid base64`);
    }
    if (bytes.byteLength !== KEY_BYTES) {
      throw new EncryptionConfigError(`Key ${version} must be exactly ${KEY_BYTES} bytes`);
    }
    keys.set(
      version,
      await crypto.subtle.importKey("raw", toArrayBuffer(bytes), "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]),
    );
  }
  if (keys.size === 0) throw new EncryptionConfigError("TOKEN_ENCRYPTION_KEYS has no keys");
  return { activeVersion: Math.max(...keys.keys()), keys };
}

/** AAD binding a credential to its connection's natural key (moving it fails authentication). */
export function credentialAad(orgId: string, provider: string, externalUserId: string): string {
  return `${orgId}|${provider}|${externalUserId}|v1`;
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

export async function encryptJson(
  ring: KeyRing,
  value: unknown,
  aad: string,
): Promise<EncryptedPayload> {
  const key = ring.keys.get(ring.activeVersion)!;
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return { ciphertext, iv: toArrayBuffer(iv), keyVersion: ring.activeVersion };
}

/** ONLY for convex/connections/credentialStore.ts (lint enforced). */
export async function decryptJson(
  ring: KeyRing,
  payload: EncryptedPayload,
  aad: string,
): Promise<unknown> {
  const key = ring.keys.get(payload.keyVersion);
  if (!key) throw new DecryptionError("Unknown encryption key version");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(payload.iv), additionalData: encoder.encode(aad) },
      key,
      payload.ciphertext,
    );
  } catch {
    // Tampered ciphertext/IV, wrong key, or wrong AAD (credential moved to another connection).
    throw new DecryptionError();
  }
  return JSON.parse(decoder.decode(plaintext));
}

// ---------------------------------------------------------------------------
// OAuth randomness / hashing (actions only)
// ---------------------------------------------------------------------------

/** Cryptographically random base64url token (default 256 bits). */
export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Base64Url(input: string): Promise<string> {
  return base64UrlEncode(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

/** RFC 7636 S256 code challenge. */
export async function pkceChallengeS256(verifier: string): Promise<string> {
  return sha256Base64Url(verifier);
}
