import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { AUDIT_ACTIONS, SYSTEM_SWEEP_SUBJECT, writeAudit } from "../lib/audit";
import { WHATSAPP_REVOKED_CREDENTIAL_GRACE_MS } from "../whatsapp/config";
import { CREDENTIAL_SWEEP_LEASE_MS, CREDENTIAL_SWEEP_PAGE_LIMIT, SWEEP_BATCH } from "./config";
import { deleteCredential } from "./credentialStore";
import {
  afterCursorReset,
  afterPage,
  claimLease,
  INITIAL_SWEEP_STATE,
  leaseIsLive,
  ownsLease,
  type SweepState,
} from "./sweepCursor";

/**
 * Backstop for credentials still attached to revoked connections (IM7.0; part of the hourly
 * connection sweep, maintenance.ts). It is what deletes the credential when a disconnect's own
 * job could not (a job without a credential version, a failed or interrupted job).
 *
 * Every revoked connection is visited: SWEEP_BATCH rows per transaction, in index order, from a
 * cursor persisted in `maintenanceCursors` (sweepCursor.ts is the state machine). Each page is
 * processed and the cursor advanced in ONE transaction, and every row is read in that same
 * transaction, so a credential is deleted only while its connection is `revoked` (a reconnect
 * is either seen or serialized after). A connection revoked behind the cursor is visited by the
 * next pass. One run at a time (a lease); a run pauses after CREDENTIAL_SWEEP_PAGE_LIMIT pages
 * and the next hourly run resumes from the cursor, never from the start.
 */

const NAME = "revokedCredentials";

type CursorRow = Doc<"maintenanceCursors">;
type PageOutcome = { next: "continue" | "paused" | "completed" | "reset"; deleted: number };

function stateOf(row: CursorRow): SweepState {
  return {
    cursor: row.cursor,
    pagesInPass: row.pagesInPass,
    cursorResets: row.cursorResets,
    ...(row.chainId !== undefined ? { chainId: row.chainId } : {}),
    ...(row.leaseUntil !== undefined ? { leaseUntil: row.leaseUntil } : {}),
    ...(row.passStartedAt !== undefined ? { passStartedAt: row.passStartedAt } : {}),
    ...(row.lastPageAt !== undefined ? { lastPageAt: row.lastPageAt } : {}),
    ...(row.lastPassCompletedAt !== undefined
      ? { lastPassCompletedAt: row.lastPassCompletedAt }
      : {}),
  };
}

async function save(ctx: MutationCtx, row: CursorRow, state: SweepState, now: number) {
  // Every field is written, so a field the state cleared (the lease) is removed.
  await ctx.db.patch(row._id, {
    cursor: state.cursor,
    chainId: state.chainId,
    leaseUntil: state.leaseUntil,
    pagesInPass: state.pagesInPass,
    passStartedAt: state.passStartedAt,
    lastPageAt: state.lastPageAt,
    lastPassCompletedAt: state.lastPassCompletedAt,
    cursorResets: state.cursorResets,
    updatedAt: now,
  });
}

async function cursorRow(ctx: MutationCtx): Promise<CursorRow | null> {
  return await ctx.db
    .query("maintenanceCursors")
    .withIndex("by_name", (q) => q.eq("name", NAME))
    .unique();
}

/** The old backstop's rules, for each revoked connection of the page (read in this transaction). */
async function deleteRevokedCredentials(
  ctx: MutationCtx,
  connections: Doc<"connections">[],
  now: number,
): Promise<number> {
  let deleted = 0;
  for (const connection of connections) {
    // A revoked WhatsApp connection keeps its credential for the grace period (ADR 0014 B4:
    // its disconnect cleanup still unsubscribes with the token and deletes it itself).
    if (
      connection.provider === "whatsapp" &&
      (connection.revokedAt ?? 0) > now - WHATSAPP_REVOKED_CREDENTIAL_GRACE_MS
    ) {
      continue;
    }
    if (await deleteCredential(ctx.db, connection.orgId, connection._id)) {
      const org = await ctx.db.get(connection.orgId);
      await writeAudit(
        ctx.db,
        { orgId: connection.orgId, issuer: org?.issuer ?? "", subject: SYSTEM_SWEEP_SUBJECT },
        {
          action: AUDIT_ACTIONS.credentialDeleted,
          targetType: "connection",
          targetId: connection._id,
        },
      );
      deleted++;
    }
  }
  return deleted;
}

