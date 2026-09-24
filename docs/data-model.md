# Canonical data model

The provider-neutral model every platform integration normalizes into (providers produce records
that `convex/mapping` turns into these rows; see [providers/architecture.md](providers/architecture.md)). It is defined in
`convex/tables/*` and `convex/domain/*`, and composed in `convex/schema.ts`. The rules below are
enforced by `convex/schema.test.ts` unless noted otherwise.

## Entities

```text
organizations (Phase 1, global)
 ├─ adAccounts                 platform: meta | google_ads
 │   ├─ campaigns
 │   │   └─ adGroups           kind: ad_set (Meta) | ad_group (Google) | asset_group (Google PMax)
 │   │       └─ ads ──(optional)── creatives
 │   ├─ creatives              Meta: reusable object; Google: one per ad
 │   ├─ metricsDaily           wide: entity × date × placement
 │   └─ actionMetricsDaily     long: entity × date × placement × action type × attribution window
 └─ socialAccounts             platform: instagram | facebook (also owns future inbox threads)
     ├─ socialPosts
     │   └─ socialPostMetricSnapshots   cumulative lifetime values per capture day
     └─ socialAccountMetricsDaily
creatives.instagramMediaExternalId ··· socialPosts.externalId   (soft link: promoted organic post)
```

Paid advertising and organic social are **separate trees**. There is no generic "content" or
"engagement" table. Instagram ads are Meta ads with `placement = "instagram"`.

Tables for later phases are added by the phase that writes them:

- connections, credentials, OAuth state, discovered assets: Phase 4 (see [connections.md](connections.md))
- sync runs: Phase 5
- rollups, FX rates: Phase 6
- inbox: Phase 11
- alerts: Phase 12

## Tenancy

- Every table except `integrationApps` and `organizations` has a required `orgId`.
- Every index on those tables starts with `orgId`.
- Every one of them is a `TenantTable`, so `getOwned()` works on it.
- Internal references are Convex ids (`v.id(...)`). External ids never cross tables as foreign keys,
  except for the documented soft link above.

## Identity

External ids are **strings**. Google ids are int64 and exceed 2^53.
`convex/domain/identity.ts` produces the canonical forms:

| Platform   | Entity                            | Stored `externalId`                          |
| ---------- | --------------------------------- | -------------------------------------------- |
| Meta       | ad account                        | numeric, no `act_` prefix                    |
| Meta       | campaign / ad set / ad / creative | numeric string                               |
| Google Ads | customer                          | 10 digits, no dashes                         |
| Google Ads | campaign / ad group / asset group | numeric string                               |
| Google Ads | ad, creative                      | `"{adGroupId}~{adId}"` (unique per ad group) |
| Instagram  | account / media                   | numeric string                               |
| Facebook   | page                              | numeric string                               |

Natural keys, which Phase 5 upserts use through the matching index:

| Table                                  | Natural key                                                        | Index                                 | Write rule                                                   |
| -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------ |
| adAccounts                             | orgId, platform, externalId                                        | `by_org_platform_external`            | patch                                                        |
| campaigns / adGroups / ads / creatives | orgId, adAccountId, externalId                                     | `by_org_account_external`             | patch                                                        |
| metricsDaily                           | orgId, entityId, placement, date                                   | `by_org_entity_placement_date`        | **replace**                                                  |
| actionMetricsDaily                     | orgId, entityId, placement, date, rawActionType, attributionWindow | `by_org_entity_placement_date_action` | replace, and delete rows that vanish from a re-synced window |
| socialAccounts                         | orgId, platform, externalId                                        | `by_org_platform_external`            | patch                                                        |
| socialPosts                            | orgId, socialAccountId, externalId                                 | `by_org_account_external`             | patch                                                        |
| socialPostMetricSnapshots              | orgId, postId, capturedDate                                        | `by_org_post_date`                    | replace                                                      |
| socialAccountMetricsDaily              | orgId, socialAccountId, date                                       | `by_org_account_date`                 | replace                                                      |

- **Why Meta and Google cannot collide:** account keys include the platform, and child keys include
  their ad account.
- **Two orgs, one external account:** the same external account connected by two orgs gives two
  independent rows.
- **Uniqueness:** Convex has no unique constraints. Uniqueness is guaranteed by the single Phase 5
  write path.

## Money

- Stored as **int64 micros** (`bigint`) in the owning account's currency: 1 unit = 1,000,000 micros.
  Every field named `*Micros` is int64, and only those are.
- Parsing (`convex/lib/money.ts`):
  - Meta decimal strings: `parseDecimalToMicros`, exact, no floats.
  - Google doubles: `numberToMicros`, rounded half away from zero.
  - Google `cost_micros` is already micros.
- Sums use `sumMicros`, which returns `undefined` when no value is present.
- Money is never converted when stored. The org's `reportingCurrency` is applied at read time with
  `fxRates` (Phase 6).
- **DTO convention (v1, from Phase 6):** `{ currency: "USD", micros: "123450000" }`, with micros as a
  string for lossless JSON and HTTP transport.

## Dates and time zones

| Kind                 | Storage                                                               | DTO          |
| -------------------- | --------------------------------------------------------------------- | ------------ |
| Instant (`*At`)      | epoch ms `number`                                                     | ISO-8601 UTC |
| Calendar day         | `DateKey` string `YYYY-MM-DD` (sorts correctly, so index ranges work) | same string  |
| Ranges               | inclusive `from` / `to`                                               | same         |
| Week / month buckets | computed at read time (ISO week from Monday, `YYYY-MM`)               | strings      |

Which timezone defines a day:

