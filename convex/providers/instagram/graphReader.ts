import type { SocialAccountType } from "../../domain/types";
import type { ProviderOperation } from "../types";
import { GRAPH_ORIGIN, INSTAGRAM_GRAPH_VERSION } from "./config";
import { classifyInstagramFailure, instagramError, instagramProviderError } from "./errors";
import { canonicalId, mapAccountType, parseRaw, rawIdentity } from "./schemas";
import { READER_IDENTITY_FIELDS, sendInstagram, type RequestBudget } from "./transport";

/**
 * The MINIMAL direct Instagram Graph reader (Phase 10, I-D3 option B). It exists only for
 * documented social-sdk gaps and is NOT a generic Graph client:
 * - read-only GETs on graph.instagram.com/v25.0, on the "graph_reader" allowlist of
 *   transport.ts (any other URL, method, parameter or secret-in-URL is refused before the
 *   network);
 * - the token travels only in the Authorization header;
 * - every call spends from an explicit RequestBudget;
 * - responses are shape-validated and reduced to our own types here; raw Graph payloads
 *   never leave this module; failures are classified ProviderErrors (errors.ts).
 *
 * Stage A implements the identity read only (`account_type`: the SDK requests it but drops
 * it). The allowlist already names the other documented gaps (account insights; media
 * `views` / `total_interactions`, non-deprecated metrics only); their reads and mappings are
 * Stage B.
 */

export type InstagramIdentity = {
  /** Instagram professional account id (`/me.user_id`). */
  userId: string;
  username?: string;
  /** I-D16: business | creator; any other platform value failed closed. */
  accountType: SocialAccountType;
};

export type ReaderCall = {
  operation: ProviderOperation;
  /** D28b stage prefix of providerCode (OAuth callback), e.g. "identity". */
  stage?: string;
  budget: RequestBudget;
};

const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

export function createInstagramGraphReader(options: { timeoutMs: number }) {
  return Object.freeze({
    /** GET /v25.0/me?fields=user_id,username,account_type */
    async readIdentity(accessToken: string, call: ReaderCall): Promise<InstagramIdentity> {
      const url = new URL(`${GRAPH_ORIGIN}/${INSTAGRAM_GRAPH_VERSION}/me`);
      url.searchParams.set("fields", READER_IDENTITY_FIELDS);
      const result = await sendInstagram(
        "graph_reader",
        url,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        },
        { timeoutMs: options.timeoutMs, budget: call.budget },
      );
      if (!result.ok) {
        throw instagramProviderError(
          classifyInstagramFailure(result.failure),
          call.operation,
          call.stage,
        );
      }
      const raw = parseRaw(rawIdentity, result.body, call.operation, "identity", call.stage);
      const userId = canonicalId(raw.user_id);
      if (userId === undefined) {
        throw instagramError(
          "data",
          call.operation,
          call.stage ? `${call.stage}:identity_invalid` : "identity_invalid",
          "Unexpected Instagram account identity",
        );
      }
      const accountType = mapAccountType(raw.account_type);
      if (accountType === undefined) {
        throw instagramError(
          "permission",
          call.operation,
          call.stage ? `${call.stage}:account_type_unsupported` : "account_type_unsupported",
          "Only Instagram business and creator accounts are supported",
        );
      }
      const username =
        raw.username !== undefined && USERNAME.test(raw.username) ? raw.username : undefined;
      return { userId, ...(username !== undefined ? { username } : {}), accountType };
    },
  });
}

export type InstagramGraphReader = ReturnType<typeof createInstagramGraphReader>;
