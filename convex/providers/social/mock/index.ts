import {
  addDays,
  compareDateKeys,
  diffDays,
  eachDay,
  isDateKey,
  todayIn,
  type DateKey,
} from "../../../lib/dates";
import { ProviderError } from "../../errors";
import { fingerprint, fnv1a } from "../../hash";
import { INSTAGRAM_CAPABILITIES } from "../../instagram/capabilities";
import {
  classifyMedia,
  mapAccountDay,
  mapMedia,
  mapPostSnapshot,
  parseInstagramTimestamp,
} from "../../instagram/mapping";
import { ACCOUNT_DAYS_PER_CALL } from "../../instagram/semantics";
import type { OAuthGrant, OAuthSpec } from "../../oauth";
import type { PageRequest, ProviderContext, ProviderOperation, ProviderPage } from "../../types";
import type {
  ProviderDiscoveredSocialAccount,
  ProviderSocialAccount,
  ProviderSocialAccountDay,
  ProviderSocialPost,
  ProviderSocialPostSnapshot,
  SocialAccountDiscovery,
  SocialProvider,
} from "../types";
import { assertValidSocialRecord } from "../validate";
import {
  mockAccountInsights,
  mockFollowBreakdown,
  mockFollowers,
  mockMedia,
  mockPostInsights,
} from "./data";

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
 * Stage B (F15): the sync operations serve deterministic mock data (./data.ts) through the
 * REAL Instagram mapping (../../instagram/mapping.ts), with the Instagram capabilities and
 * page sizes: users "small" (under 100 followers) and "edge" (a media item without a
 * product type) exercise the edge cases; AD and STORY media are listed and excluded.
 */

export const MOCK_SOCIAL_PROVIDER_ID = "mock-social";

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

const CAPS = INSTAGRAM_CAPABILITIES;

/** Checks the credential and account ownership exactly like the Instagram provider. */
function mockUser(ctx: ProviderContext, operation: ProviderOperation, accountExternalId: string) {
  const credential = ctx.credential;
  if (!isMockSocialCredential(credential) || !USER.test(credential.user)) {
    return fail("auth", operation, "credential_invalid", "Unusable mock credential");
  }
  if (credential.token === "revoked") return fail("auth", operation, "190", "Token revoked");
  if (accountExternalId !== mockInstagramAccountId(credential.user)) {
    return fail("permission", operation, "account_mismatch", "Not this mock account");
  }
  if (credential.user === "personal") {
    return fail("permission", operation, "account_type_unsupported", "Unsupported account type");
  }
  return credential.user;
}

/** Opaque mock cursor bound to (operation, account, request): "mocks1.<position>.<check>". */
function encodeCursor(operation: ProviderOperation, binding: string, position: string): string {
  return `mocks1.${position}.${fingerprint([operation, binding, position])}`;
}

function decodeCursor(
  operation: ProviderOperation,
  binding: string,
  cursor: string | undefined,
): string | undefined {
  if (cursor === undefined) return undefined;
  const match = /^mocks1\.([0-9A-Za-z-]{1,16})\.([0-9a-z]+)$/.exec(cursor);
  if (!match || match[2] !== fingerprint([operation, binding, match[1]!])) {
    return fail("invalid_request", operation, "cursor_invalid", "Cursor is malformed");
  }
  return match[1]!;
}

function paged<T>(items: T[], start: number, size: number) {
  const page = items.slice(start, start + size);
  return { page, next: start + size < items.length ? String(start + size) : undefined };
}

/**
 * The mock SocialProvider: deterministic data for `now` (UTC), the Instagram mapping and
 * capabilities, the same exclusions (AD / STORY never snapshotted) and unresolved counts.
 */
