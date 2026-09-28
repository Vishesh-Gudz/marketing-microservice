"use node";

import type { ProviderOperation } from "../../types";
import type { SocialProvider } from "../../social/types";
import type { ProviderContext } from "../../types";
import { INSTAGRAM_CAPABILITIES } from "../capabilities";
import {
  INSTAGRAM_CONFIG_INVALID,
  INSTAGRAM_PROVIDER_ID,
  isInstagramId,
  isValidInstagramAppId,
} from "../config";
import { isInstagramCredential } from "../credential";
import { instagramError } from "../errors";
import { instagramMappingPending } from "../mapping";

/**
 * The Instagram SocialProvider (Phase 10), resolved only in Node (social/nodeRegistry.ts)
 * because its reads go through @opencoredev/social-sdk (./sdk.ts) and the Graph reader.
 *
 * Every operation first checks — before any network access — the configuration (the
 * credential's app must be INSTAGRAM_APP_ID), the credential shape, and that the requested
 * account is the one the token belongs to. Stage A: the semantic mapping is pending, so
 * every operation then fails CLOSED with "unknown" / instagram_mapping_pending (never
 * "unsupported", which would skip the task).
 */
export function createInstagramSocialProvider(options: { appId?: string }): SocialProvider {
  const verify = (
    operation: ProviderOperation,
    ctx: ProviderContext,
    accountExternalId: string,
  ) => {
    if (!isValidInstagramAppId(options.appId)) {
      throw instagramError(
        "unknown",
        operation,
        INSTAGRAM_CONFIG_INVALID,
        "Instagram app configuration is missing or invalid",
      );
    }
    if (!isInstagramCredential(ctx.credential)) {
      throw instagramError(
        "auth",
        operation,
        "credential_invalid",
        "Unusable Instagram credential",
      );
    }
    if (ctx.credential.appId !== options.appId) {
      throw instagramError(
        "auth",
        operation,
        "app_id_mismatch",
        "Instagram token was issued to a different app",
      );
    }
    if (!isInstagramId(accountExternalId)) {
      throw instagramError("invalid_request", operation, "account_invalid", "Invalid account id");
    }
    if (accountExternalId !== ctx.credential.userId) {
      throw instagramError(
        "permission",
        operation,
        "account_mismatch",
        "The token does not belong to this Instagram account",
      );
    }
  };

  const pending =
    (operation: ProviderOperation) =>
    async (ctx: ProviderContext, request: { accountExternalId: string }): Promise<never> => {
      verify(operation, ctx, request.accountExternalId);
      throw instagramMappingPending(operation);
    };

  return Object.freeze({
    platform: "instagram" as const,
    providerId: INSTAGRAM_PROVIDER_ID,
    capabilities: INSTAGRAM_CAPABILITIES,
    getAccount: pending("getSocialAccount"),
    listPosts: pending("listSocialPosts"),
    fetchPostMetrics: pending("fetchPostMetrics"),
    fetchAccountMetrics: pending("fetchAccountMetrics"),
  });
}
