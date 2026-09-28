# Sync engine (Phase 5)

The sync engine moves data from a platform connection into the canonical Phase 2 tables:

```text
connection ─► encrypted credential ─► provider (tenant-free) ─► page ─► guards ─► mapping
  ─► canonical upsert (natural keys) ─► checkpoint ─► next page / next task
```

It runs completely on the deterministic mock providers today. The real Meta and Google providers
(Phases 8 and 9) plug in behind the same `AdsProvider` contract. The engine has no platform branches.

Code: `convex/sync/`. Tables: `convex/tables/sync.ts`. Decision record:
[ADR 0006](adr/0006-sync-engine.md).

## Components

| Module        | Kind                        | Role                                                                                    |
| ------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| `planner.ts`  | cron `internalMutation`     | every 15 min: finds due accounts, starts bounded runs, recovers stalled ones            |
| `runs.ts`     | `internalMutation`s         | the run/task state machine: create, claim, commit page, record failure, finalize        |
| `worker.ts`   | `internalAction`            | one page per invocation: claim → `withConnectionCredential` → provider → commit/failure |
| `upsert.ts`   | plain functions             | **the single canonical write path** (natural-key upserts, prune, removal marking)       |
| `plan.ts`     | pure                        | due kinds, account-local windows, capability-driven task lists, coverage                |
| `policy.ts`   | pure                        | retry/error policy, backoff, sanitized errors                                           |
| `guards.ts`   | pure                        | pagination guards, record scope checks, size caps                                       |
| `resolver.ts` | DB read                     | builds the mapping `EntityRefResolver` from org-scoped natural-key lookups              |
| `state.ts`    | plain functions             | `syncAccounts` lookups and `ensureSyncAccount` (called when an account is linked)       |
| `admin.ts`    | `internalMutation`/`Query`s | operator/dev: `requestSync`, `runStatus`, `accountState`                                |

There are **no public sync functions** in Phase 5. `convex/v1` is unchanged.

## Tables

| Table          | Purpose                                                                    | Indexes                                                                                                                       |
| -------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `syncAccounts` | per ad or social account: state, schedule, coverage, lease (`activeRunId`) | `by_org_account`, `by_org_social_account`; **`by_next_plan` (global, approved)**                                              |
| `syncRuns`     | one sync of one account; `connectionId` pinned at creation                 | `by_org_account_created`, `by_org_account_key`, `by_org_social_account_created`, `by_org_social_account_key`, `by_org_status` |
| `syncTasks`    | one provider operation (many pages) plus its finalize step                 | `by_org_run_seq`                                                                                                              |

`syncAccounts.by_next_plan` is the only exception to the orgId-first rule added in Phase 5. The
planner re-verifies every row it returns: the row's subject must point at an account of the
**same** org, otherwise the row is parked and nothing runs.

### Sync subjects (Phase 10)

- **One subject per row:** every `syncAccounts`, `syncRuns` and `syncTasks` row names **exactly
  one** subject, `adAccountId` (an ad account) or `socialAccountId` (an organic social
  account). `convex/sync/subject.ts` enforces this on every read and write. A row naming
  neither or both fails closed: it is parked by the planner, and claims are refused.
- **Operations are bound to the kind:** ad tasks run only the Phase 5 operations, and social
  tasks only `getSocialAccount`, `listSocialPosts`, `fetchPostMetrics` and
  `fetchAccountMetrics`.
- **Ad subjects** behave exactly as before.
- **Social subjects** share the run, task, lease, claim and failure machinery:
  - they are planned by `sync/socialPlan.ts` (capability-driven, UTC days);
  - they are executed by the `"use node"` social worker `sync/socialWorker.ts`, because the
    Instagram provider wraps `@opencoredev/social-sdk`;
  - the ads worker refuses social claims and the social worker refuses ad claims;
  - `auth` failures also cancel the other social accounts' runs on the same connection.
