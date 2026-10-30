/**
 * The resumable sweep's state machine (IM7.0), with no Convex dependency so it can be driven
 * over millions of simulated rows (sweepCursor.test.ts). credentialSweep.ts applies it in ONE
 * transaction per page: the page is processed and the next state is written together, so the
 * cursor advances only past a page that was processed, and a failed step changes nothing.
 *
 * - One chain at a time: a run owns the lease (`chainId`, `leaseUntil`); a step whose chainId
 *   is not the stored one, or whose lease expired, changes nothing (stale).
 * - The cursor is reset ONLY at the end of the index (a completed pass), or when the stored
 *   cursor can no longer be read.
 * - A run stops after `pageLimit` pages and releases the lease; the next run resumes from the
 *   stored cursor. A completed pass releases the lease too. An interrupted run's lease expires.
 */

export type SweepState = {
  cursor: string | null;
  chainId?: string;
  leaseUntil?: number;
  pagesInPass: number;
  passStartedAt?: number;
  lastPageAt?: number;
  lastPassCompletedAt?: number;
  cursorResets: number;
};

export const INITIAL_SWEEP_STATE: SweepState = { cursor: null, pagesInPass: 0, cursorResets: 0 };

export function leaseIsLive(state: SweepState, now: number): boolean {
  return state.chainId !== undefined && (state.leaseUntil ?? 0) > now;
}

export function ownsLease(state: SweepState, chainId: string, now: number): boolean {
  return state.chainId === chainId && (state.leaseUntil ?? 0) > now;
}

/** A new run takes the lease (callers check `leaseIsLive` first). */
export function claimLease(
  state: SweepState,
  chainId: string,
  now: number,
  leaseMs: number,
): SweepState {
  return { ...state, chainId, leaseUntil: now + leaseMs };
}

export type PageResult = { isDone: boolean; continueCursor: string };
export type AfterPage = { state: SweepState; next: "continue" | "paused" | "completed" };

/**
 * The state after one page was processed; `pagesThisRun` counts the pages before it in this
 * run. Completed or paused: the lease is released.
 */
export function afterPage(
  state: SweepState,
  page: PageResult,
  now: number,
  leaseMs: number,
  pagesThisRun: number,
  pageLimit: number,
): AfterPage {
  const passStartedAt = state.cursor === null ? now : state.passStartedAt;
  const released = { chainId: undefined, leaseUntil: undefined };
  if (page.isDone) {
    return {
      state: {
        ...state,
        ...released,
        cursor: null,
        pagesInPass: 0,
        passStartedAt: undefined,
        lastPageAt: now,
        lastPassCompletedAt: now,
      },
      next: "completed",
    };
  }
  const advanced = {
    ...state,
    cursor: page.continueCursor,
    pagesInPass: state.pagesInPass + 1,
    passStartedAt,
    lastPageAt: now,
  };
  if (pagesThisRun + 1 >= pageLimit) {
    return { state: { ...advanced, ...released }, next: "paused" };
  }
  return { state: { ...advanced, leaseUntil: now + leaseMs }, next: "continue" };
}

/** The stored cursor could not be read: a new pass starts (the run keeps its lease). */
export function afterCursorReset(state: SweepState, now: number, leaseMs: number): SweepState {
  return {
    ...state,
    cursor: null,
    pagesInPass: 0,
    passStartedAt: undefined,
    leaseUntil: now + leaseMs,
    cursorResets: state.cursorResets + 1,
  };
}
