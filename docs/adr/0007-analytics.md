# ADR 0007 — Analytics

- Status: accepted
- Date: 2026-09-25

## Context

Phase 5 fills the canonical tables (ADR 0003) with replaced, pruned, account-local daily rows and
records per-account coverage (ADR 0006). Phase 6 must turn them into totals, time series,
performance lists, breakdowns and KPIs for the dashboard (Phase 7) and parent apps, inside Convex
query limits, with exact money, explicit missing-data semantics and reporting-currency conversion.

## Decisions

1. **D1 Query-time aggregation** over the canonical rows with strict read budgets. No rollup
   tables. The budgets (8,000 metric reads including loaded account/entity documents, 8,000 action
   rows per query) are **application-level Phase 6 safety limits, not Convex platform limits**: they
   make every analytics query bounded and deterministic, failing with `too_many_rows` instead of
   returning truncated results.
2. **D2** New index `actionMetricsDaily.by_org_account_level_date` so account/campaign-level action
   totals never scan ad-level rows.
3. **D3** Global `fxRates` reference table (USD pivot, exact decimal-string rates, internal writes
   only, no external rate fetch). The only new table without `orgId`.
4. **D4** FX rate of the metric's account-local day, falling back at most 7 days; otherwise no
   reporting-currency value.
5. **D5** Explicit `{from, to}` ranges; presets resolved by a shared pure resolver; queries never
   read the clock (range validity depends only on the range; days without data are `unknown`).
6. **D6** One range applied to each account's own local days; the org timezone only defines "today".
7. **D7** bigint / fixed-point arithmetic, half away from zero. All money values (metrics and money
   KPIs cpc, cpm, costPerConversion) are `MoneyAmountsDto`; ctr, conversionRate and roas are
   6-decimal fractions.
8. **D8** KPIs from paired sums with `partial` flags.
9. **D9** Wide `conversions` = platform primary conversions, kept separate from action metrics;
   action groups are never summed across attribution windows or action types.
10. **D10** Non-additive metrics (reach) only at the stored grain.
11. **D11** A Phase 5 metric window with unresolved or rejected records does not advance coverage
    (minimal change to `completedWindows` in `sync/runs.ts`).
12. **D12** Five public queries: `v1/analytics:overview`, `timeSeries`, `performance`,
    `breakdown`, `actions`. Performance lists every entity of the scoped set, each with its own
    `dataState` (no-delivery entities appear as `no_delivery`). Per-action KPIs use the scope's
    same-level spend (action rows are sparse; see docs/analytics.md).
13. **D13** Blocked and unlinked accounts' history is included by default; manager accounts never.
14. **D14** Ranges of 1–400 days, pages of at most 100, at most 50 account ids.
15. **D15** Comparison: previous period or a custom range.

## Alternatives rejected

- **Materialized daily/monthly rollups now:** summing ad rows into campaign totals is wrong for
  reach and platform de-duplication; stored levels already are the platform's own rollups. Rollups
  would need delta maintenance in the sync write path plus a recompute job (drift risk, write
  amplification) for scale this service does not have yet.
- **Server-side presets:** reading the clock in reactive, cached queries makes results stale.
- **Converting at write time / storing converted money:** loses the authoritative native amount
  and needs recomputation when rates change.
- **Org-scoped FX tables:** duplicates public reference data per tenant.
- **Deriving conversions from action rows:** Meta and Google define primary conversions differently;
  summing action rows would mix windows and business events.
- **Percent values (×100) and `null` for undefined KPIs:** ambiguous; fractions plus omission with
  a reason are explicit.

## Consequences

- Very large orgs can hit `too_many_rows` until rollups exist (trigger: the Phase 13 load test or
  real budget pressure). Subscribed analytics queries re-run on sync commits.
- Historical reporting-currency values change when a rate is corrected.
- Phase 7 builds the dashboard on these five queries and `analytics/periods.ts`.
- Phase 8 may add per-account conversion mapping; the action groups already expose every raw action.
