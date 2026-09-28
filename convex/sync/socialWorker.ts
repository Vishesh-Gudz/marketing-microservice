"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { withConnectionCredential } from "../connections/credentialStore";
import { isSocialConnectionProvider } from "../domain/types";
import { socialProviderFor } from "../providers/social/nodeRegistry";
import type { SocialProvider } from "../providers/social/types";
import type { ProviderContext } from "../providers/types";
import type { ClaimResult, FailureArg, FetchRequest } from "./validators";
import { classify } from "./worker";

/**
 * The organic social sync worker (Phase 10). "use node" because the Instagram provider
 * wraps @opencoredev/social-sdk (Node >= 22.12; convex.json pins Node 22). It is an entry
 * point only: claim, commit and failure policy are the SAME run/task mutations the ads
 * worker uses (convex/sync/runs.ts). ONE page per invocation:
 *   1. claim the task (lease + claimSeq, tenant/linkage checks); only social claims
 *   2. decrypt the credential ONLY via withConnectionCredential and call the tenant-free
 *      social provider with {credential, attempt} and external ids
 *   3. record the failure (retry policy) — Stage A has no social page write path, so a
 *      successful page is itself recorded as a fail-closed failure (social_commit_pending;
 *      unreachable while every social operation fails closed before the network)
 * Plaintext credentials exist only inside step 2. Nothing is logged.
 */

class SubjectMismatchError extends Error {
  constructor() {
    super("Credential binding or operation does not match the social sync run");
    this.name = "SubjectMismatchError";
  }
}

export const SOCIAL_COMMIT_PENDING = "social_commit_pending";

async function callSocialProvider(
  provider: SocialProvider,
  ctx: ProviderContext,
  request: FetchRequest,
): Promise<unknown> {
  const account = { accountExternalId: request.accountExternalId };
  const paging = request.cursor !== undefined ? { cursor: request.cursor } : {};
  switch (request.operation) {
    case "getSocialAccount":
      return await provider.getAccount(ctx, account);
    case "listSocialPosts":
      return await provider.listPosts(ctx, { ...account, ...paging });
    case "fetchPostMetrics":
      if (request.from === undefined) throw new SubjectMismatchError();
      return await provider.fetchPostMetrics(ctx, {
        ...account,
        ...paging,
        publishedFrom: request.from,
      });
    case "fetchAccountMetrics":
      if (request.from === undefined || request.to === undefined) throw new SubjectMismatchError();
      return await provider.fetchAccountMetrics(ctx, {
        ...account,
        ...paging,
        from: request.from,
        to: request.to,
      });
    default:
      // An ads operation never runs here.
      throw new SubjectMismatchError();
  }
}

export const runTask = internalAction({
  args: { taskId: v.id("syncTasks") },
  returns: v.null(),
  handler: async (ctx, { taskId }) => {
    const claim: ClaimResult = await ctx.runMutation(internal.sync.runs.claimTask, { taskId });
    if (claim.status !== "fetch") return null;
    const fail = async (failure: FailureArg) => {
      await ctx.runMutation(internal.sync.runs.recordFailure, {
        taskId,
        claimSeq: claim.claimSeq,
        failure,
      });
    };
    if (claim.subject !== "social") {
      // An ads subject scheduled on the social worker: fail closed, never retried.
      await fail({ source: "internal", kind: "internal" });
      return null;
    }

    try {
      await withConnectionCredential(ctx, claim.connectionId, async (credential, binding) => {
        // Defense in depth: the decrypted credential must belong to the run's org/platform.
        if (
          binding.orgId !== claim.orgId ||
          binding.provider !== claim.platform ||
          !isSocialConnectionProvider(binding.provider)
        ) {
          throw new SubjectMismatchError();
        }
        const provider = socialProviderFor(binding.provider);
        await callSocialProvider(provider, { credential, attempt: claim.attempt }, claim.request);
      });
    } catch (error) {
      await fail(classify(error));
      return null;
    }
    await fail({ source: "provider", kind: "unknown", code: SOCIAL_COMMIT_PENDING });
    return null;
  },
});
