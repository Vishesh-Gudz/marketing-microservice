import type { AdPlatform } from "../../domain/types";
import { ProviderError } from "../errors";
import type { ProviderContext, ProviderOperation } from "../types";
import { isMockCredential, REVOKED_MOCK_TOKEN } from "./credential";

/**
 * Deterministic failure scenarios. Behavior depends ONLY on the request
 * (cursor presence, account) and ctx.attempt — never on hidden call counters —
 * so the same (request, attempt) always produces the same outcome.
 */
export const MOCK_SCENARIOS = [
  "default",
  "empty", //             every list returns no items
  "rate_limited", //      any non-first page fails on attempt 1 (retryAfterMs), succeeds on attempt >= 2
  "transient", //         first page fails on attempt 1, succeeds on attempt >= 2
  "auth_revoked", //      every call fails with "auth"
  "permission_denied", // one account per platform fails with "permission"
  "malformed", //         one raw record fails normalization -> "data"
  "slow_pages", //        page size forced to 1
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export const RATE_LIMIT_RETRY_AFTER_MS = 2_000;

export function applyScenarioGates(input: {
  scenario: MockScenario;
  platform: AdPlatform;
  operation: ProviderOperation;
  ctx: ProviderContext<unknown>;
  cursor: string | undefined;
  accountExternalId?: string;
  deniedAccountExternalId: string;
}): void {
  const { scenario, platform, operation, ctx, cursor } = input;
  const fail = (kind: ProviderError["kind"], message: string, retryAfterMs?: number) => {
    throw new ProviderError({
      kind,
      platform,
      operation,
      message,
      providerCode: `mock:${scenario}`,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  };

  if (!Number.isInteger(ctx.attempt) || ctx.attempt < 1) {
    fail("invalid_request", "ctx.attempt must be a positive integer");
  }
  if (!isMockCredential(ctx.credential)) fail("auth", "Mock provider requires a mock credential");
  if ((ctx.credential as { token: string }).token === REVOKED_MOCK_TOKEN) {
    fail("auth", "Mock token has been revoked");
  }

  switch (scenario) {
    case "auth_revoked":
      fail("auth", "Access token expired or revoked (mock scenario)");
      break;
    case "transient":
      if (cursor === undefined && ctx.attempt === 1)
        fail("transient", "Upstream 503 (mock scenario)");
      break;
    case "rate_limited":
      if (cursor !== undefined && ctx.attempt === 1) {
        fail("rate_limited", "Request limit reached (mock scenario)", RATE_LIMIT_RETRY_AFTER_MS);
      }
      break;
    case "permission_denied":
      if (input.accountExternalId === input.deniedAccountExternalId) {
        fail("permission", "No access to this ad account (mock scenario)");
      }
      break;
    default:
      break;
  }
}
