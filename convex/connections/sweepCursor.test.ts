import { describe, expect, it } from "vitest";
import {
  afterCursorReset,
  afterPage,
  claimLease,
  INITIAL_SWEEP_STATE,
  leaseIsLive,
  ownsLease,
  type SweepState,
} from "./sweepCursor";

// IM7.0: the resumable sweep's state machine, driven exactly as credentialSweep.ts drives it,
// over a simulated ordered index (Convex-like cursors: "after the last key read"). One step is
// one transaction: it either commits its page and the next state together, or nothing.

const BATCH = 200;
const LEASE = 10 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** An ordered index of revoked rows; keys are positions in index order. */
class FakeIndex {
  keys: number[];
  constructor(keys: number[] = []) {
    this.keys = [...keys].sort((a, b) => a - b);
  }
  private after(cursor: string | null): number {
    if (cursor === null) return 0;
    const key = Number(cursor);
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid]! <= key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  page(cursor: string | null) {
    const start = this.after(cursor);
    const page = this.keys.slice(start, start + BATCH);
    return {
      page,
      isDone: start + BATCH >= this.keys.length,
      continueCursor: page.length > 0 ? String(page[page.length - 1]) : (cursor ?? ""),
    };
  }
  insert(key: number) {
    if (this.keys.includes(key)) return;
    this.keys.splice(this.after(String(key - 1e-9)), 0, key);
  }
  remove(key: number) {
    const i = this.keys.indexOf(key);
    if (i >= 0) this.keys.splice(i, 1);
  }
}

type Job = { chainId: string; pagesThisRun: number };

/** The sweep as credentialSweep.ts runs it: hourly start (first page inline) + scheduled steps. */
class SimulatedSweep {
  state: SweepState = INITIAL_SWEEP_STATE;
  visits = new Map<number, number>();
  queue: Job[] = [];
  now = 0;
  chains = 0;
  constructor(
    readonly index: FakeIndex,
    readonly pageLimit: number,
  ) {}

  /** One page in one transaction; `fail` aborts it (nothing commits). */
  private page(state: SweepState, job: Job, fail: boolean): string {
    const page = this.index.page(state.cursor);
    if (fail) return "failed";
    const after = afterPage(state, page, this.now, LEASE, job.pagesThisRun, this.pageLimit);
    for (const key of page.page) this.visits.set(key, (this.visits.get(key) ?? 0) + 1);
    this.state = after.state;
    if (after.next === "continue") {
      this.queue.push({ chainId: job.chainId, pagesThisRun: job.pagesThisRun + 1 });
    }
    return after.next;
  }

  hourly(): string {
    if (leaseIsLive(this.state, this.now)) return "busy";
    const chainId = `c${++this.chains}`;
    return this.page(
      claimLease(this.state, chainId, this.now, LEASE),
      { chainId, pagesThisRun: 0 },
      false,
    );
  }

  step(job: Job, fail = false): string {
    if (!ownsLease(this.state, job.chainId, this.now)) return "stale";
    return this.page(this.state, job, fail);
  }

  /** Runs scheduled steps (each 1 ms apart) until none is left or `stopAfter` steps. */
  drain(stopAfter = Infinity): void {
    let steps = 0;
    while (this.queue.length > 0 && steps++ < stopAfter) {
      this.now += 1;
      this.step(this.queue.shift()!);
    }
  }

  hour(): void {
    this.queue.length = 0; // an hour later, nothing of the last run is still scheduled
    this.now += HOUR;
  }
}

const range = (n: number, step = 1) => Array.from({ length: n }, (_, i) => (i + 1) * step);

