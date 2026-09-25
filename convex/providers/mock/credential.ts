import { MOCK_SCENARIOS, type MockScenario } from "./scenarios";

/**
 * Credential understood by the mock provider. MOCK-ONLY test seam: `scenario`
 * and `variant` let a connection (and therefore a whole sync) select a
 * deterministic failure scenario or restated values. They override the
 * provider's construction options per call. Real credentials never carry them.
 */
export type MockCredential = {
  kind: "mock";
  token: string;
  scenario?: MockScenario;
  variant?: number;
};

/** Token value that makes every call fail with an "auth" error (revoked token). */
export const REVOKED_MOCK_TOKEN = "revoked";

export function mockCredential(
  token = "mock-token",
  options: { scenario?: MockScenario; variant?: number } = {},
): MockCredential {
  return {
    kind: "mock",
    token,
    ...(options.scenario !== undefined ? { scenario: options.scenario } : {}),
    ...(options.variant !== undefined ? { variant: options.variant } : {}),
  };
}

export function isMockCredential(value: unknown): value is MockCredential {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    kind?: unknown;
    token?: unknown;
    scenario?: unknown;
    variant?: unknown;
  };
  return (
    candidate.kind === "mock" &&
    typeof candidate.token === "string" &&
    (candidate.scenario === undefined ||
      (MOCK_SCENARIOS as readonly unknown[]).includes(candidate.scenario)) &&
    (candidate.variant === undefined ||
      (typeof candidate.variant === "number" && Number.isInteger(candidate.variant)))
  );
}
