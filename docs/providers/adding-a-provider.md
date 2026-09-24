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

## 6. Registration

Add the provider to `createDefaultRegistry()` in `convex/providers/index.ts`, selected by
`PROVIDER_MODE`. No other module changes.
