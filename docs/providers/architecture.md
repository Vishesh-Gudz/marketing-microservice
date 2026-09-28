# Provider architecture (paid ads)

How advertising platforms plug into the service. The code lives in `convex/providers/` (adapters)
and `convex/mapping/` (provider → canonical rows). Both are **pure TypeScript**: no database access,
no Convex function builders, no tenant identity at runtime. An ESLint rule enforces this, and
`tests/lint/provider-imports.test.ts` proves the rule fires.

## Layers

```text
 platform API / mock fixtures
        │  raw, platform-shaped payloads (never leave the provider module)
        ▼
 AdsProvider (convex/providers/<platform>/)          one per platform, registered by platform
   normalize: raw ─► provider records                canonical vocabulary, external-id references
   assertValidRecord (validate.ts)                   checked against the real Phase 2 table validators
   pagination · capabilities · ProviderError
        │  ProviderAdAccount / ProviderCampaign / ProviderAdGroup / ProviderAd /
        │  ProviderCreative / ProviderMetricRow / ProviderActionRow
        ▼
 mapping (convex/mapping/)                           shared by every provider
   OrgScope / AccountScope (branded) + EntityRefResolver
   platform / account / currency consistency checks
        │  canonical insert rows (WithoutSystemFields<Doc<T>>)
        ▼
 Phase 5 write path (convex/sync/upsert.ts): upsert by natural key, uniqueness, caps  (docs/sync.md)
```

## Tenant boundary

- Providers never receive or return tenant data.
  - `ProviderContext` is `{ credential, attempt }`.
  - Requests carry only external ids.
  - Provider records contain no `orgId`, no Convex ids and no lifecycle timestamps.
  - Record validation rejects unknown fields, so these cannot be smuggled in.
- Tenant identity enters **only** in the mapping layer, via branded scopes that cannot be written as
  object literals:
  - `orgScopeFromTenant(ctx.tenant)` is used for account discovery (`mapAdAccount`).
  - `accountScopeFromDoc(storedAdAccount)` is used for everything inside an account. Its `orgId` is
    read from the persisted, org-owned row.
- Mapping always takes the platform, currency, `orgId` and `adAccountId` from the scope. A record for
  another platform, account or currency throws a `MappingError`.

## Contract (`convex/providers/types.ts`)

```ts
interface AdsProvider<TCredential> {
  platform; providerId; capabilities;
  listAccounts(ctx, PageRequest)          → ProviderPage<ProviderAdAccount>
  getAccount(ctx, AccountLookupRequest)   → ProviderAdAccount            (Phase 5)
  listCampaigns(ctx, EntityRequest)       → ProviderPage<ProviderCampaign>
  listAdGroups(ctx, EntityRequest)        → ProviderPage<ProviderAdGroup>
  listAds(ctx, EntityRequest)             → ProviderPage<ProviderAd>
  listCreatives(ctx, EntityRequest)       → ProviderPage<ProviderCreative>
  fetchDailyMetrics(ctx, MetricsRequest)  → ProviderPage<ProviderMetricRow>
  fetchActionMetrics(ctx, MetricsRequest) → ProviderPage<ProviderActionRow>
}
```

- **One page per call.** The caller (Phase 5 sync) owns iteration and persists cursors.
- **`getAccount` (Phase 5)** returns one account by canonical external id; the sync preflight uses
  it to verify access and detect currency/timezone drift.
- **Record types** are derived type-only from the Phase 2 `Doc` types, so they cannot drift from the
  schema.
- **References use external ids:** `accountExternalId`, `campaignExternalId`, `entityExternalId`, …

## Errors (`convex/providers/errors.ts`)

| Kind              | Meaning                                         | Retryable |
| ----------------- | ----------------------------------------------- | --------- |
| `auth`            | token invalid/expired/revoked, reconnect needed | no        |
| `permission`      | missing scope or no access to the account       | no        |
| `not_found`       | account/entity gone                             | no        |
| `rate_limited`    | throttled, may carry `retryAfterMs`             | **yes**   |
| `transient`       | 5xx / network / timeout                         | **yes**   |
| `invalid_request` | bad arguments, foreign cursor, range too long   | no        |
| `unsupported`     | capability not supported                        | no        |
| `data`            | payload failed normalization or validation      | no        |
| `unknown`         | unclassified (`toProviderError`)                | no        |

- Retryability is **derived from the kind**. `requiresReauth` is true for `auth`.
- Retry behavior may depend only on `ctx.attempt`, never on hidden state.
- Mapping failures are `MappingError` with one of these reasons: `platform_mismatch`,
  `account_mismatch`, `currency_mismatch`, `unresolved_entity`, `invalid_record`.
- Batch metric mapping returns `{ rows, unresolved }`. It never drops records silently.

## Pagination (`convex/providers/pagination.ts`)

- Cursors are **opaque strings, bound to the request** that produced them. A cursor from another
  request is rejected as `invalid_request`.
- The same request plus the same cursor always returns the same page, so retries are safe.
- A missing `nextCursor` means the result is complete. Empty pages that still carry a cursor are
  allowed.
- `pageSize` is clamped to `1..capabilities.maxPageSize`.
- Ordering is stable:
  - entities by external id
  - metric rows by date, then entity, then placement order
- `collectAll` exists for tests and tooling only.

## Capabilities (`convex/providers/capabilities.ts`)

Each provider declares static data:

- supported entity kinds and ad group kinds
- whether `updatedSince` is honored
- metric levels
- placement breakdown and the placements that can appear
- `reportedMetrics` (every other metric column is always absent)
- action metrics and attribution windows
- `maxMetricsRangeDays`
- page sizes
- `restatementLookbackDays`

Unsupported operations throw `unsupported`. The contract suite checks that emitted data never
exceeds the declaration. The mock tests also check that the declaration isn't larger than what the
provider actually emits.

## Registry (`convex/providers/registry.ts`)

`createProviderRegistry({ ads: [...] })` builds a frozen map keyed by each provider's own
`platform`. There is no platform switch, and duplicate registrations throw. `createDefaultRegistry()`
in `convex/providers/index.ts` is the single composition point:

- **Phase 3:** the mock for both platforms.
- **Phase 8:** `createDefaultRegistry(env)` resolves `PROVIDER_MODE` fail-closed
  (`convex/providers/mode.ts`): mock (unchanged), live (real Meta + Meta OAuth; Google is the
  unavailable stub from `convex/providers/unavailable.ts`), or misconfigured (unavailable stubs for
  both platforms, no OAuth). See [meta.md](meta.md).
- **Phase 9:** in live mode the real Google Ads provider and OAuth spec replace the stub when
  Google is configured (see [google-ads.md](google-ads.md)).
- **Phases 10 and 11:** sibling families (`social`, `messaging`) extend the registry the same way.

## Mock provider (`convex/providers/mock/`)

`createMockAdsProvider({ platform, scenario?, variant? })` impersonates `meta` or `google_ads`.
There is no `"mock"` platform in the schema. It walks the same path as a real provider: raw
payloads, then paging, then page-local normalization, then validation.

| Flavor      | Raw shape                                                                                                                                | Fixtures                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meta-like   | `act_` ids, numbers as strings, decimal-string spend, minor-unit budgets, `+hhmm` times, `publisher_platform`, `actions`/`action_values` | USD account (CBO / ABO / archived campaigns, deleted ad without creative, reused creative, carousel, video); IDR account (sums past 2^53 micros); empty account |
| Google-like | dashed customer ids, `costMicros`/`amountMicros` int64 strings, double conversion values, `2037-12-30` no-end sentinel, composite ad ids | USD account (Search, Performance Max asset group without ads, removed campaign); JPY account; manager (MCC) account; closed account                             |

**Metrics** are a pure function of seed, variant, entity, date and placement:

- A seeded PRNG is used. There is no `Math.random` and no clock.
- Leaves generate per-placement cells. Every higher level and the `"all"` row are exact sums of those
  cells.
- Missing-data cases the mock exercises:
  - zero-delivery days are omitted
  - Meta reports reach only on `"all"` rows
  - Meta conversions are absent when none were reported
  - Google never reports reach or link clicks, but always reports conversions (including 0.0)
- `variant` restates values on the same keys, for the Phase 5 replace tests.

**Scenarios:** `default`, `empty`, `rate_limited` (later pages, attempt 1), `transient` (first page,
attempt 1), `auth_revoked`, `permission_denied`, `malformed`, `slow_pages`. A credential token of
`"revoked"` always fails with `auth`.

**Per-connection scenarios (mock-only test seam, Phase 5):** a `MockCredential` may carry
`scenario` and `variant`, which override the construction options per call. The mock OAuth user
grammar `"<id>--<scenario>[--v<n>]"` (e.g. `"1--rate_limited"`, `"1--default--v1"`) issues such
credentials for identity `mock-user-<id>`, so a whole sync can run a scenario through the real
connect flow and encrypted credential store. Real credentials never carry these fields.

## Organic social (Phase 10)

- **Contract:** `SocialProvider`, a sibling of `AdsProvider` (`convex/providers/social/types.ts`).
  Its operations are `getAccount`, `listPosts`, `fetchPostMetrics` and `fetchAccountMetrics`,
  plus the default-runtime `SocialAccountDiscovery`.
- **Records** are derived from the social tables and validated against the real table
  validators (`social/validate.ts`).
- **Registry:** a `social` family holds static capabilities, the provider id and the SDK-free
  discovery. The SDK-backed provider is resolved only in Node, by `social/nodeRegistry.ts`,
  under the same PROVIDER_MODE (D8) matrix.
- **Instagram:** [instagram.md](instagram.md).

## How Meta and Google Ads plug in (Phases 8–9)

1. Create `convex/providers/meta/` (or `google/`) with `client.ts` (HTTP, auth headers, rate-limit
   parsing, platform cursors wrapped in opaque strings), `schemas.ts` (Convex `v` validators with
   `convex-helpers` `validate` for untrusted responses; no Zod), `normalize.ts` (raw → provider records, reusing `domain/identity`, `lib/money` and
   `lib/dates`) and `index.ts` (implements `AdsProvider`).
2. Declare honest capabilities, for example Meta `restatementLookbackDays: 28` and Google `30`.
3. Map platform failures to `ProviderError` kinds (HTTP 401/190 → `auth`, 17/613 or
   `RESOURCE_EXHAUSTED` → `rate_limited`, 5xx → `transient`, …).
4. Run `runAdsProviderContract` from `convex/providers/contract.suite.ts` against recorded fixtures.
5. Register the provider in `createDefaultRegistry()` behind `PROVIDER_MODE`.

No change is needed in mapping, the schema, sync or the dashboard. See
[adding-a-provider.md](adding-a-provider.md). Meta (Phase 8) is in [meta.md](meta.md).
