import type { ProviderDiscoveredSocialAccount, SocialAccountDiscovery } from "../social/types";
import { assertValidSocialRecord } from "../social/validate";
import type { PageRequest, ProviderContext, ProviderPage } from "../types";
import { YouTubeRequestBudget } from "./client";
import { OAUTH_TIMEOUT_MS, YOUTUBE_PROVIDER_ID, type YouTubeAppConfig } from "./config";
import { youtubeError } from "./errors";
import { handleOf } from "./mapping";
import { CHANNEL_ACCOUNT_TYPE } from "./semantics";
import { createYouTubeSession, ownedChannelOf } from "./session";

/**
 * YouTube channel discovery (ADR 0016, Y-D2), in the DEFAULT runtime (no Node hop, no SDK).
 * A YouTube consent belongs to exactly one channel (the credential's), so discovery is one
 * page: a fresh access token + `channels.list?mine=true` (budget 2), returning that channel's
 * minimum identity (id, handle, account type). It also proves the authorization still owns the
 * channel; if not, `permission` / account_mismatch. Profile details (title, subscribers) are
 * filled by the first sync preflight.
 */
export function createYouTubeDiscovery(
  app: YouTubeAppConfig & { timeoutMs?: number },
): SocialAccountDiscovery {
  const youtube = createYouTubeSession(app, { timeoutMs: app.timeoutMs ?? OAUTH_TIMEOUT_MS });
  const operation = "listSocialAccounts" as const;

  return Object.freeze({
    platform: "youtube" as const,
    providerId: YOUTUBE_PROVIDER_ID,

    async listAccounts(
      ctx: ProviderContext,
      request: PageRequest,
    ): Promise<ProviderPage<ProviderDiscoveredSocialAccount>> {
      if (request.cursor !== undefined) {
        // Discovery is a single page: any cursor is foreign.
        throw youtubeError("invalid_request", operation, "cursor_invalid", "Unexpected cursor");
      }
      const session = youtube.open(operation, ctx.credential);
      const budget = new YouTubeRequestBudget(2);
      const token = await youtube.accessToken(session, operation, budget);
      const channel = ownedChannelOf(
        await youtube.ownedChannels(token, operation, budget),
        session.credential.channelId,
        operation,
      );
      const username = handleOf(channel.snippet?.customUrl);
      const record: ProviderDiscoveredSocialAccount = {
        platform: "youtube",
        externalId: channel.id,
        ...(username !== undefined ? { username } : {}),
        accountType: CHANNEL_ACCOUNT_TYPE,
      };
      assertValidSocialRecord("discoveredSocialAccount", record, "youtube", operation);
      return { items: [record] };
    },
  });
}
