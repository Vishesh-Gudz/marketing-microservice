import type { AdPlatform } from "../../domain/types";
import { pkceChallengeS256 } from "../../lib/crypto";
import { ProviderError } from "../errors";
import { fingerprint } from "../hash";
import type { OAuthGrant, OAuthSpec } from "../oauth";
import { REVOKED_MOCK_TOKEN, type MockCredential } from "./credential";
import { MOCK_SCENARIOS, type MockScenario } from "./scenarios";

/**
 * Mock OAuth ("instant consent"). The authorization URL IS the callback URL,
 * carrying a code that encodes the mock user and the PKCE challenge, so the
 * whole connect flow runs end to end without any platform.
 *
 * Code format: mock-code.<user>.<fingerprint(platform, challenge, user)>
 *   user "limited" is granted none of the required scopes (missing-scope path);
 *   user "revoked" receives a credential the mock ads provider rejects (discovery failure path);
 *   user "<id>--<scenario>[--v<n>]" gets a credential that selects a mock scenario (see parseMockUser).
 * Failure codes: MOCK_INVALID_CODE (auth / invalid_grant), MOCK_UNAVAILABLE_CODE (transient).
 */
const SCOPES: Record<AdPlatform, { requested: string[]; required: string[]; lifetimeMs?: number }> =
  {
    // Mirrors Facebook Login for Business: ads_read + business_management; ~60 day user token.
    meta: {
      requested: ["ads_read", "business_management"],
      required: ["ads_read"],
      lifetimeMs: 60 * 24 * 60 * 60 * 1000,
    },
    // Mirrors Google OAuth: adwords + identity; refresh token, no fixed expiry.
    google_ads: {
      requested: ["https://www.googleapis.com/auth/adwords", "openid", "email"],
      required: ["https://www.googleapis.com/auth/adwords"],
    },
  };

/**
 * Mock user grammar: "<id>" or "<id>--<scenario>[--v<variant>]" (MOCK-ONLY test
 * seam, Phase 5). The identity is always mock-user-<id>, so reconnecting the
 * same id with another scenario replaces the credential of the SAME connection.
 * Example: "1--rate_limited", "1--default--v1" (restated metric values).
 */
export function parseMockUser(user: string): {
  id: string;
  scenario?: MockScenario;
  variant?: number;
} {
  const [id = "1", scenario, variant] = user.split("--");
  const parsedScenario = (MOCK_SCENARIOS as readonly string[]).includes(scenario ?? "")
    ? (scenario as MockScenario)
    : undefined;
  const parsedVariant = /^v\d{1,3}$/.test(variant ?? "") ? Number(variant!.slice(1)) : undefined;
  return {
    id,
    ...(parsedScenario !== undefined ? { scenario: parsedScenario } : {}),
    ...(parsedVariant !== undefined ? { variant: parsedVariant } : {}),
  };
}

export const MOCK_INVALID_CODE = "mock-code-invalid";
export const MOCK_UNAVAILABLE_CODE = "mock-code-5xx";

const CODE = /^mock-code\.([A-Za-z0-9_-]{1,32})\.([0-9a-z]+)$/;

function signature(platform: AdPlatform, challenge: string | undefined, user: string) {
  return fingerprint([platform, challenge ?? "", user]);
}

/** Test helper: the code the mock would issue for `user` with this PKCE challenge. */
export function mockAuthorizationCode(
  platform: AdPlatform,
  codeChallenge: string | undefined,
  user = "1",
): string {
  return `mock-code.${user}.${signature(platform, codeChallenge, user)}`;
}

export function createMockOAuthSpec(platform: AdPlatform): OAuthSpec<MockCredential> {
  const scopes = SCOPES[platform];

  const fail = (kind: "auth" | "transient", message: string): never => {
    throw new ProviderError({
      kind,
      platform,
      operation: "oauthExchange",
      message,
      providerCode: "mock",
    });
  };

  const tokenPrefix = `mock-token-${platform}-`;

  const grantFor = (user: string, now: number): OAuthGrant<MockCredential> => {
    const { id, scenario, variant } = parseMockUser(user);
    return {
      credential: {
        kind: "mock",
        token: id === "revoked" ? REVOKED_MOCK_TOKEN : `${tokenPrefix}${user}`,
        ...(scenario !== undefined ? { scenario } : {}),
        ...(variant !== undefined ? { variant } : {}),
      },
      identity: { externalUserId: `mock-user-${id}`, displayName: `Mock ${platform} user ${id}` },
      grantedScopes:
        id === "limited"
          ? scopes.requested.filter((scope) => !scopes.required.includes(scope))
          : [...scopes.requested],
      ...(scopes.lifetimeMs !== undefined ? { expiresAt: now + scopes.lifetimeMs } : {}),
      refreshable: scopes.lifetimeMs === undefined,
    };
  };

  const spec: OAuthSpec<MockCredential> = {
    platform,
    providerId: "mock",
    requestedScopes: scopes.requested,
    requiredScopes: scopes.required,
    usesPkce: true,

    buildAuthorizationUrl({ state, redirectUri, codeChallenge }) {
      const url = new URL(redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code", mockAuthorizationCode(platform, codeChallenge));
      url.searchParams.set("scope", scopes.requested.join(" "));
      if (codeChallenge) {
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
      }
      return url.toString();
    },

    async exchangeCode({ code, codeVerifier, now }) {
      if (code === MOCK_UNAVAILABLE_CODE) return fail("transient", "Token endpoint unavailable");
      const match = CODE.exec(code);
      if (!match) return fail("auth", "invalid_grant");
      const user = match[1]!;
      const sig = match[2]!;
      // PKCE: the verifier must hash to the challenge the code was issued for.
      const challenge = codeVerifier ? await pkceChallengeS256(codeVerifier) : undefined;
      if (signature(platform, challenge, user) !== sig) return fail("auth", "invalid_grant");
      return grantFor(user, now);
    },

    async refresh(credential, _config, now) {
      if (scopes.lifetimeMs !== undefined) {
        throw new ProviderError({
          kind: "unsupported",
          platform,
          operation: "oauthRefresh",
          message: "User tokens of this platform cannot be refreshed",
        });
      }
      const user = credential.token.startsWith(tokenPrefix)
        ? credential.token.slice(tokenPrefix.length)
        : "1";
      return grantFor(user, now);
    },

    async revoke() {
      // Nothing to revoke at a mock platform.
    },
  };
  return Object.freeze(spec);
}