async function scheduleStep(
  ctx: MutationCtx,
  chainId: string,
  pagesThisRun: number,
  pageLimit: number,
) {
  await ctx.scheduler.runAfter(0, internal.connections.credentialSweep.sweepRevokedCredentials, {
    chainId,
    pagesThisRun,
    pageLimit,
  });
}

/** One page of the pass by the run that holds the lease, then the next step if any. */
async function runPage(
  ctx: MutationCtx,
  row: CursorRow,
  state: SweepState,
  run: { chainId: string; pagesThisRun: number; pageLimit: number },
  now: number,
): Promise<PageOutcome> {
  let page;
  try {
    page = await ctx.db
      .query("connections")
      .withIndex("by_status_expires", (q) => q.eq("status", "revoked"))
      .paginate({ numItems: SWEEP_BATCH, cursor: state.cursor });
  } catch (error) {
    if (state.cursor === null) throw error;
    // The stored cursor can no longer be read (e.g. the index changed): a new pass starts.
    await save(ctx, row, afterCursorReset(state, now, CREDENTIAL_SWEEP_LEASE_MS), now);
    await scheduleStep(ctx, run.chainId, run.pagesThisRun, run.pageLimit);
    return { next: "reset", deleted: 0 };
  }
  const deleted = await deleteRevokedCredentials(ctx, page.page, now);
  const after = afterPage(
    state,
    page,
    now,
    CREDENTIAL_SWEEP_LEASE_MS,
    run.pagesThisRun,
    run.pageLimit,
  );
  await save(ctx, row, after.state, now);
  if (after.next === "continue") {
    await scheduleStep(ctx, run.chainId, run.pagesThisRun + 1, run.pageLimit);
  }
  return { next: after.next, deleted };
}

/**
 * The hourly start (maintenance.ts `sweep`): takes the lease unless a run holds it, and
 * processes the first page of the run in the caller's transaction.
 */
export async function startCredentialSweep(
  ctx: MutationCtx,
  now: number,
  pageLimit = CREDENTIAL_SWEEP_PAGE_LIMIT,
): Promise<{ run: "started" | "busy"; deleted: number }> {
  let row = await cursorRow(ctx);
  if (row === null) {
    const id = await ctx.db.insert("maintenanceCursors", {
      name: NAME,
      ...INITIAL_SWEEP_STATE,
      updatedAt: now,
    });
    row = (await ctx.db.get(id))!;
  }
  const state = stateOf(row);
  if (leaseIsLive(state, now)) return { run: "busy", deleted: 0 };
  const chainId = `${now.toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
  const outcome = await runPage(
    ctx,
    row,
    claimLease(state, chainId, now, CREDENTIAL_SWEEP_LEASE_MS),
    { chainId, pagesThisRun: 0, pageLimit },
    now,
  );
  return { run: "started", deleted: outcome.deleted };
}

/** A scheduled step of a run. A stale run (another chain, or its lease expired) changes nothing. */
export const sweepRevokedCredentials = internalMutation({
  args: { chainId: v.string(), pagesThisRun: v.number(), pageLimit: v.number() },
  returns: v.object({
    status: v.union(
      v.literal("stale"),
      v.literal("continue"),
      v.literal("paused"),
      v.literal("completed"),
      v.literal("reset"),
    ),
    deleted: v.number(),
  }),
  handler: async (ctx, { chainId, pagesThisRun, pageLimit }) => {
    const now = Date.now();
    const row = await cursorRow(ctx);
    if (row === null || !ownsLease(stateOf(row), chainId, now)) {
      return { status: "stale" as const, deleted: 0 };
    }
    const outcome = await runPage(
      ctx,
      row,
      stateOf(row),
      { chainId, pagesThisRun, pageLimit },
      now,
    );
    return { status: outcome.next, deleted: outcome.deleted };
  },
});
