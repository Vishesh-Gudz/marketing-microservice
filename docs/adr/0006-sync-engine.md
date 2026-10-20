# ADR 0006 — Sync engine

- Status: accepted
- Date: 2026-09-25

## Context

Connections (ADR 0005) give an org encrypted platform credentials; providers (ADR 0004) return one
tenant-free page per call; the canonical model (ADR 0003) defines natural keys and "replace, never
increment" metrics. Phase 5 connects them: a generic, bounded, restartable sync that runs on the
mock providers now and on the real Meta/Google providers in Phases 8/9. Convex remains the only
backend: no Redis, Kafka, BullMQ or external queue.

## Decisions

1. **Three internal tables** (`syncAccounts`, `syncRuns`, `syncTasks`), orgId-first indexes, no
   public functions (operators use `sync/admin:*` internal functions).
2. **One approved global index,** `syncAccounts.by_next_plan`, so the cron planner finds due work in
   O(due) instead of walking every org. Every row it returns is re-verified for tenant ownership.
3. **`ctx.scheduler` + task tables** instead of the Workpool or rate-limiter components. Tasks are
   durable rows; leases (`claimSeq`) make at-most-once actions safe; the next step is scheduled in
   the same transaction that commits a page.
4. **One page per worker action.** Claim (mutation) → provider call inside
   `withConnectionCredential` (action) → commit (mutation). Mapping and canonical writes happen in
   the commit mutation, so the checkpoint, the rows and the next step are atomic.
5. **`getAccount` added to the provider contract** (generic single-account lookup) as the run
   preflight. Currency/timezone/manager drift blocks the account instead of rewriting history.
6. **Strict task order:** `getAccount → campaigns → adGroups → creatives → ads → daily metrics →
action metrics`. Creatives precede ads because mapping requires them.
7. **Capability-driven tasks:** unsupported listings, levels, breakdowns or action metrics are never
   requested. Daily metrics use the placement breakdown where supported; action metrics use `all`
   rows only.
8. **Single canonical write path** (`convex/sync/upsert.ts`, ESLint-enforced) with the Phase 2
   natural keys. Provider-owned fields are replaced, service-owned fields (`createdAt`,
   `connectionId`, `linkedAt`) preserved. Phase 4 linking now goes through it
   (`upsertLinkedAdAccount`).
9. **Window pruning of BOTH metric tables** after a successful fetch, by `syncedAt <
fetchStartedAt` within the request scope. Never after a failed task.
10. **Removal marking** only after complete, successful, fully resolved full listings, with a
    mass-removal veto (> 50% and > 20 entities).
11. **Retry policy:** only `rate_limited` (≤ 10 hits/task, `retryAfter`-aware, ≤ 1 h) and `transient`
    (≤ 5 attempts/page, ≤ 15 min) retry. `auth` → `needs_reauth`; `permission`/`not_found` block
    one account; everything else fails or skips the task.
12. **Cadence:** planner every 15 min; initial 30 days; incremental hourly; lookback daily
    (`min(restatementLookbackDays, 30)`); monthly backfill chunks to 13 months when idle.
13. **Mock scenarios travel on `MockCredential`** (`scenario`, `variant`), selected by the mock OAuth
    user grammar `"<id>--<scenario>[--v<n>]"`. Mock-only test seam.

## Alternatives rejected

- **Workpool / rate-limiter components:** extra dependencies and component setup in tests; the task
  table already provides durability, ordering, leases and backoff.
- **Walking all organizations each tick:** O(orgs + accounts) every 15 minutes, and needs its own
  cursor state.
- **Patching entities:** cannot remove fields the platform stopped reporting.
- **A run-id column on metric rows as the prune generation:** changes the Phase 2 schema; the
  existing `syncedAt` plus the account lease (no concurrent runs per account) is sufficient.
- **Mapping in the action:** would need Convex ids in the action and a second read transaction; the
  resolver would not be consistent with the writes.
- **Environment-variable scenario switch:** production code would read a test switch.

## Consequences

- Phase 6 analytics can rely on replaced/pruned metric rows and on `coveredFrom`/`coveredThrough`.
- Phase 7 may expose run status and coverage via new `v1` DTOs (fields listed in docs/sync.md).
- Phases 8/9 must implement `getAccount`, list removed entities where metrics still reference them,
  wrap cursors opaquely, and (Google) refresh access tokens inside the action.
- Per-connection/per-developer-token rate coordination and persisted token refresh are future work.
  (2026-10: Google developer tokens were sunset; Google quota now belongs to the Google Cloud
  project, see ADR 0010 "Amendment".)