- **Stage A:**
  - there is no social page write path: a social page can never be committed;
  - every Instagram operation fails closed with `instagram_mapping_pending`, so a social run is
    the failing preflight;
  - coverage stays ad-only.

See [providers/instagram.md](providers/instagram.md).

**Internal-only fields:** cursors, `previousCursor`, `finalizeCursor`, leases, `claimSeq`,
`idempotencyKey`, `fetchStartedAt`, per-page attempt counters and `code` (the platform error code).
**Fields a future DTO may expose (Phase 6/7):** run `kind`/`status`/`window`/`counts`/timestamps,
error `kind` + generic `message`, `coveredFrom`/`coveredThrough`, `lastSuccessAt`, `state`.

## Lifecycle

```text
syncAccounts.state   idle ─► running ─► idle
                     any  ─► blocked   (permission / not_found / account drift; rechecked in 24 h)
                     any  ─► parked    (account unlinked; leaves the planner index)

run    queued ─► running ─► succeeded | partial | failed | cancelled
task   queued ─► running ─► (queued: next page or retry) ─► succeeded | failed | skipped | cancelled
       phase: fetch (worker action, one page per claim) ─► finalize (DB-only mutation)
```

A run ends:

- `succeeded`: every task succeeded, nothing unresolved.
- `partial`: some task failed, a record was unresolved, or a finalize step raised a warning
  (for example `suspicious_empty_listing`). Coverage and schedules still advance.
- `failed`: the `getAccount` preflight failed, or every non-skipped task failed. Failure backoff:
  15 min, doubling, capped at 6 h.
- `cancelled`: `connection_inactive`, `account_unlinked`, `account_relinked`, `timeout` or
  `superseded`.

## Task model

Every run creates **all** its tasks up front (at most 64), and they run **strictly in `seq` order**:

1. `getAccount`: preflight. Verifies access, refreshes provider-owned account fields, and **blocks
   the account on currency/timezone/manager drift** instead of rewriting history.
2. `listCampaigns` → `listAdGroups` → `listCreatives` → `listAds` (when the run lists structure).
   Creatives come before ads: `mapAd` needs the creative to be stored already.
3. `fetchDailyMetrics` for every window chunk × level, then `fetchActionMetrics` for every window
   chunk × level.

Task creation is **capability-driven**. The engine never requests something the provider does not
declare:

- entity listings only for `capabilities.entities.*`
- metric levels = `capabilities.metricLevels` ∩ levels whose entities can be stored (account always)
- daily metrics: `breakdown: "placement"` only if `placementBreakdown`, otherwise `"none"`
- action metrics only if `actionMetrics`, always `breakdown: "none"` (`all` rows)
- windows chunked at month boundaries and at `min(31, maxMetricsRangeDays)` days, newest first
- `updatedSince` only if `incrementalEntities`

## Pagination and checkpoints

- **One page per worker invocation.** The worker claims the task, fetches one page with the
  checkpointed cursor and commits it.
- **Atomic checkpoint:** `commitPage` validates the page, writes the canonical rows, stores the new
  cursor and schedules the next step **in one transaction**. After a crash, the task resumes from
  the last committed cursor; re-fetching that page is harmless because writes are replacements by
  natural key.
- **Claims and leases:** every claim increments `claimSeq` and sets a 5-minute lease. A commit or
  failure report carrying an older `claimSeq` is discarded, and so is a commit whose
  `requestCursor` no longer matches the checkpoint (duplicate or out-of-order delivery). If a lease
  expires (worker died, scheduled step lost), the planner re-queues the task under a new `claimSeq`.
  After 3 stalls the task fails (`stale_lease`).
- **Guards (before any write):** page larger than `min(maxPageSize, 500)`; `nextCursor` equal to the
  request or previous cursor (`cursor_loop`); more than 500 pages; more than 25 empty pages in a row;
  records of another platform, account, currency, level, date or placement (`out_of_scope`);
  duplicate natural keys in one page; invalid records. Empty pages that still carry a cursor are
  allowed.
