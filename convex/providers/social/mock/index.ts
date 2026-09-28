import { ProviderError } from "../../errors";
import { fingerprint, fnv1a } from "../../hash";
import type { OAuthGrant, OAuthSpec } from "../../oauth";
import type { PageRequest, ProviderContext, ProviderOperation, ProviderPage } from "../../types";
import { INSTAGRAM_CAPABILITIES } from "../../instagram/capabilities";
import type {
  ProviderDiscoveredSocialAccount,
  SocialAccountDiscovery,
  SocialProvider,
} from "../types";
import { assertValidSocialRecord } from "../validate";

/**
 * Mock organic social provider (Phase 10), registered ONLY in PROVIDER_MODE=mock (local
 * development and tests), never in live or misconfigured modes. Deterministic; no network.
 * Separate from the ads mock (convex/providers/mock), which stays untouched.
 *
 * Mock Instagram OAuth ("instant consent", like the ads mock): the authorization URL IS the
 * callback URL carrying `mock-ig-code.<user>.<fingerprint>`. No PKCE (mirrors Instagram).
 * Users: "<n>" -> a business account; "creator" -> a creator account; "personal" -> an
 * unsupported account type (discovery fails closed); "revoked" -> a credential the mock
 * rejects ("auth"); "limited" -> only instagram_business_basic granted (missing scope).
 *
 * Stage A: the sync operations fail closed with "social_mapping_pending" (as the real
 * Instagram provider does with "instagram_mapping_pending"); Stage B adds mock data.
 */

export const MOCK_SOCIAL_PROVIDER_ID = "mock-social";
export const SOCIAL_MAPPING_PENDING = "social_mapping_pending";

export type MockSocialCredential = { kind: "mock_social"; token: string; user: string };

export function isMockSocialCredential(value: unknown): value is MockSocialCredential {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return c.kind === "mock_social" && typeof c.token === "string" && typeof c.user === "string";
}

const SCOPES = ["instagram_business_basic", "instagram_business_manage_insights"] as const;
const LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;
const USER = /^[A-Za-z0-9_-]{1,32}$/;
const CODE = /^mock-ig-code\.([A-Za-z0-9_-]{1,32})\.([0-9a-z]+)$/;
export const MOCK_IG_INVALID_CODE = "mock-ig-code-invalid";
export const MOCK_IG_UNAVAILABLE_CODE = "mock-ig-code-5xx";

/** Deterministic 16-digit Instagram-style account id of a mock user. */
export function mockInstagramAccountId(user: string): string {
  return `178414${String(fnv1a(`mock-ig:${user}`)).padStart(10, "0")}`;
}

/** Test helper: the code the mock issues for `user`. */
export function mockInstagramCode(user = "1"): string {
  return `mock-ig-code.${user}.${fingerprint(["instagram", user])}`;
}

function fail(
  kind: ProviderError["kind"],
  operation: ProviderOperation,
  providerCode: string,
  message: string,
): never {
  throw new ProviderError({ kind, platform: "instagram", operation, message, providerCode });
}

export function createMockInstagramOAuthSpec(): OAuthSpec<MockSocialCredential> {
  const grantFor = (user: string, now: number): OAuthGrant<MockSocialCredential> => ({
    credential: {
      kind: "mock_social",
      token: user === "revoked" ? "revoked" : `mock-ig-token-${user}`,
      user,
    },
    identity: { externalUserId: mockInstagramAccountId(user), displayName: `mock_${user}` },
    grantedScopes: user === "limited" ? ["instagram_business_basic"] : [...SCOPES],
    expiresAt: now + LIFETIME_MS,
    refreshable: true,
  });

  return Object.freeze({
    platform: "instagram" as const,
    providerId: MOCK_SOCIAL_PROVIDER_ID,
    requestedScopes: SCOPES,
    requiredScopes: SCOPES,
    usesPkce: false,

    buildAuthorizationUrl({ state, redirectUri }) {
      const url = new URL(redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code", mockInstagramCode("1"));
      return url.toString();
    },

    async exchangeCode({ code, now }) {
      if (code === MOCK_IG_UNAVAILABLE_CODE) {
        return fail(
          "transient",
          "oauthExchange",
          "token_exchange:http_503",
          "Token endpoint unavailable",
        );
      }
      const match = CODE.exec(code);
      if (!match || match[2] !== fingerprint(["instagram", match[1]!])) {
        return fail("auth", "oauthExchange", "token_exchange:400", "Invalid authorization code");
      }
      return grantFor(match[1]!, now);
    },

    async refresh(credential, _config, now) {
      if (!isMockSocialCredential(credential) || credential.token === "revoked") {
        return fail("auth", "oauthRefresh", "token_refresh:190", "Token cannot be refreshed");
      }
      return { ...grantFor(credential.user, now), grantedScopes: [] };
    },
  } satisfies OAuthSpec<MockSocialCredential>);
}

export function createMockSocialDiscovery(): SocialAccountDiscovery {
  const operation = "listSocialAccounts" as const;
  return Object.freeze({
    platform: "instagram" as const,
    providerId: MOCK_SOCIAL_PROVIDER_ID,
    async listAccounts(
      ctx: ProviderContext,
      request: PageRequest,
    ): Promise<ProviderPage<ProviderDiscoveredSocialAccount>> {
      if (request.cursor !== undefined)
        fail("invalid_request", operation, "cursor_invalid", "Unexpected cursor");
      const credential = ctx.credential;
      if (!isMockSocialCredential(credential) || !USER.test(credential.user)) {
        return fail("auth", operation, "credential_invalid", "Unusable mock credential");
      }
      if (credential.token === "revoked") return fail("auth", operation, "190", "Token revoked");
      if (credential.user === "personal") {
        return fail(
          "permission",
          operation,
          "account_type_unsupported",
          "Unsupported account type",
        );
      }
      const record: ProviderDiscoveredSocialAccount = {
        platform: "instagram",
        externalId: mockInstagramAccountId(credential.user),
        username: `mock_${credential.user.replace(/-/g, "_")}`.slice(0, 30),
        accountType: credential.user === "creator" ? "creator" : "business",
      };
      assertValidSocialRecord("discoveredSocialAccount", record, "instagram", operation);
      return { items: [record] };
    },
  });
}

/** Stage A: every sync operation fails closed before doing anything. */
export function createMockSocialProvider(): SocialProvider {
  const pending = (operation: ProviderOperation) => async (): Promise<never> =>
    fail(
      "unknown",
      operation,
      SOCIAL_MAPPING_PENDING,
      "Social data mapping is not implemented yet",
    );
  return Object.freeze({
    platform: "instagram" as const,
    providerId: MOCK_SOCIAL_PROVIDER_ID,
    capabilities: INSTAGRAM_CAPABILITIES,
    getAccount: pending("getSocialAccount"),
    listPosts: pending("listSocialPosts"),
    fetchPostMetrics: pending("fetchPostMetrics"),
    fetchAccountMetrics: pending("fetchAccountMetrics"),
  });
}
