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

- connections, credentials, OAuth state, discovered assets: Phase 4; pending OAuth grants (`oauthGrants`): S2 (see [connections.md](connections.md))
- sync state, runs and tasks: Phase 5 (see [sync.md](sync.md))
- FX rates (`fxRates`, global reference data): Phase 6 (see [analytics.md](analytics.md)); rollups
  are deferred (Phase 6 aggregates at query time)
- inbox: Phase 11
- alerts: Phase 12

## Tenancy

- Every table except `integrationApps`, `organizations` and `fxRates` (Phase 6: public exchange-rate
  reference data, written only by internal admin functions) has a required `orgId`.
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

Natural keys, which the Phase 5 write path (`convex/sync/upsert.ts`) uses through the matching index:

| Table                                  | Natural key                                                        | Index                                 | Write rule                                                       |
| -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------- | ---------------------------------------------------------------- |
| adAccounts                             | orgId, platform, externalId                                        | `by_org_platform_external`            | replace provider-owned fields (link: field update)               |
| campaigns / adGroups / ads / creatives | orgId, adAccountId, externalId                                     | `by_org_account_external`             | replace provider-owned fields, keep `createdAt`                  |
| metricsDaily                           | orgId, entityId, placement, date                                   | `by_org_entity_placement_date`        | **replace**, and delete rows that vanish from a re-synced window |
| actionMetricsDaily                     | orgId, entityId, placement, date, rawActionType, attributionWindow | `by_org_entity_placement_date_action` | replace, and delete rows that vanish from a re-synced window     |
| socialAccounts                         | orgId, platform, externalId                                        | `by_org_platform_external`            | patch                                                            |
| socialPosts                            | orgId, socialAccountId, externalId                                 | `by_org_account_external`             | patch                                                            |
| socialPostMetricSnapshots              | orgId, postId, capturedDate                                        | `by_org_post_date`                    | replace                                                          |
| socialAccountMetricsDaily              | orgId, socialAccountId, date                                       | `by_org_account_date`                 | replace                                                          |

- **Why Meta and Google cannot collide:** account keys include the platform, and child keys include
  their ad account.
- **Two orgs, one external account:** the same external account connected by two orgs gives two
  independent rows.
- **Uniqueness:** Convex has no unique constraints. Uniqueness is guaranteed by the single Phase 5
  write path (`convex/sync/upsert.ts`, ESLint-enforced): each write reads its natural-key range and
  writes in the same serializable mutation.