- **Expired cursors:** a checkpoint older than 30 minutes, or an `invalid_request` on a page with a
  cursor, restarts the task from page 1 **once**.

## Canonical upserts (`convex/sync/upsert.ts`)

The only module allowed to insert into `adAccounts`, `campaigns`, `adGroups`, `ads`, `creatives`,
`metricsDaily` and `actionMetricsDaily` (ESLint-enforced; Phase 4 linking calls
`upsertLinkedAdAccount` from here).

| Table                                  | Natural key (Phase 2)                                              | Write rule                                                     |
| -------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| adAccounts                             | orgId, platform, externalId                                        | link: field update; sync: replace, keep connection + createdAt |
| campaigns / adGroups / ads / creatives | orgId, adAccountId, externalId                                     | replace provider-owned fields, keep `createdAt`                |
| metricsDaily                           | orgId, entityId, placement, date                                   | replace whole row; prune stale rows of the completed scope     |
| actionMetricsDaily                     | orgId, entityId, placement, date, rawActionType, attributionWindow | replace whole row; prune stale rows of the completed scope     |

- **Uniqueness without SQL constraints:** every write reads its natural-key index range and writes
  in the same mutation. Convex mutations are serializable, so a concurrent insert of the same key
  conflicts and one side retries. If duplicates are ever found anyway, the oldest row is kept and
  the rest are deleted (`duplicatesRepaired`).
- **Replacement, not patch:** a field the platform stops reporting disappears; a metric is never
  incremented. Absent stays absent, `0` stays `0`.
- **No dangling references:** a record whose parent is not stored is skipped and counted
  (`unresolved`), the run becomes `partial`, and the next run lists the full structure
  (`structureStale`).
- **Caps:** `attributes` ≤ 50 keys (keys ≤ 64 chars, values ≤ 1,024 chars), `extras` ≤ 50 keys,
  `headlines`/`descriptions` ≤ 20 items. Truncations are counted.

### Pruning (metrics)

After a metric task's fetch **completes successfully**, its finalize phase deletes rows of exactly
that request's scope (account, level, `[from, to]`, placements) with `syncedAt < fetchStartedAt`,
i.e. rows the platform no longer returned (restated away). Scope: `breakdown: "none"` → `all` rows
only; `"placement"` → every placement. **A failed metric task never prunes**, so earlier data
survives a failed re-sync.

### Removed entities

After a **complete, successful, fully resolved, full** (non-incremental) listing of campaigns, ad
groups or ads, rows not seen since the listing started get `removedAt`. Rows are never deleted,
`status` (provider-owned) is untouched, metrics stay. A later listing that returns the entity clears
`removedAt`. Creatives have no `removedAt` and are never marked. **Safeguard:** if the listing would
mark more than 50% **and** more than 20 entities, nothing is marked, the run is `partial` with
`suspicious_empty_listing`, and `sync.removal_skipped` is audited.

## Retry and error policy

Only `rate_limited` and `transient` are retried (the Phase 3 rule).

| Failure                         | Behavior                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `auth`                          | connection → `needs_reauth` (audited, subject `system:sync`); run failed; sibling runs of the connection cancelled              |
| `permission`, `not_found`       | **only this account** is `blocked`, run failed, rechecked after 24 h; audited once                                              |
| `rate_limited`                  | same page retried after `max(retryAfterMs, 30 s × 2^n)` + jitter, ≤ 1 h; account throttled; 10th hit on one page fails the task |
| `transient`                     | same page retried after 30 s × 2^n + jitter, ≤ 15 min; 5th failed attempt fails the task                                        |
| `invalid_request`               | restart from page 1 once if a cursor was involved, otherwise the task fails                                                     |
| `unsupported`                   | task skipped                                                                                                                    |
| `data`, `unknown`, guard errors | task fails (no retry); the run continues with the next task                                                                     |
| credential unavailable          | run cancelled (`connection_inactive`)                                                                                           |
| account drift                   | account `blocked`, `sync.account_attributes_changed` audited                                                                    |
| internal (e.g. missing key)     | task fails, never retried                                                                                                       |
| any failure of `getAccount`     | fatal for the run (nothing else may run without a verified account)                                                             |

