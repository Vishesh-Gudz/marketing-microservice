import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { providerRegistry } from "../connections/config";
import {
  CredentialUnavailableError,
  withConnectionCredential,
} from "../connections/credentialStore";
import { isAdPlatform } from "../domain/types";
import { isProviderError } from "../providers/errors";
import type { AdsProvider, ProviderContext } from "../providers/types";
import type { ClaimResult, FailureArg, FetchRequest, ProviderPageArg } from "./validators";

/**
 * The sync worker: ONE page per invocation.
 *   1. claim the task (mutation: lease + claimSeq, tenant/linkage checks)
 *   2. decrypt the credential ONLY via withConnectionCredential and call the
 *      tenant-free provider with {credential, attempt} and external ids
 *   3. commit the page (mutation: guards + canonical writes + checkpoint +
 *      next step, atomically) or record the failure (mutation: retry policy)
 * Plaintext credentials exist only inside step 2. Nothing is logged.
 */

class TenantMismatchError extends Error {
  constructor() {
    super("Credential binding does not match the sync run");
    this.name = "TenantMismatchError";
  }
}

/** Generic dispatch: the engine never branches on platform. */
async function callProvider(
  provider: AdsProvider,
  ctx: ProviderContext,
  request: FetchRequest,
): Promise<ProviderPageArg> {
  const account = { accountExternalId: request.accountExternalId };
  const paging = request.cursor !== undefined ? { cursor: request.cursor } : {};
  const entity = {
    ...account,
    ...paging,
    ...(request.updatedSince !== undefined ? { updatedSince: request.updatedSince } : {}),
  };
  const metrics = () => ({
    ...account,
    ...paging,
    level: request.level!,
    from: request.from!,
    to: request.to!,
    breakdown: request.breakdown ?? "none",
  });
  const page = <K extends ProviderPageArg["kind"], T>(
    kind: K,
    result: { items: T[]; nextCursor?: string },
  ) => ({
    kind,
    items: result.items,
    ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
  });

  switch (request.operation) {
    case "getAccount":
      return { kind: "adAccount", items: [await provider.getAccount(ctx, account)] };
    case "listCampaigns":
      return page("campaign", await provider.listCampaigns(ctx, entity));
    case "listAdGroups":
      return page("adGroup", await provider.listAdGroups(ctx, entity));
    case "listCreatives":
      return page("creative", await provider.listCreatives(ctx, entity));
    case "listAds":
      return page("ad", await provider.listAds(ctx, entity));
    case "fetchDailyMetrics":
      return page("metricRow", await provider.fetchDailyMetrics(ctx, metrics()));
    case "fetchActionMetrics":
      return page("actionRow", await provider.fetchActionMetrics(ctx, metrics()));
    default:
      // Phase 10: social operations run only in the "use node" social worker.
      throw new TenantMismatchError();
  }
}

/** Classifies a thrown error without keeping its message (messages may carry payloads). */
export function classify(error: unknown): FailureArg {
  if (isProviderError(error)) {
    return {
      source: "provider",
      kind: error.kind,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      ...(error.providerCode !== undefined ? { code: error.providerCode.slice(0, 64) } : {}),
    };
  }
  if (error instanceof CredentialUnavailableError) {
    return { source: "credential", kind: "credential_unavailable" };
  }
  return { source: "internal", kind: "internal" };
}

export const runTask = internalAction({
  args: { taskId: v.id("syncTasks") },
  returns: v.null(),
  handler: async (ctx, { taskId }) => {
    const claim: ClaimResult = await ctx.runMutation(internal.sync.runs.claimTask, { taskId });
    if (claim.status !== "fetch") return null;
    if (claim.subject !== undefined) {
      // Phase 10: a social subject scheduled on the ads worker. Fail closed; never retried.
      await ctx.runMutation(internal.sync.runs.recordFailure, {
        taskId,
        claimSeq: claim.claimSeq,
        failure: { source: "internal", kind: "internal" },
      });
      return null;
    }

    let page: ProviderPageArg;
    try {
      page = await withConnectionCredential(
        ctx,
        claim.connectionId,
        async (credential, binding) => {
          // Defense in depth: the decrypted credential must belong to the run's org/platform.
          if (
            binding.orgId !== claim.orgId ||
            binding.provider !== claim.platform ||
            !isAdPlatform(binding.provider)
          ) {
            throw new TenantMismatchError();
          }
          const provider = providerRegistry().ads(binding.provider);
          return await callProvider(
            provider,
            { credential, attempt: claim.attempt },
            claim.request,
          );
        },
      );
    } catch (error) {
      await ctx.runMutation(internal.sync.runs.recordFailure, {
        taskId,
        claimSeq: claim.claimSeq,
        failure: classify(error),
      });
      return null;
    }

    try {
      await ctx.runMutation(internal.sync.runs.commitPage, {
        taskId,
        claimSeq: claim.claimSeq,
        ...(claim.request.cursor !== undefined ? { requestCursor: claim.request.cursor } : {}),
        page,
      });
    } catch {
      // The commit rolled back (e.g. an invariant violation): record it; never retried.
      await ctx.runMutation(internal.sync.runs.recordFailure, {
        taskId,
        claimSeq: claim.claimSeq,
        failure: { source: "internal", kind: "internal" },
      });
    }
    return null;
  },
});
