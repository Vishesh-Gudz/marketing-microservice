/** Credential understood by the mock provider. Real credentials arrive in Phase 4. */
export type MockCredential = { kind: "mock"; token: string };

/** Token value that makes every call fail with an "auth" error (revoked token). */
export const REVOKED_MOCK_TOKEN = "revoked";

export function mockCredential(token = "mock-token"): MockCredential {
  return { kind: "mock", token };
}

export function isMockCredential(value: unknown): value is MockCredential {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "mock" &&
    typeof (value as { token?: unknown }).token === "string"
  );
}