describe("resumable credential sweep (simulated index)", () => {
  it("covers 1,200,000 rows over runs of 5,000 pages, resuming and never restarting", () => {
    const sweep = new SimulatedSweep(new FakeIndex(range(1_200_000)), 5000);

    expect(sweep.hourly()).toBe("continue");
    sweep.drain();
    // Paused at the run limit: the cursor is kept and the lease released.
    expect(sweep.state.cursor).toBe("1000000");
    expect(sweep.state.pagesInPass).toBe(5000);
    expect(leaseIsLive(sweep.state, sweep.now)).toBe(false);
    expect(sweep.visits.size).toBe(1_000_000);

    sweep.hour();
    expect(sweep.hourly()).toBe("continue");
    sweep.drain();
    expect(sweep.state).toMatchObject({ cursor: null, pagesInPass: 0, chainId: undefined });
    expect(sweep.state.lastPassCompletedAt).toBe(sweep.now);
    expect(sweep.visits.size).toBe(1_200_000);
    expect([...sweep.visits.values()].every((n) => n === 1)).toBe(true);
  });

  it("a failed step commits nothing; the next run processes the same page once", () => {
    const sweep = new SimulatedSweep(new FakeIndex(range(2000)), 5000);
    sweep.hourly(); // page 1
    sweep.drain(3); // pages 2-4
    const before = { ...sweep.state };
    expect(sweep.step(sweep.queue.shift()!, true)).toBe("failed"); // page 5 aborted
    expect(sweep.state).toEqual(before);
    expect(sweep.visits.size).toBe(800);

    // The run is lost; once its lease expired the next run resumes at page 5.
    sweep.now += LEASE + 1;
    expect(sweep.hourly()).toBe("continue");
    expect(sweep.visits.get(801)).toBe(1);
    sweep.drain();
    expect(sweep.visits.size).toBe(2000);
    expect([...sweep.visits.values()].every((n) => n === 1)).toBe(true);
    expect(sweep.state.cursor).toBeNull();
  });

  it("steps of a stale chain change nothing", () => {
    const sweep = new SimulatedSweep(new FakeIndex(range(1000)), 5000);
    sweep.hourly();
    const oldJob = sweep.queue.shift()!;
    expect(sweep.hourly()).toBe("busy"); // the lease is live
    sweep.now += LEASE + 1; // the old run died
    expect(sweep.step(oldJob)).toBe("stale"); // expired lease
    sweep.hourly(); // a new chain resumes at page 2
    const state = { ...sweep.state };
    expect(sweep.step({ ...oldJob })).toBe("stale"); // another chain's id
    expect(sweep.state).toEqual(state);
    sweep.drain();
    expect(sweep.visits.size).toBe(1000);
    expect([...sweep.visits.values()].every((n) => n === 1)).toBe(true);
  });

  it("releases the lease when a pass completes and when a run pauses", () => {
    const sweep = new SimulatedSweep(new FakeIndex(range(450)), 1);
    expect(sweep.hourly()).toBe("paused");
    expect(sweep.state.chainId).toBeUndefined();
    expect(sweep.hourly()).toBe("paused"); // a new run starts at once and resumes
    expect(sweep.hourly()).toBe("completed");
    expect(sweep.state).toMatchObject({ chainId: undefined, leaseUntil: undefined, cursor: null });
    expect(sweep.visits.size).toBe(450);

    const empty = new SimulatedSweep(new FakeIndex(), 5000);
    expect(empty.hourly()).toBe("completed");
    expect(leaseIsLive(empty.state, empty.now)).toBe(false);
  });

  it("never skips a row revoked during a pass, and never visits one while it is active", () => {
    const index = new FakeIndex(range(10_000, 10));
    const sweep = new SimulatedSweep(index, 10); // 2,000 rows per run
    const active = new Set<number>();
    const reconnect = (key: number) => {
      index.remove(key);
      active.add(key);
    };
    const revoke = (key: number) => {
      index.insert(key);
      active.delete(key);
    };
    const seenWhileActive = () => [...sweep.visits.keys()].filter((k) => active.has(k));

    sweep.hourly();
    sweep.drain(); // run 1: keys 10..20000
    reconnect(50_000); // ahead of the cursor: must not be visited while active
    revoke(15); // newly revoked behind the cursor
    revoke(30_005); // newly revoked ahead of the cursor
    reconnect(100); // already visited; reconnected...
    revoke(100); // ...and revoked again, behind the cursor
    revoke(25); // a "moved" row: re-revoked with a new key behind the cursor

    let passes = 0;
    const visitsBefore = new Map(sweep.visits);
    while (passes < 2) {
      sweep.hour();
      sweep.hourly();
      sweep.drain();
      if (sweep.state.cursor === null) passes++;
    }
    expect(seenWhileActive()).toEqual([]);
    for (const key of [15, 30_005, 25]) expect(sweep.visits.get(key)).toBeGreaterThan(0);
    expect(sweep.visits.get(100)! > visitsBefore.get(100)!).toBe(true);
    // Every revoked row was visited within two passes of the change.
    for (const key of index.keys) expect(sweep.visits.get(key)).toBeGreaterThan(0);
  });

  it("starts a new pass when the stored cursor can no longer be read", () => {
    const state = afterCursorReset(
      { ...INITIAL_SWEEP_STATE, cursor: "garbage", pagesInPass: 7, chainId: "c1", leaseUntil: 5 },
      100,
      LEASE,
    );
    expect(state).toMatchObject({
      cursor: null,
      pagesInPass: 0,
      cursorResets: 1,
      chainId: "c1",
      leaseUntil: 100 + LEASE,
    });
  });
});
