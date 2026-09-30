# ADR 0003 — Canonical data model: identity, money, metric grain, time zones

- Status: accepted
- Date: 2026-09-24

## Context

Meta Ads, Google Ads and Instagram return different hierarchies, id formats, money encodings,
metric sets and day boundaries. The dashboard, the v1 API and the future SDK need one
provider-neutral model that stays correct under restated data, multi-tenancy and several
currencies. The model must also be stable enough that providers (Phase 3+) and the sync engine
(Phase 5) plug into it without schema rewrites.

## Decisions

1. **Separate trees.** Paid advertising (`adAccounts` > `campaigns` > `adGroups` > `ads`, plus
   `creatives`) and organic social (`socialAccounts` > `socialPosts`, plus metric tables) are
   separate. The only link between them is a soft reference from a creative to an Instagram media
   id. There is no generic content table.
2. **Tenancy.** Every non-root table has `orgId`, and every index starts with `orgId`. Both rules are
   test-enforced.
3. **Identity.** External ids are strings in one canonical form per platform (`domain/identity.ts`).
   Natural keys are (`orgId`, `platform`, `externalId`) for accounts and (`orgId`, parent account,
   `externalId`) for children. Google ad ids become `"{adGroupId}~{adId}"`. Internal references use
   Convex ids.
4. **Money = int64 micros** in the account currency. Float micros lose precision past 2^53, which
   high-denomination currencies reach. DTOs carry micros as strings. Currency conversion happens at
   read time.
5. **Metric grain.**
   - A wide `metricsDaily` table, one row per entity × day × placement, with canonical optional
     columns.
   - A long `actionMetricsDaily` table, one row per action type and attribution window.
   - `placement = "all"` is its own row.
   - Rows are replaced on re-sync, never incremented.
   - Ratios are never stored.
6. **Days.** Ad metric days are account-local `YYYY-MM-DD` keys, matching the platform UIs.
   Instants are epoch ms.
7. **Missing data.** An absent field means unknown; `0` means reported zero. Both are preserved
   through aggregation (`sumMicros`).
8. **Tables per phase.** Only tables with a Phase 2 data model are created now. Connection, sync,
   rollup, inbox and alert tables arrive with the phase that writes them. These are non-breaking,
   additive schema changes.

## Alternatives rejected

- **A single generic metrics table** (metric name → value), for every metric: flexible, but it
  multiplies row count and makes dashboard reads and typing expensive. The long form is kept only
  for action types, where it is necessary.
- **Float micros or decimal strings for money:** precision loss, or no arithmetic or index support.
- **Converting metric days to UTC or the org timezone:** impossible to do correctly without hourly
  data, and it would disagree with the platform UIs.
- **Hierarchy-agnostic "node" table** for campaigns, ad groups and ads: weaker typing, and each level
  has distinct fields (budgets, kinds, creatives).

## Consequences

- Aggregations must filter on `placement` and treat reach and other non-additive metrics carefully
  (Phase 6).
- Mixed time zones in one org mean org-level daily charts combine account-local days.
- Uniqueness depends on the single write path (Phase 5). Convex has no unique constraints.
- `actionMetricsDaily` can grow quickly. The volume policy belongs to sync (Phase 5/8), and retention
  to Phase 16.