**Blocking reasons are sticky:** once an account is blocked (`permission`, `not_found`,
`account_changed`), its `lastError` is kept through inactive-connection rechecks, cancellations and
non-blocking failures (those are still recorded on the run, the connection and the audit log). It is
replaced only by a newer blocking reason, and cleared only by a successful run, which audits
`sync.account_unblocked`. Repeated inactive-connection rechecks keep the first observation.

Rate-limit hits do not consume the transient budget. Since Phase 8 (D34a) the rate-limit budget is
**per page**, like the transient budget: `rateLimitHits` resets at every page commit, so backoff
restarts from the base and a long task throttled on many pages still completes. `ctx.attempt` (passed to the provider) counts
every attempt of the current page. Backoff jitter is deterministic (hash of task id and attempt).
Stored errors contain only the kind, an optional platform code (≤ 64 chars) and a **generic**
message; provider messages and payloads are never stored or logged.

## Scheduling

The planner cron runs every 15 minutes. It reads at most 50 due rows per batch, starts at most 25
runs per invocation, and continues itself (≤ 20 times) while full batches remain. Every row it
touches leaves with `nextPlanAt` in the future (or absent), so it never loops.

| Kind          | When                                 | Structure                                                                         | Metric window (account-local days)                                             |
| ------------- | ------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `initial`     | after the first link                 | full                                                                              | last 30 days                                                                   |
| `lookback`    | every 24 h                           | full (removal marking)                                                            | `today − min(restatementLookbackDays, 30)` … today, plus catch-up              |
| `incremental` | every 60 min                         | incremental (`updatedSince` − 1 h overlap) if supported; full if stale; else none | yesterday … today, plus catch-up after gaps (≤ 62 days; older gaps backfilled) |
| `backfill`    | only when nothing else is due        | none                                                                              | one calendar month older than coverage, down to the horizon (395 days)         |
| `manual`      | `sync/admin:requestSync` (operators) | full                                                                              | requested window, ≤ 93 days, not in the future                                 |

Priority: `initial > lookback > incremental > backfill`. Other states: unlinked accounts are
parked; accounts of inactive connections are rechecked hourly; throttled accounts wait until
`throttledUntil`; blocked accounts are retried after 24 h.

**Coverage:** `coveredFrom`/`coveredThrough` is the contiguous range of account-local days for which
every planned metric task succeeded **without unresolved or rejected records** (Phase 6, D11). A row
absent inside coverage means "no delivery"; outside it means "unknown". A window with a skipped
record does not advance coverage (existing coverage is kept, never shrunk); structure is marked
stale, so a later clean run covers it. Coverage is per account, so such a window is not covered for
any level. Analytics relies on this ([analytics.md](analytics.md)).

**Stalled backfills (Phase 8, D34c):** a `backfill` run that ends `partial` without merging any
completed window made no progress (for example a deterministic metric-task failure or unresolved
rows). It is scheduled like a failed run: `consecutiveFailures + 1` and
`nextPlanAt = max(nextDueAt, now + failureBackoffMs(n))` (15 min, 30 min, 60 min … ≤ 6 h) instead of
re-planning the same window at every planner tick. Other run kinds, and backfills that merged a
window, are unchanged; any such run resets the streak to 0.

> D34 (a) and (c) are the only sync changes of Phase 8: a narrowly scoped Phase 5 compatibility
> correction, latent with the mocks and required for real Meta traffic
> ([ADR 0009](adr/0009-meta-ads-provider.md)). Regression tests: `convex/sync/compat.test.ts`.

## Concurrency and idempotency

