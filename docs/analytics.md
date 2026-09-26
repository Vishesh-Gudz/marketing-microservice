# Analytics (Phase 6)

Read-only analytics over the canonical Phase 2 tables filled by the Phase 5 sync engine. Code:
`convex/analytics/` (domain) and `convex/v1/analytics.ts` + `convex/v1/dto/analytics.ts` (public
contract). Decision record: [ADR 0007](adr/0007-analytics.md).

Analytics never calls Meta, Google, the mock providers or the credential store (ESLint-enforced).
It reads `metricsDaily`, `actionMetricsDaily`, the entity tables, `syncAccounts` coverage and the
`fxRates` reference table.

## Architecture: query-time aggregation

Every public query aggregates the stored rows at request time. There are no rollup tables.

- The canonical model already stores every level **as the platform reports it** (account,
  campaign, ad group, ad). Campaign totals are campaign rows, never sums of ads (that would be wrong
  for reach and platform de-duplication). Analytics only sums **across days and across entities of
  one level**.
- Phase 5 replaces and prunes rows transactionally, so query-time results are always consistent;
  there is nothing to invalidate. Currency conversion also happens at read time.
- **Read budgets (application-level Phase 6 safety limits, not Convex platform limits):** every read
  of one query draws from a shared budget using `.take(remaining + 1)`:
  - 8,000 metric reads: `metricsDaily` rows plus the ad-account and entity documents the query
    loads;
  - 8,000 `actionMetricsDaily` rows.

  A query that would exceed a budget fails deterministically with `INVALID_ARGUMENT`
  `{ reason: "too_many_rows", maxRows, budget: "metric_rows" | "action_rows" }`. Results are
  **never silently truncated**. The purpose is bounded, predictable analytics queries; narrow the
  range or the scope. The budgets are deliberately below what Convex allows per query.

- Rollups (e.g. `metricsMonthly`, maintained by delta in `sync/upsert.ts`) are deferred until the
  Phase 13 load test or real budget pressure.

| Module          | Role                                                                           |
| --------------- | ------------------------------------------------------------------------------ |
| `config.ts`     | limits                                                                         |
| `numeric.ts`    | bigint rounding (half away from zero), fixed-point conversions                 |
| `aggregate.ts`  | pure metric aggregation: exact sums, missing/partial tracking, paired-sum KPIs |
| `actions.ts`    | pure action-metric grouping and per-action KPIs                                |
| `comparison.ts` | pure period-over-period deltas                                                 |
| `periods.ts`    | pure presets, ranges, buckets (shared with the dashboard/SDK)                  |
| `fx.ts`         | exchange rates and conversion                                                  |
| `coverage.ts`   | coverage → data states; static provider capabilities                           |
| `scope.ts`      | tenant-scoped accounts/entities (`getOwned`)                                   |
| `reader.ts`     | budgeted, orgId-first index reads                                              |
| `queries.ts`    | the five operations                                                            |

## Public functions (`convex/v1/analytics`)

All are `orgQuery` (viewer and above). The org always comes from the verified JWT.

| Function                   | Args                                                                                       | Reads                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `v1/analytics:overview`    | `range, compare?, filters?{platforms?, accountIds?}` or `entity?{level, id}` (Phase 7)     | account-level rows, or one entity's rows                    |
| `v1/analytics:timeSeries`  | `range, granularity: day\|week\|month, filters?` or `entity?{level, id}`                   | account-level rows, or one entity's rows                    |
| `v1/analytics:performance` | `level: campaign\|ad_group\|ad, range, parent?, filters?, sort?, compare?, paginationOpts` | one level's rows within a parent (or the org for campaigns) |
| `v1/analytics:breakdown`   | `by: platform\|account\|placement, range, level? (placement only), filters?`               | account-level rows, or per-placement rows                   |
| `v1/analytics:actions`     | `range, level?, entity?, filters?{…, actionTypes?, attributionWindows?, primaryOnly?}`     | action rows (new `by_org_account_level_date` index) + spend |

Scopes and validation:

- `overview` with `entity` (Phase 7, D5; `level`: `campaign`, `ad_group` or `ad`) aggregates that
  entity's own rows (its level, placement `all`) with the same rules, comparison, coverage (its
  ad account) and FX, and adds `entity` (the `EntitySummaryDto` used by performance rows: name,
  status, platform, parents, currency, campaign budget/objective) to the response.
  `accountCount` is 1. `entity` cannot be combined with `filters` (`INVALID_ARGUMENT`,
  `field: "filters"`); an id the caller's org does not own, an unknown or malformed id, or an id of
  another level is `NOT_FOUND`. Without `entity` the response is unchanged and has no `entity` key.