export function createMockSocialProvider(): SocialProvider {
  return Object.freeze({
    platform: "instagram" as const,
    providerId: MOCK_SOCIAL_PROVIDER_ID,
    capabilities: CAPS,

    async getAccount(ctx, request): Promise<ProviderSocialAccount> {
      const operation = "getSocialAccount" as const;
      const user = mockUser(ctx, operation, request.accountExternalId);
      const username = `mock_${user.replace(/-/g, "_")}`.slice(0, 30);
      const record: ProviderSocialAccount = {
        platform: "instagram",
        externalId: request.accountExternalId,
        username,
        name: `Mock ${user}`,
        accountType: user === "creator" ? "creator" : "business",
        followersCount: mockFollowers(user),
        status: "active",
      };
      assertValidSocialRecord("socialAccount", record, "instagram", operation);
      return record;
    },

    async listPosts(ctx, request) {
      const operation = "listSocialPosts" as const;
      const user = mockUser(ctx, operation, request.accountExternalId);
      const media = mockMedia(user, todayIn("UTC", Date.now()));
      const start = Number(decodeCursor(operation, request.accountExternalId, request.cursor) ?? 0);
      const { page, next } = paged(media, start, CAPS.defaultPageSize);
      const items: ProviderSocialPost[] = [];
      let unresolved = 0;
      for (const item of page) {
        const mapped = mapMedia(item, request.accountExternalId);
        if (mapped.kind === "unresolved") unresolved++;
        if (mapped.kind !== "post") continue;
        assertValidSocialRecord("socialPost", mapped.record, "instagram", operation);
        items.push(mapped.record);
      }
      return {
        items,
        ...(next !== undefined
          ? { nextCursor: encodeCursor(operation, request.accountExternalId, next) }
          : {}),
        ...(unresolved > 0 ? { unresolved } : {}),
      };
    },

    async fetchPostMetrics(ctx, request) {
      const operation = "fetchPostMetrics" as const;
      const user = mockUser(ctx, operation, request.accountExternalId);
      if (!isDateKey(request.publishedFrom)) {
        return fail("invalid_request", operation, "window_invalid", "Invalid window");
      }
      const now = Date.now();
      const today = todayIn("UTC", now);
      const windowStart = Date.parse(`${request.publishedFrom}T00:00:00Z`);
      const binding = `${request.accountExternalId}|${request.publishedFrom}`;
      const start = Number(decodeCursor(operation, binding, request.cursor) ?? 0);
      const { page, next } = paged(mockMedia(user, today), start, CAPS.postMetricsPageSize);
      const items: ProviderSocialPostSnapshot[] = [];
      let unresolved = 0;
      let ended = false;
      for (const media of page) {
        const publishedAt = parseInstagramTimestamp(media.timestamp);
        if (publishedAt !== undefined && publishedAt < windowStart) {
          ended = true;
          break;
        }
        const classified = classifyMedia(media);
        if (classified.kind === "excluded") continue;
        if (classified.kind === "unresolved" || publishedAt === undefined) {
          unresolved++;
          continue;
        }
        const insights = mockPostInsights(media, today);
        const snapshot = mapPostSnapshot({
          operation,
          accountExternalId: request.accountExternalId,
          postExternalId: media.id,
          capturedAt: now,
          sdk: insights.sdk,
          reader: insights.reader,
        });
        assertValidSocialRecord("socialPostSnapshot", snapshot, "instagram", operation);
        items.push(snapshot);
      }
      return {
        items,
        ...(!ended && next !== undefined
          ? { nextCursor: encodeCursor(operation, binding, next) }
          : {}),
        ...(unresolved > 0 ? { unresolved } : {}),
      };
    },

    async fetchAccountMetrics(ctx, request): Promise<ProviderPage<ProviderSocialAccountDay>> {
      const operation = "fetchAccountMetrics" as const;
      const user = mockUser(ctx, operation, request.accountExternalId);
      const { from, to } = request;
      if (
        !isDateKey(from) ||
        !isDateKey(to) ||
        compareDateKeys(from, to) > 0 ||
        diffDays(from, to) + 1 > CAPS.maxAccountMetricsRangeDays
      ) {
        return fail("invalid_request", operation, "window_invalid", "Invalid window");
      }
      const binding = `${request.accountExternalId}|${from}|${to}`;
      const position = decodeCursor(operation, binding, request.cursor);
      const start: DateKey = position === undefined ? from : addDays(from, Number(position));
      if (compareDateKeys(start, to) > 0) {
        return fail("invalid_request", operation, "cursor_invalid", "Cursor is malformed");
      }
      const today = todayIn("UTC", Date.now());
      const days = eachDay(start, to).slice(0, ACCOUNT_DAYS_PER_CALL);
      const items = days.map((date) => {
        // A day after today has nothing reported yet.
        const future = compareDateKeys(date, today) > 0;
        const follows = future ? undefined : mockFollowBreakdown(user, date);
        const record = mapAccountDay({
          operation,
          accountExternalId: request.accountExternalId,
          date,
          insights: future ? {} : mockAccountInsights(user, date),
          ...(follows !== undefined ? { follows } : {}),
        });
        assertValidSocialRecord("socialAccountDay", record, "instagram", operation);
        return record;
      });
      const nextOffset = diffDays(from, days[days.length - 1]!) + 1;
      return compareDateKeys(addDays(from, nextOffset), to) <= 0
        ? { items, nextCursor: encodeCursor(operation, binding, String(nextOffset)) }
        : { items };
    },
  } satisfies SocialProvider);
}
