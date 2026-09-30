import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { getSocialAccount, listSocialAccounts } from "../analytics/organic/queries";
import { paginatedDto } from "../lib/dto";
import { orgQuery } from "../lib/tenancy";
import { socialAccountDto, toSocialAccountDetailDto } from "./dto/socialAccount";

/**
 * Organic social accounts (Phase 10 Stage B): read-only, tenant-scoped. Linked and unlinked
 * accounts (their history belongs to the org), ordered by platform then external id, 1-100
 * per page. No URL, credential or connection internals.
 */
export const list = orgQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginatedDto(socialAccountDto),
  handler: async (ctx, args) => {
    const result = await listSocialAccounts(ctx, args.paginationOpts);
    return {
      page: result.page.map(({ account, sync }) => toSocialAccountDetailDto(account, sync)),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/** One social account; another org's id (or a malformed id) is NOT_FOUND. */
export const get = orgQuery({
  args: { socialAccountId: v.string() },
  returns: socialAccountDto,
  handler: async (ctx, args) => {
    const { account, sync } = await getSocialAccount(ctx, args.socialAccountId);
    return toSocialAccountDetailDto(account, sync);
  },
});