- `filters.accountIds`: 1–50 ids, each loaded with `getOwned` (another tenant's id is `NOT_FOUND`).
  Filters cannot be combined with `parent` or `entity`.
- `performance` parents: campaigns → none or `accountId`; ad groups → `campaignId` (required); ads →
  `campaignId` or `adGroupId` (required). **Every entity of the scoped set is listed** (campaigns of
  the scoped accounts, ad groups or ads of the parent), including removed ones (`removed: true`).
  An entity without rows carries `dataState` `no_delivery` (covered), `unknown` (not covered) or
  `partial`, with metrics and KPIs omitted. Sort: `spend` (reporting currency; rows without a
  reporting value last),
  `impressions`, `clicks`, `conversions` or `name`. Pagination: offset cursor bound to the request
  (a cursor from another request is `INVALID_ARGUMENT`), at most 100 per page.
- Default scope: every non-manager ad account of the org, **including unlinked and blocked ones**
  (their history belongs to the org). The coverage section tells whether they are still synced.
- Errors: `INVALID_ARGUMENT` with `details.field` (`range`, `compare`, `filters`,
  `filters.accountIds`, `parent`, `level`, `paginationOpts.cursor`) and, for ranges and budgets,
  `details.reason` (`invalid_date`, `from_after_to`, `too_long`, `too_many_rows`).

## Data states: missing vs zero

Every aggregate (totals, a bucket, an entity row, a group) carries `dataState`:

| `dataState`   | Meaning                                                                  | Metrics                                  |
| ------------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| `reported`    | rows exist; every account covers the whole range                         | present                                  |
| `partial`     | some day of some account is outside sync coverage                        | lower bounds                             |
| `no_delivery` | fully covered, no rows                                                   | omitted (**not 0**; a client may show 0) |
| `unknown`     | no rows and no coverage                                                  | omitted                                  |
| `unsupported` | no scoped account's provider reports this data (level/placement/actions) | omitted                                  |

Coverage is Phase 5's `syncAccounts.coveredFrom/coveredThrough`: inside it a missing row means no
delivery (platforms omit zero days). A window whose sync had unresolved or rejected records is not
covered (D11), so "missing inside coverage" really means no delivery. Coverage is per account (not
per level): such a window is also reported as not covered for account-level totals.

Per metric (`unavailableMetrics: { metric, reason }[]`, `partialMetrics: metric[]`):

- absent on every row → omitted, listed with reason `not_reported`;
- non-additive (`reach`) over more than one row → omitted, reason `non_additive`;
- a stored value that is negative or a fractional count → omitted, reason `invalid_data` (the
  Phase 5 write path rejects such values; this reason is defensive and matches the KPI reason);
- absent on some rows → summed over the rows that report it, listed in `partialMetrics`;
- a reported `0` stays `0`.

## Aggregation

- **Levels:** totals of level L come only from rows of level L.
- **Placement:** default rows are `placement = "all"` (the platform's own total). `breakdown` by
  placement reads only non-"all" rows and lists every placement a scoped provider can report. Never
  add breakdown rows to "all"; their sum may legitimately differ.
- **Additive metrics** (catalog `additive: true`): spend, impressions, clicks, link clicks, video,
  engagement metrics, conversions, conversion value, all conversions. Counts are summed as bigint
  integers, float metrics as 6-decimal fixed point, money as micros per currency.
- **Non-additive metrics** (`reach`): only at the stored grain (a single row: one entity, one day,
  one placement), i.e. in a day series of one entity or one account. Otherwise omitted with
  `non_additive`. No frequency KPI.
- `extras` and raw fields are never aggregated.

## KPI formulas

KPIs use **paired sums**: numerator and denominator are summed only over rows that report both. If
any contributing row lacked either, the KPI is listed in `partialKpis`.

| KPI                 | Formula                    | Type              |
| ------------------- | -------------------------- | ----------------- |
| `ctr`               | clicks / impressions       | fraction (number) |
| `conversionRate`    | conversions / clicks       | fraction (number) |
| `roas`              | conversion value / spend   | fraction (number) |
| `cpc`               | spend / clicks             | MoneyAmountsDto   |
| `cpm`               | spend × 1000 / impressions | MoneyAmountsDto   |
| `costPerConversion` | spend / conversions        | MoneyAmountsDto   |

Numbers:

- **All money values** (metrics and money KPIs) are `MoneyAmountsDto`:
  `{ native: Money[] (one per account currency, sorted), reporting?: Money }`, with Money =
  `{ currency, micros: string }`.
- **Ratios** (`ctr`, `conversionRate`, `roas`, percent changes) are **fractions** (`0.0123` =
  1.23 %), JSON numbers with at most 6 decimals. They are never multiplied by 100.
- Arithmetic is bigint with one division, rounded **half away from zero** (the `lib/money` rule).
  Float conversions enter as 6-decimal fixed point, so results do not depend on row order.

Money KPIs: `native` has one value per currency from that currency's paired sums (a currency whose
denominator is 0 is left out); `reporting` is computed from converted numerators over the total
denominator and exists only when every needed rate exists. `roas` uses native sums for one currency,
reporting sums for several, otherwise `mixed_currency`.

A KPI is omitted (listed in `unavailableKpis`, never `null` or 0) with the most specific reason:

| Reason                    | When                                                       |
| ------------------------- | ---------------------------------------------------------- |
| `numerator_unavailable`   | the numerator is not reported by any row                   |
| `denominator_unavailable` | the denominator is not reported, or no row reports both    |
| `zero_denominator`        | e.g. CTR with 0 impressions (0 clicks / 0 impressions too) |
| `mixed_currency`          | ROAS across currencies without complete rates              |
| `invalid_data`            | a negative or malformed stored value                       |

A numerator of 0 with a positive denominator gives 0.

## Action metrics

- `metricsDaily.conversions` is the **platform's primary conversions**: Meta sums the primary
  action types (purchase and lead in the mock, in the 7-day-click/1-day-view window); Google reports
  its primary conversions. It is never re-derived from action rows.
- `v1/analytics:actions` groups `actionMetricsDaily` rows by `(actionType, rawActionType,
conversionActionExternalId, attributionWindow, attributionBasis, isPrimary)`. **Different windows
  and different action types are never summed.** Google's mock action rows carry `all_conversions`
  per conversion action; they will not equal the wide primary `conversions`.
- Per group: `count` (fixed point), `value` (MoneyAmountsDto; `partialValue` if some rows of the
  group reported no value), `costPerAction` (MoneyAmountsDto), `valuePerSpend` (fraction).
- **Per-action KPI formulas.** The _scope spend_ is the summed `spendMicros` of the `metricsDaily`
  rows of the same scope: the same accounts (or the same entity), the same level, placement `"all"`,
  the same range.
  - `costPerAction` = scope spend / group count. `native`: spend of the accounts in currency C /
    the group count in C; `reporting`: converted scope spend / total group count.
  - `valuePerSpend` = group value / scope spend: native for one currency, reporting for several,
    otherwise `mixed_currency`.

  Spend is **not** paired row by row with action rows (unlike the wide-row KPIs): action rows are
  sparse (no row on a day without that action), and inside coverage a missing action row means zero
  actions, so pairing would drop the spend of days without conversions and understate the cost.
  Unavailable reasons: `numerator_unavailable` (no scope spend for `costPerAction`, no value for
  `valuePerSpend`), `denominator_unavailable` (no scope spend for `valuePerSpend`),
  `zero_denominator`, `mixed_currency`, `invalid_data`.

- No placement breakdown (sync stores action rows for "all" only).
- **Real Meta provider (Phase 8, `PROVIDER_MODE=live`), PROVISIONAL until validated on a real
  account:** wide `conversions` / `conversionValue` are Meta's `omni_purchase` + `lead` with each ad
  set's attribution setting (Ads Manager default); they are absent (not 0) on rows that reported
  neither, so a range can show them as partial. Action groups are the conversion types (`omni_*`,
  `lead`, custom conversions) in the fixed windows `1d_click`, `7d_click` and `1d_view`, each its own
  group, with basis `impression_or_click_date` (`action_report_time=impression`). As for Google, the
  wide conversions and the window groups are not expected to reconcile. The public contract does
  not change ([providers/meta.md](providers/meta.md#real-account-validation-required)). The mock
  behavior above is unchanged.

## Periods and time zones

- Queries take explicit inclusive ranges `{ from, to }` (`YYYY-MM-DD`), 1–400 days. **Queries never
  read the clock**: validity depends only on the supplied range, and the same range always gives the
  same result for the same data. Days without synced data (for example future days) are not rejected;
  they are outside coverage and come back as `unknown` / `partial`.
- **Presets** are our own API contract, resolved by `convex/analytics/periods.ts`
  (`resolvePreset(preset, today)`) with `today = todayIn(org.timezone)`:

  | Preset           | Range                                |
  | ---------------- | ------------------------------------ |
  | `today`          | today .. today                       |
  | `yesterday`      | today−1 .. today−1                   |
  | `last_7_days`    | today−7 .. today−1 (today excluded)  |
  | `last_30_days`   | today−30 .. today−1 (today excluded) |
  | `month_to_date`  | 1st of the month .. today            |
  | `previous_month` | the full previous calendar month     |
  | `week_to_date`   | the ISO week's Monday .. today       |
  | `previous_week`  | previous Monday .. Sunday            |

- One range applies to **each ad account's own local days** (the Phase 2 model); days are never
  re-cut into another timezone. An account ahead of the org's timezone has its newest local day
  excluded until that day is "today" for the org. DST only affects `todayIn`.
- Buckets: day = the date; week = the ISO week's Monday; month = `YYYY-MM`. Edge buckets cut by the
  range are `partial: true`.

## Currency (FX)

- Reporting currency: `organizations.reportingCurrency` (`v1/orgs:updateSettings`).
- Rates: the global `fxRates` reference table, **units of quote per 1 USD** (USD pivot), exact
  decimal strings with at most 12 fractional digits. Written only by internal
  `admin/fxRates:upsert` (`npx convex run admin/fxRates:upsert '{"rates":[{"quote":"EUR",
"date":"2026-04-01","rate":"0.92"}]}'`). No external rate source yet (a later integration writes
  through the same path).
- For each (currency, account-local day) the rate of that day is used, or the latest rate at most
  7 days older; otherwise the rate is missing.
- Per-day amounts per currency are converted once: `micros × rate(to) / rate(from)`, one bigint
  division, half away from zero.
- If every scoped account uses the reporting currency, no rates are read (`fx.status =
"not_needed"`). Otherwise `complete`, or `missing` with `[{ currency, days }]`, in which case
  `reporting` values are omitted and `native` values remain.
- Results are live: correcting a rate changes historical reporting values. There are no snapshots.

## Comparison

`compare: "previous_period"` (the same number of days immediately before) or an explicit range.
Year-over-year is deferred.

| Situation           | `absolute`         | `percent`                              |
| ------------------- | ------------------ | -------------------------------------- |
| normal              | current − previous | (cur − prev) / prev, fraction          |
| previous = 0        | returned           | omitted, reason `previous_zero`        |
| previous missing    | omitted            | omitted, reason `previous_unavailable` |
| either side partial | returned           | returned, `partial: true`              |

When the **current** value is missing there is no delta entry at all: the current aggregate already
lists the metric or KPI in `unavailableMetrics` / `unavailableKpis` with its reason.

Money deltas are `MoneyAmountsDto` (native per currency present in both periods, reporting when
both have it). The money percent uses reporting values, or a single shared currency; otherwise
`mixed_currency`. Ratio KPI deltas are fraction differences. Reach is never compared.

## Public enum values

Every value below is intentional and contract-tested (`convex/v1/analytics.test.ts`, "public
enums"). No provider-specific value appears in these enums; raw platform values only appear as data
(for example `rawActionType`).

- `dataState`: `reported`, `partial`, `no_delivery`, `unknown`, `unsupported`
- `unavailableMetrics[].reason`: `not_reported`, `non_additive`, `invalid_data`
- `unavailableKpis[].reason`: `numerator_unavailable`, `denominator_unavailable`,
  `zero_denominator`, `mixed_currency`, `invalid_data`
- delta `reason`: `previous_zero`, `previous_unavailable`, `mixed_currency`
- `fx.status`: `not_needed`, `complete`, `missing`
- KPI names: `ctr`, `conversionRate`, `roas`, `cpc`, `cpm`, `costPerConversion`; action groups:
  `costPerAction`, `valuePerSpend`

## Testing

`convex/analytics/*.test.ts` (numeric, aggregation and KPIs, periods and DST, FX, comparison,
actions), `convex/v1/analytics.test.ts` (exact seeded totals, data states, currencies and rates,
comparison, timezones, validation, read budget, pagination, parent scopes, tenant isolation, and
every query over real Phase 5 mock syncs), `convex/sync/coverage.test.ts` (D11),
`tests/lint/analytics-guards.test.ts`, and `tests/live/sync.live.test.ts` (analytics over HTTP).