- **Ad metrics:** the **ad account's** timezone. This matches Ads Manager and the Google Ads UI.
  Accounts in different time zones are grouped by their own days in org-level charts. This is an
  accepted trade-off, because days cannot be re-cut without hourly data.
- **Campaign and ad group `startDate` / `endDate`:** also account-local days.
- **Organic `publishedAt`:** an instant, grouped by the org timezone at read time.
- **`socialPostMetricSnapshots.capturedDate`:** the UTC day of capture.
- **`socialAccountMetricsDaily.date`:** the platform's reporting day. Instagram's exact semantics are
  **unverified until Phase 10**.

Helpers live in `convex/lib/dates.ts` (Intl-based, no date library).

## Metrics

### Wide table `metricsDaily`

One row per entity × date × placement. The columns come from the `AD_METRICS` catalog
(`convex/domain/metrics.ts`):

| Column                                          | Kind  | Additive | Meta source (Phase 8)                                                       | Google source (Phase 9)       |
| ----------------------------------------------- | ----- | -------- | --------------------------------------------------------------------------- | ----------------------------- |
| spendMicros                                     | money | yes      | `spend`                                                                     | `cost_micros`                 |
| impressions                                     | count | yes      | `impressions`                                                               | `impressions`                 |
| reach                                           | count | **no**   | `reach`                                                                     | not reported                  |
| clicks                                          | count | yes      | `clicks`                                                                    | `clicks`                      |
| linkClicks                                      | count | yes      | `inline_link_clicks`                                                        | not reported                  |
| videoPlays                                      | count | yes      | `video_play_actions`                                                        | —                             |
| videoViews                                      | count | yes      | 3-second video views                                                        | TrueView video views          |
| videoCompletions                                | count | yes      | `video_p100_watched_actions`                                                | `video_quartile_p100` derived |
| engagements                                     | count | yes      | `post_engagement` action                                                    | `engagements`                 |
| reactions / comments / shares / saves / follows | count | yes      | `actions` (post_reaction, comment, post, onsite_conversion.post_save, like) | —                             |
| conversions                                     | float | yes      | primary actions per account mapping                                         | `conversions`                 |
| conversionValueMicros                           | money | yes      | primary `action_values`                                                     | `conversions_value`           |
| allConversions                                  | float | yes      | —                                                                           | `all_conversions`             |
| extras                                          | map   | —        | unmapped numeric metrics                                                    | e.g. impression share         |

The exact mappings are confirmed when each provider is built.

### Long table `actionMetricsDaily`

Every conversion/action type and attribution window:

- `actionType`: normalized category
- `rawActionType`: the platform's own name
- `conversionActionExternalId`
- `attributionWindow`: e.g. `7d_click_1d_view`
- `attributionBasis`: `impression_or_click_date` or `conversion_date`
- `count` (float) and `valueMicros`
- `isPrimary`

`metricsDaily.conversions` is the account's primary total. It can be recomputed from this table
when the conversion mapping changes.

### Placement

- `placement = "all"` is the platform's own total, stored as its own row.
- Breakdown rows (`facebook`, `instagram`, `google_search`, …) sit next to it.
- **Never sum "all" together with breakdown rows.** Reach and other non-additive metrics are only
  correct as reported.

### Missing data

| State                                             | Meaning                                         |
| ------------------------------------------------- | ----------------------------------------------- |
| field absent                                      | not reported or not applicable                  |
| `0`                                               | reported as zero                                |
| row absent for (entity, day) inside sync coverage | no delivery (platforms omit zero days)          |
| row absent outside coverage                       | unknown (coverage tracking is added in Phase 5) |

- Never write `0` for "unknown".
- Ratios (CTR, CPC, CPM, CPA, ROAS, engagement rate) are **never stored**. Phase 6 computes them from
  summed components and omits them when the denominator is absent or zero.

### Organic

- `socialPostMetricSnapshots` stores **cumulative lifetime** values, one row per post per UTC
  capture day. Daily deltas are computed in Phase 10.
- `socialAccountMetricsDaily` stores daily account values.
- Paid and organic engagement are never merged. Their engagement rates use different denominators
  (per impression versus per reach).

## Assumptions carried forward

- Performance Max is modeled as `adGroups.kind = "asset_group"` with no ads. There is no asset-level
  reporting.
- There are no age, gender or device breakdown tables. A breakdown like that would get its own table
  later.
- Instagram account-level reporting-day semantics are unverified until Phase 10.
- Volume policy (Phase 5/8): ad-level `actionMetricsDaily` rows will likely be limited to
  `placement = "all"` and relevant action types. The schema itself is generic.
- `attributes` and `extras` maps will be capped at 50 keys by the Phase 5 write path.

## Retention (proposed future defaults only; not implemented)

- Account- and campaign-level daily metrics: 37 months.
- Ad-group and ad-level daily metrics: 25 months.
- Post snapshots: daily for 90 days, then thinned to weekly.

These are candidates for the Phase 16 retention job, configurable per org. They are not
requirements.

## v1 exposure (from Phase 6; nothing is exposed yet)

| Expose                                                                                     | Keep internal                                                              |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `id`, `platform`, `externalId`, `name`, normalized status / delivery / objective / channel | `orgId`, internal parent ids beyond the DTO's own references               |
| budgets and money as Money DTOs; DateKeys; ISO instants                                    | `rawStatus` / `rawObjective`, `attributes`, `extras` (reviewed per field)  |
| present metrics plus computed KPIs; account currency, timezone and freshness               | `syncedAt`, `lastSeenAt`, `isManager`, `parentExternalId`, connection data |
