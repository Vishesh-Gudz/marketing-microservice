import type { ProviderOperation } from "../types";
import { createYouTubeClient, type YouTubeRequestBudget, type YouTubeResult } from "./client";
import { isValidYouTubeApp, YOUTUBE_CONFIG_INVALID, type YouTubeAppConfig } from "./config";
import { isYouTubeCredential, type YouTubeCredential } from "./credential";
import { classifyYouTubeFailure, youtubeError, youtubeProviderError } from "./errors";
import {
  parseRaw,
  rawChannel,
  rawListResponse,
  rawTokenResponse,
  type RawChannel,
} from "./schemas";

/**
 * The checks and reads every credential-holding YouTube call shares (ADR 0016): the sync
 * provider (provider.ts) and the default-runtime discovery (discovery.ts).
 *
 * - `open` runs BEFORE any network access: the OAuth app must be valid and not shared with
 *   Google Ads (`unknown` / youtube_config_invalid, never reauth); the credential must be a
 *   YouTube credential of THIS OAuth client (`auth`).
 * - `accessToken` mints a fresh access token from the stored refresh token (Y-D5). It exists
 *   only in the caller's memory; `invalid_grant` (revoked or expired) is `auth`.
 * - `ownedChannels` reads `channels.list?mine=true`: the channels the authorization owns.
 */

export type YouTubeSession = {
  credential: YouTubeCredential;
  clientId: string;
  clientSecret: string;
};

export function bodyOf(
  result: YouTubeResult,
  operation: ProviderOperation,
  stage?: string,
): unknown {
  if (!result.ok) {
    throw youtubeProviderError(classifyYouTubeFailure(result.failure), operation, stage);
  }
  return result.body;
}

export function configError(operation: ProviderOperation, stage?: string) {
  return youtubeError(
    "unknown",
    operation,
    stage !== undefined ? `${stage}:${YOUTUBE_CONFIG_INVALID}` : YOUTUBE_CONFIG_INVALID,
    "YouTube OAuth configuration is missing or invalid",
  );
}

export function createYouTubeSession(app: YouTubeAppConfig, options: { timeoutMs: number }) {
  const client = createYouTubeClient(options);

  return {
    client,

    open(operation: ProviderOperation, credential: unknown): YouTubeSession {
      if (!isValidYouTubeApp(app)) throw configError(operation);
      if (!isYouTubeCredential(credential)) {
        throw youtubeError("auth", operation, "credential_invalid", "Unusable YouTube credential");
      }
      if (credential.clientId !== app.clientId) {
        throw youtubeError(
          "auth",
          operation,
          "client_id_mismatch",
          "Credential belongs to a different OAuth client",
        );
      }
      return { credential, clientId: app.clientId, clientSecret: app.clientSecret };
    },

    async accessToken(
      session: YouTubeSession,
      operation: ProviderOperation,
      budget: YouTubeRequestBudget,
    ): Promise<string> {
      const result = await client.refreshAccessToken(
        {
          refreshToken: session.credential.refreshToken,
          clientId: session.clientId,
          clientSecret: session.clientSecret,
        },
        budget,
      );
      return parseRaw(rawTokenResponse, bodyOf(result, operation), operation, "token").access_token;
    },

    /** `stage`: the D28b stage when called inside an OAuth flow ("identity"). */
    async ownedChannels(
      token: string,
      operation: ProviderOperation,
      budget: YouTubeRequestBudget,
      stage?: string,
    ): Promise<RawChannel[]> {
      const body = bodyOf(await client.listMyChannels(token, budget), operation, stage);
      const list = parseRaw(rawListResponse, body, operation, "channel list", stage);
      return (list.items ?? []).map((item) =>
        parseRaw(rawChannel, item, operation, "channel", stage),
      );
    },
  };
}

/** The requested channel among the owned ones, else `permission` / account_mismatch. */
export function ownedChannelOf(
  channels: readonly RawChannel[],
  channelId: string,
  operation: ProviderOperation,
): RawChannel {
  const channel = channels.find((item) => item.id === channelId);
  if (channel === undefined) {
    throw youtubeError(
      "permission",
      operation,
      "account_mismatch",
      "The authorization does not own this channel",
    );
  }
  return channel;
}
