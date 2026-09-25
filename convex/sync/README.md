# convex/sync

Sync engine (Phase 5): cron planner, run/task state machine, one-page worker actions, and the
single canonical write path (`upsert.ts`). Convex `ctx.scheduler` + task tables; no Workpool or
external queue. See [docs/sync.md](../../docs/sync.md) and ADR 0006.
