import type { PageRequest, ProviderContext, ProviderPage } from "../types";
import type { ProviderDiscoveredSocialAccount, SocialAccountDiscovery } from "../social/types";
import { assertValidSocialRecord } from "../social/validate";
import { INSTAGRAM_PROVIDER_ID, OAUTH_TIMEOUT_MS } from "./config";
import { isInstagramCredential } from "./credential";
import { instagramError } from "./errors";
import { createInstagramGraphReader } from "./graphReader";
import { RequestBudget } from "./transport";

/**
 * Instagram account discovery (Phase 10, Stage 0 decision): from the OAuth IDENTITY, in the
 * DEFAULT runtime (no Node hop, no SDK). An Instagram Login token belongs to exactly one
 * professional account, so discovery is one Graph reader `/me` call returning the minimum
 * identity: id, username and account type. Profile details (name, picture, followers) are
 * filled by the first sync preflight (Stage B). One request per discovery (budget 1).
 */
export function createInstagramDiscovery(
  options: { timeoutMs?: number } = {},
): SocialAccountDiscovery {
  const reader = createInstagramGraphReader({ timeoutMs: options.timeoutMs ?? OAUTH_TIMEOUT_MS });
  const operation = "listSocialAccounts" as const;

  return Object.freeze({
    platform: "instagram" as const,
    providerId: INSTAGRAM_PROVIDER_ID,

    async listAccounts(
      ctx: ProviderContext,
      request: PageRequest,
    ): Promise<ProviderPage<ProviderDiscoveredSocialAccount>> {
      if (request.cursor !== undefined) {
        // Discovery is a single page: any cursor is foreign.
        throw instagramError("invalid_request", operation, "cursor_invalid", "Unexpected cursor");
      }
      if (!isInstagramCredential(ctx.credential)) {
        throw instagramError(
          "auth",
          operation,
          "credential_invalid",
          "Unusable Instagram credential",
        );
      }
      const credential = ctx.credential;
      const identity = await reader.readIdentity(credential.accessToken, {
        operation,
        budget: new RequestBudget(1),
      });
      if (identity.userId !== credential.userId) {
        // The token now answers for a different account than the one it was issued for.
        throw instagramError(
          "data",
          operation,
          "identity_mismatch",
          "Unexpected Instagram account",
        );
      }
      const record: ProviderDiscoveredSocialAccount = {
        platform: "instagram",
        externalId: identity.userId,
        ...(identity.username !== undefined ? { username: identity.username } : {}),
        accountType: identity.accountType,
      };
      assertValidSocialRecord("discoveredSocialAccount", record, "instagram", operation);
      return { items: [record] };
    },
  });
}