- **Replace, not patch (Phase 5):** a field the platform stops reporting disappears. Service-owned
  fields (`createdAt`, and `connectionId`/`linkedAt` on ad accounts) are preserved. Removed entities
  get `removedAt` after a complete full listing; they are never deleted (see [sync.md](sync.md)).
  Social tables follow the Phase 10 Stage B rules (column groups, lifetime snapshots, bounded
  removal; see [sync.md](sync.md#organic-social-write-path-phase-10-stage-b)).

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
- **`socialAccountMetricsDaily.date`:** the **UTC day** Instagram insights were requested for
  (one `since`/`until` UTC-day window per request, Phase 10 Stage B). Whether this matches the
  Instagram app's day is [PROVISIONAL IR6/IR18]; see
  [providers/instagram.md](providers/instagram.md).

Helpers live in `convex/lib/dates.ts` (Intl-based, no date library).

## Metrics

### Wide table `metricsDaily`

One row per entity × date × placement. The columns come from the `AD_METRICS` catalog
(`convex/domain/metrics.ts`):

| Column                                          | Kind  | Additive | Meta source (Phase 8)                                                       | Google source (Phase 9) |
| ----------------------------------------------- | ----- | -------- | --------------------------------------------------------------------------- | ----------------------- |
| spendMicros                                     | money | yes      | `spend`                                                                     | `cost_micros`           |
| impressions                                     | count | yes      | `impressions`                                                               | `impressions`           |
| reach                                           | count | **no**   | `reach`                                                                     | not reported            |
| clicks                                          | count | yes      | `clicks`                                                                    | `clicks`                |
| linkClicks                                      | count | yes      | `inline_link_clicks`                                                        | not reported            |
| videoPlays                                      | count | yes      | `video_play_actions`                                                        | —                       |
| videoViews                                      | count | yes      | 3-second video views                                                        | not reported (deferred) |
| videoCompletions                                | count | yes      | `video_p100_watched_actions`                                                | not reported (deferred) |
| engagements                                     | count | yes      | `post_engagement` action                                                    | not reported (deferred) |
| reactions / comments / shares / saves / follows | count | yes      | `actions` (post_reaction, comment, post, onsite_conversion.post_save, like) | —                       |
| conversions                                     | float | yes      | primary actions per account mapping                                         | `conversions`           |
| conversionValueMicros                           | money | yes      | primary `action_values`                                                     | `conversions_value`     |
| allConversions                                  | float | yes      | —                                                                           | `all_conversions`       |
| extras                                          | map   | —        | unmapped numeric metrics                                                    | —                       |

Exact mappings: [providers/meta.md](providers/meta.md) and [providers/google-ads.md](providers/google-ads.md).

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

Google (Phase 9): `rawActionType` holds the conversion action's immutable resource name (not the
mutable display name), `conversionActionExternalId` its id, `isPrimary` its `primary_for_goal`, and
`attributionWindow` the bucket `action_setting` (Google reports no per-row window). Google's wide
`conversions` also counts custom-goal actions, so it is not recomputed from `isPrimary` rows
([providers/google-ads.md](providers/google-ads.md#conversion-actions-fetchactionmetrics)).

### Placement

- `placement = "all"` is the platform's own total, stored as its own row.
- Breakdown rows (`facebook`, `instagram`, `google_search`, …) sit next to it.
- **Never sum "all" together with breakdown rows.** Reach and other non-additive metrics are only
  correct as reported.

### Missing data

| State                                             | Meaning                                                |
| ------------------------------------------------- | ------------------------------------------------------ |
| field absent                                      | not reported or not applicable                         |
| `0`                                               | reported as zero                                       |
| row absent for (entity, day) inside sync coverage | no delivery (platforms omit zero days)                 |
| row absent outside coverage                       | unknown (coverage: `syncAccounts.coveredFrom/Through`) |

Coverage only includes metric windows whose sync resolved every record (no unresolved or rejected
rows), so "absent inside coverage" really means no delivery (Phase 6, D11).

Real Meta data (Phase 8): the live Meta provider keeps these semantics with PROVISIONAL mappings
(D18): a field or action type Meta did not return stays absent, an explicit `"0"` is 0, and a day
without delivery has no row. Its conversions (D19), action attribution (D20), placements, reach and
money semantics are implemented provisionally and require validation on a real account
([providers/meta.md](providers/meta.md#real-account-validation-required)). No schema change.

- Never write `0` for "unknown".
- Ratios (CTR, CPC, CPM, CPA, ROAS, engagement rate) are **never stored**. Phase 6 computes them from
  summed components and omits them when the denominator is absent or zero.

### Organic

- Phase 10 Stage A adds linking only:
  - `socialAccounts.connectionId?` and `linkedAt?`, plus the index `by_org_connection`;
  - the discovery table `discoveredSocialAccounts` (org, connection, platform, externalId,
    username?, accountType, discoveredAt).
- Linked accounts are upserted by natural key `(orgId, platform, externalId)` through
  `sync/upsert.ts`, which is also the single write path for all four social tables (ESLint).
- `name` is the username as a label until the first sync preflight (Stage B).
- `socialPosts` stores the permalink as its only URL (validated host and format); captions are
  capped at 2,200 characters. No media, thumbnail or profile picture URL, biography, website,
  comment or commenter is stored. Removed posts get `removedAt` and are never deleted.
- `socialPostMetricSnapshots` stores **cumulative lifetime** values, one row per post per UTC
  capture day (the last capture of a day wins). **No post deltas** are stored or computed: the
  API and the dashboard present lifetime totals as of a capture, never differenced into daily
  values (Stage B decision).
- `socialAccountMetricsDaily` stores daily account values in two column groups with provenance
  fields (Stage B, additive, optional):
  - **profile:** `followers` and `followersCapturedAt` (when the follower count was captured,
    by the sync preflight, on that UTC day);
  - **insights:** the other metrics, `extras` (`likes`, `comments`, `shares`, `saves`, `replies`,
    `profileLinksTaps`) and `insightsSyncedAt` (when the day's insights were synced, also for an
    empty day, so "synced but not reported" differs from "not synced").
    `profileViews` and `websiteClicks` (deprecated by Instagram) are never written.
- Paid and organic engagement are never merged. Their engagement rates use different denominators
  (per impression versus per reach).

## Assumptions carried forward

- Performance Max is modeled as `adGroups.kind = "asset_group"` with no ads. There is no asset-level
  reporting.
- There are no age, gender or device breakdown tables. A breakdown like that would get its own table
  later.
- Instagram account-level reporting-day semantics (UTC day windows) are implemented but
  unverified on a real account ([PROVISIONAL IR6/IR18]).
- Volume policy (Phase 5): `actionMetricsDaily` rows are synced with `placement = "all"` only (no
  placement breakdown) at every supported level; Phase 8 may further limit action types. The schema
  itself is generic.
- `attributes` and `extras` maps are capped at 50 keys by the Phase 5 write path (attribute values at
  1,024 characters; `headlines`/`descriptions` at 20 items).

## Retention (proposed future defaults only; not implemented)

- Account- and campaign-level daily metrics: 37 months.
- Ad-group and ad-level daily metrics: 25 months.
- Post snapshots: daily for 90 days, then thinned to weekly.

These are candidates for the Phase 16 retention job, configurable per org. They are not
requirements.

## v1 exposure (Phase 6: metrics via `v1/analytics:*`, see [analytics.md](analytics.md))

| Expose                                                                                     | Keep internal                                                              |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `id`, `platform`, `externalId`, `name`, normalized status / delivery / objective / channel | `orgId`, internal parent ids beyond the DTO's own references               |
| budgets and money as Money DTOs; DateKeys; ISO instants                                    | `rawStatus` / `rawObjective`, `attributes`, `extras` (reviewed per field)  |
| present metrics plus computed KPIs; account currency, timezone and freshness               | `syncedAt`, `lastSeenAt`, `isManager`, `parentExternalId`, connection data |