| Situation                       | Handling                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| duplicate cron invocations      | planners conflict on the same `syncAccounts` row; the loser sees the moved `nextPlanAt`                        |
| duplicate runs                  | one active run per account (`activeRunId`, transactional); same kind+window in one 15-min slot is not repeated |
| duplicate tasks                 | tasks are created only with their run; the next step is scheduled inside the committing mutation               |
| two workers on one task         | only one claim succeeds; a stale `claimSeq` commit is discarded                                                |
| retry after partial completion  | resume from the committed cursor; pages are replaced by natural key                                            |
| disconnect / unlink during sync | every claim and commit re-checks the pinned connection and the account link; the run is cancelled, no writes   |
| reconnect during sync           | each page re-reads the credential, so later pages use the new one                                              |
| relink to another connection    | run cancelled (`account_relinked`); the next run syncs into the **same** canonical rows                        |
| token expired                   | claim takes the `auth` path without calling the provider                                                       |

## Limits (`convex/sync/config.ts`)

64 tasks/run · 500 pages/task · 25 consecutive empty pages · 500 records/page · 31-day task windows ·
93-day manual windows · 395-day backfill horizon · 5 attempts/page · 10 rate-limit hits/task · 1 h
max backoff · 5 min lease · 3 stall recoveries · 6 h max run · 30 min stale cursor · 500-row finalize
batches · 50 runs kept per account.

## Credentials

The worker uses **only** `withConnectionCredential`. It never reads the `credentials` table and never
decrypts (both lint-enforced). Plaintext exists only inside the provider call of one worker
invocation; it is never returned, stored, logged or passed to a mutation. Scheduled-function
arguments contain only ids. The action additionally checks that the decrypted binding's org and
platform match the run.

**Token expiry/refresh in Phase 5:** an expired `tokenExpiresAt` takes the `auth` path at claim time
(the hourly sweep does the same). Refreshing access tokens (Google refresh tokens) is the Phase 9
provider's job inside the action; persisting refreshed grants and caching access tokens remain
deferred.

## Auditing

Routine runs are not audited (`syncRuns` is the operational log). Audited, subject `system:sync`:
`connection.needs_reauth`, `sync.account_blocked`, `sync.account_unblocked`,
`sync.account_attributes_changed`, `sync.removal_skipped`. Entries carry ids, kinds and counts only.

## Running a sync locally

```bash
npm run dev:backend                     # local Convex backend
npm run dev:auth setup                  # dev issuer, encryption key, dashboard token
# connect + link through v1 (dashboard in Phase 7, or tests/live/connections.live.test.ts)
npx convex run sync/planner:tick        # plan now instead of waiting for the cron
npx convex run sync/admin:requestSync '{"adAccountId":"<id>"}'
npx convex run sync/admin:runStatus '{"runId":"<id>"}'
npx convex run sync/admin:accountState '{"adAccountId":"<id>"}'
```

`requestSync` also creates the sync state of accounts linked before Phase 5.

## Testing

- Pure: `plan.test.ts`, `policy.test.ts`, `guards.test.ts`.
- Write path: `upsert.test.ts`.
- Engine (convex-test, real connect flow and encrypted credentials): `e2e.test.ts` (complete Mock
  Meta and Mock Google syncs, idempotency), `scenarios.test.ts` (every mock failure scenario),
  `protocol.test.ts` (claims, leases, checkpoints, guards, retry exhaustion, no prune after failure),
  `lifecycle.test.ts` (concurrency, disconnect/unlink/relink/reconnect/re-auth), `removal.test.ts`,
  `scheduling.test.ts`, `metrics.test.ts` (restatement, missing vs zero, timezones, > 2^53),
  `isolation.test.ts`.
- Mock scenarios travel on the mock credential: connect the mock user `"<id>--<scenario>[--v<n>]"`
  (for example `"1--rate_limited"`, `"1--default--v1"`). Mock-only; real credentials never carry
  these fields.
- Live (`npm run test:live`): `tests/live/sync.live.test.ts` runs complete syncs on the real local
  Convex runtime.
