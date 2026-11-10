import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { getSocialAccount, listSocialAccounts } from "../analytics/organic/queries";
import { paginatedDto } from "../lib/dto";
import { orgQuery } from "../lib/tenancy";
import { socialAccountDto, toSocialAccountDetailDto } from "./dto/socialAccount";

/**
 * Organic social accounts (Phase 10 Stage B): read-only, tenant-scoped. Linked and unlinked
 * accounts (their history belongs to the org), ordered by platform then external id, 1-100
 * per page. No URL, credential or connection internals (O2: only whether organic sync can run,
 * derived from the linked connection).
 */

/** The account's linked connection, only when it belongs to the same org. */
async function connectionOf(
  db: DatabaseReader,
  account: Doc<"socialAccounts">,
): Promise<Doc<"connections"> | null> {
  if (account.connectionId === undefined) return null;
  const connection = await db.get(account.connectionId);
  return connection !== null && connection.orgId === account.orgId ? connection : null;
}

export const list = orgQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginatedDto(socialAccountDto),
  handler: async (ctx, args) => {
    const result = await listSocialAccounts(ctx, args.paginationOpts);
    const page = [];
    for (const { account, sync } of result.page) {
      page.push(toSocialAccountDetailDto(account, sync, await connectionOf(ctx.db, account)));
    }
    return { page, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});

/** One social account; another org's id (or a malformed id) is NOT_FOUND. */
export const get = orgQuery({
  args: { socialAccountId: v.string() },
  returns: socialAccountDto,
  handler: async (ctx, args) => {
    const { account, sync } = await getSocialAccount(ctx, args.socialAccountId);
    return toSocialAccountDetailDto(account, sync, await connectionOf(ctx.db, account));
  },
});
