# Adding an ads provider

Checklist for a new paid-ads platform, or for replacing the mock with a real Meta or Google
implementation. Read [architecture.md](architecture.md) first.

## 1. Canonical fit

- [ ] The platform maps onto accounts > campaigns > ad groups (`ad_set` / `ad_group` /
      `asset_group`) > ads, plus creatives.
- [ ] A new platform value needs a Phase 2 schema change (`AD_PLATFORMS`) and an ADR. Do not model
      it as another platform.
- [ ] Canonical external-id forms are defined in `convex/domain/identity.ts`, including composite
      ids where the platform's ids are only locally unique.

## 2. Module layout

```text
convex/providers/<platform>/
  client.ts      HTTP, auth headers, retries NOT here (sync owns retries), rate-limit header parsing
  schemas.ts     Zod schemas for raw responses (untrusted input)
  normalize.ts   raw -> provider records (reuse domain/identity, lib/money, lib/dates)
  index.ts       createXAdsProvider(): AdsProvider<XCredential>
```

**Rules:**

- No imports of `_generated/server`, `_generated/api`, `lib/tenancy` or Convex runtime APIs (lint
  enforced).
- No `orgId`, no Convex ids and no database access. Credentials arrive through
  `ProviderContext.credential`.
- Wrap platform cursors in the opaque cursor string. Bind them to the request fingerprint.
- Normalize the requested page, then run `assertValidRecord` on every record before returning it.
- Throw `ProviderError` only. Wrap anything else with `toProviderError`.
- Omit metrics the platform did not report. Never write `0` for "unknown".
- Money must be exact: use `parseDecimalToMicros` for decimal strings and `BigInt` for micros
  strings. Use `numberToMicros` only for doubles.
- Metric dates are account-local `YYYY-MM-DD`.

## 2b. What the sync engine (Phase 5) relies on

See [../sync.md](../sync.md).

- [ ] `getAccount` returns the same record as the account's `listAccounts` entry, and `not_found` /
      `permission` for inaccessible accounts. Its currency and timezone must be stable; a change
      blocks the account.
- [ ] Entity listings include entities that metrics may still reference (removed/archived ones);
      otherwise their metric rows stay unresolved. A full listing (no `updatedSince`) must be
      complete: entities it omits are marked removed.
- [ ] A metric request is authoritative for its scope: rows it does not return are pruned. Never
      return a partial result without an error.
- [ ] Cursors never repeat and eventually end. An expired platform cursor is reported as
      `invalid_request` (sync restarts the task once).
- [ ] Only the declared placements, levels and metrics appear; the sync rejects out-of-scope rows.
- [ ] Access-token refresh (e.g. Google refresh tokens) happens inside the provider call; the sync
      engine does not persist refreshed tokens in Phase 5.

## 3. Capabilities

Declare only what the platform really provides:

- entity kinds and `adGroupKinds`
- `incrementalEntities`
- `metricLevels`, `placements` and `reportedMetrics`
- `actionMetrics` and `attributionWindows`
- `maxMetricsRangeDays`
- page sizes
- `restatementLookbackDays`

## 4. Errors

Map every platform failure to a kind. Retryable kinds are `rate_limited` (include `retryAfterMs`
when known) and `transient`. Revoked or expired tokens are `auth`.

## 5. Tests

- [ ] `runAdsProviderContract({ name, create, credential, range })` passes, using recorded fixtures
      (no live API in CI).
- [ ] Normalizer unit tests cover statuses, objectives, placements, budgets, dates/time zones,
      composite ids and money.
- [ ] Error classification tests cover each platform error code the provider handles.
- [ ] Mapping round trip: records map with `convex/mapping` and insert into the schema under
      convex-test.
- [ ] A complete sync of a recorded-fixture account through the Phase 5 engine succeeds and a second
      sync of the same window is a no-op (see `convex/sync/e2e.test.ts`).

## 6. Registration

Add the provider to `createDefaultRegistry()` in `convex/providers/index.ts`, selected by
`PROVIDER_MODE`. No other module changes.
