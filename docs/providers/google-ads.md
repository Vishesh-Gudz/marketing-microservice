# Google Ads provider (Phase 9)

The Google Ads API behind the existing `AdsProvider` and `OAuthSpec` contracts
([architecture.md](architecture.md)). Decisions: [ADR 0010](../adr/0010-google-ads-provider.md).

> **Status: Stage B (mappings).** Connecting a Google account, discovering customers through
> manager hierarchies, and syncing campaigns, ad groups, Performance Max asset groups, ads,
> creatives, daily metrics with network placements and conversion-action rows into the canonical
> tables work end to end in live mode. Mappings are implemented from the Google Ads API v25
> reference; the items marked provisional are **not verified against a real account** (no real
> Google Ads account has been used; nothing here is real-account evidence). See
> [Real-account validation required](#real-account-validation-required).

## Stages

| Stage      | Status                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------- |
| H0         | Approved (plan revision 2).                                                                   |
| Stage A    | Done: config, credential, client, errors, GAQL, cursor, routing, OAuth, discovery.            |
| Stage B    | Done: structure/metric/action/placement mappings + "Real-account validation required".        |
| Access     | Done (2026-10): no developer token; Cloud-project access levels ([API access](#api-access)).  |
| Validation | A Test-access Cloud project with test accounts, then Explorer/Basic access on a real account. |

## Provider mode

`PROVIDER_MODE` (Phase 8, D8) is unchanged. In `live` mode:

- **Google configured** (`GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` set): the real Google
  provider and OAuth spec are registered.
  Missing or invalid values fail closed per call with `unknown` / `google_config_invalid`
  (never reauth, never an account block).
- **Google not configured**: the Phase 8 unavailable stub stays (`auth` / `provider_unavailable`,
  no Google OAuth), exactly as before.

`mock` and misconfigured modes are unchanged.

## Setup runbook (operator)

1. **Google Cloud project → OAuth client** (type "Web application"). Authorized redirect URI
   (exact, one per deployment): `<CONVEX_SITE_URL>/oauth/callback`, i.e.
   `https://<deployment>.convex.site/oauth/callback` for a cloud deployment and
   `http://127.0.0.1:3211/oauth/callback` for the local backend. Consent screen: scopes
   `https://www.googleapis.com/auth/adwords` and `openid` only. `adwords` is a sensitive scope:
   production use requires Google's OAuth app verification; while the app is in "Testing", only
   listed test users can consent and refresh tokens expire after about 7 days (users must
   reconnect).
2. **Google Ads API access of the same Cloud project** (no developer token; see
   [API access](#api-access)): enable the Google Ads API (the project gets Test access), then apply
   for Explorer (or Basic, which needs brand verification) on the project's Google Ads API Overview
   page. A Test-access project can reach test accounts only.
3. **Convex env** (never in files; set values interactively, e.g.
   `npx convex env set GOOGLE_CLIENT_SECRET`, so they stay out of shell history):

   ```bash
   npx convex env set PROVIDER_MODE live
   npx convex env set GOOGLE_CLIENT_ID
   npx convex env set GOOGLE_CLIENT_SECRET
   ```

   Optional: `GOOGLE_ADS_API_VERSION` (validated `vNN`; default `v25`). `PROVIDER_MODE=live`
   switches EVERY platform of that deployment to its live provider (no mock data); use a separate
   deployment for live validation. A leftover `GOOGLE_ADS_DEVELOPER_TOKEN` is ignored (remove it
   with `npx convex env remove GOOGLE_ADS_DEVELOPER_TOKEN`).

4. For development without real delivery: Google Ads **test accounts** (under a test manager
   account) work with Test access (they do not serve ads, so they have no metrics).

## API access

Verified against Google's documentation on 2026-10-20 (pages last updated 2026-10-14 to
2026-10-19):

- **Developer tokens were sunset on 2026-09-09**
  ([Developer token](https://developers.google.com/google-ads/api/docs/api-policy/developer-token)).
  The `developer-token` header is "optional and ignored by the API servers", and Google "will
  start rejecting developer tokens in API calls in a future major version". This service never
  sends one and has no developer-token configuration. (The older
  [REST auth page](https://developers.google.com/google-ads/api/rest/auth) still lists the header
  as required; the dedicated developer-token page supersedes it.)
- **Access belongs to the Google Cloud project** that owns the OAuth client ID and secret (user
  authentication). All tenants share that project's access level and daily quota.
- **Access levels**
  ([Access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels)):

  | Level    | Accounts            | Operations / day                  | How                                                     |
  | -------- | ------------------- | --------------------------------- | ------------------------------------------------------- |
  | Test     | test accounts only  | 15,000                            | automatic when the Google Ads API is enabled            |
  | Explorer | test and production | 2,880 (production), 15,000 (test) | application in the Cloud Console (automated review)     |
  | Basic    | test and production | 15,000                            | application; brand verification of the project required |
  | Standard | test and production | unlimited                         | application with a manual audit                         |

- **Test access against a production account** fails with
  `AuthorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` (v25+). It is classified as
  configuration (`unknown`): discovery fails visibly (the connection is kept with the
  `discovery_failed` warning and no partial account list), sync runs fail without reauth or an
  account block and are retried with the standard failure backoff (15 min … 6 h,
  [sync.md](../sync.md)). The fix is the project's access level.
- **Multi-user OAuth**
  ([Multi-user authentication](https://developers.google.com/google-ads/api/docs/oauth/multi-user-authentication)):
  the `adwords` scope, offline access (refresh tokens) and Google's OAuth app verification. A
  manager account is only needed to manage several accounts through one login.

## Connection flow and credential

`beginConnect` → `https://accounts.google.com/o/oauth2/v2/auth` with `response_type=code`,
`client_id`, `redirect_uri`, `state`, `code_challenge` + `code_challenge_method=S256` (PKCE),
`access_type=offline`, `prompt=consent`, `include_granted_scopes=false`, `scope=adwords openid` →
`/oauth/callback` → `exchangeCode`:

| Stage            | Call                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `config`         | client id / secret (and the API version) validated before any call                            |
| `token_exchange` | `POST https://oauth2.googleapis.com/token` (form body, PKCE verifier); refresh token required |
| `identity`       | `GET https://openidconnect.googleapis.com/v1/userinfo` → `sub` only                           |
| `api_access`     | `GET .../v25/customers:listAccessibleCustomers` (proves Google Ads API access for the user)   |

- **Credential** (`GoogleCredential` v1, encrypted at rest): refresh token, OAuth client id,
  issue time, granted scopes. `refreshable: true`, no `expiresAt`. A credential of another OAuth
  client is `auth` / `client_id_mismatch`.
- **Refresh ownership (G-D5a).** `OAuthSpec.refresh` exists in the shared contract but the
  connection layer never calls it. The Google client exchanges the stored refresh token for a
  short-lived access token at the start of every provider call (one token request per provider
  call) and keeps it in memory only. `invalid_grant` (revoked, expired, Testing-mode expiry, token
  limit) → `auth` → the connection moves to `needs_reauth`.
- **No PII.** Only the OpenID `sub` is stored (as the connection identity). No email, no profile;
  the dashboard shows "Google Ads" for Google connections.
- **No platform revoke** (G-D6). Disconnect deletes our credential; users revoke access in their
  Google Account ("Third-party apps with account access").

### OAuth-failure diagnostics (D28b, Google)

The `connection.oauth_failed` audit keeps only: `failureKind`, `failureStage` (`token_exchange`,
`identity`, `api_access`, `config`) and `providerCode` from an explicit allowlist:
`invalid_grant`, `invalid_client`, `invalid_request`, `redirect_uri_mismatch`,
`unauthorized_client`, `access_denied`, `no_refresh_token`, `client_id_mismatch`, `NOT_ADS_USER`,
`CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`, the legacy `DEVELOPER_TOKEN_NOT_APPROVED`,
`DEVELOPER_TOKEN_PROHIBITED`, `DEVELOPER_TOKEN_INVALID` (pre-sunset error bodies),
`USER_PERMISSION_DENIED`, `CUSTOMER_NOT_ENABLED`, `google_config_invalid`. Never stored: tokens,
codes, state, secrets, URLs, request/response bodies, messages, request ids, emails, payloads.

## Client (read-only, G-D8)

Plain `fetch`, no SDK. The client builds URLs only from fixed templates and checks every request
against an allowlist **before** any network call:

| Method | URL                                                                                 |
| ------ | ----------------------------------------------------------------------------------- |
| POST   | `https://oauth2.googleapis.com/token`                                               |
| GET    | `https://openidconnect.googleapis.com/v1/userinfo`                                  |
| GET    | `https://googleads.googleapis.com/<version>/customers:listAccessibleCustomers`      |
| POST   | `https://googleads.googleapis.com/<version>/customers/<10 digits>/googleAds:search` |

Anything else (`:mutate`, `:searchStream`, other paths or hosts) is refused. Headers:
`Authorization: Bearer <access token>`, `Accept`, `Content-Type` (search) and `login-customer-id`
(10 digits) when the account is reached through a manager — never `developer-token` (sunset; see
[API access](#api-access)). No token or secret is ever put in a URL; errors carry
only structured codes. Timeouts: 60 s (sync), 15 s (OAuth, discovery). No retries in the client.

## GAQL

`convex/providers/google/gaql.ts` builds every query from typed parts: declared fields per resource
(unknown fields are rejected), typed values (ids are digits, dates `YYYY-MM-DD`, enums
`UPPER_CASE`, booleans, integers — no free-form strings, so no injection), compatibility rules
(`segments.*` and `metrics.*` only on metric resources; `segments.conversion_action` only with
conversion metrics) and a deterministic `ORDER BY` (fields must be selected).

## Customer discovery and routing

- **Discovery** (`listAccounts`): `listAccessibleCustomers` (sorted) → for each accessible customer
  `FROM customer` (itself as `login-customer-id`) → for each manager the flattened
  `FROM customer_client` hierarchy (level ≥ 1, ordered by id).
  - Managers are listed with `isManager: true` (not linkable); hidden clients are skipped.
  - Status: `ENABLED` → active, `CANCELED`/`CLOSED` → closed, `SUSPENDED` → disabled, else unknown.
  - An accessible customer is always listed on its own (direct route, no `parentExternalId`);
    hierarchy clients get `parentExternalId` = the routing manager (the first accessible manager,
    in sorted order, that lists them). Duplicates are listed once.
  - Test accounts carry `attributes.testAccount = "true"`.
  - Pages are filled up to the page size (discovery runs at most 20 pages); a hierarchy beyond
    10,000 accounts fails closed (`unknown` / `google_hierarchy_limit`). An accessible customer that
    cannot be read (for example cancelled) is skipped — it has no currency/time zone to describe.
- **Routing** (`getAccount` and the first page of every request): direct access if the account is
  accessible, else the first accessible customer (sorted) whose `customer_client` lists it as not
  hidden; the route travels in the cursor for later pages. No route → `not_found` (account
  blocked). `getAccount` returns the same record as the listing (for managed accounts it is built
  from the routing manager's `customer_client` row).

## Paging and quota (G-D16)

- Google search pages are a fixed **10,000 rows** ([doc] v19+; `page_size` cannot be set).
- The provider must return **≤ 500 records per page** (the sync's per-page cap), so one Google page
  is served as several provider pages. The cursor holds `{stage, pageToken, offset}` and every
  provider page **re-retrieves the same Google page** and returns `rows[offset … offset + limit]`.
  Queries carry a deterministic `ORDER BY` so offsets stay stable.
- **Cost per provider call:** 1 OAuth token request (not a Google Ads operation) + on the first page
  of a request the routing lookups (`listAccessibleCustomers` + up to one `customer_client` search
  per accessible customer until a match) + 1 search call. Flush pages of the carry make no call at
  all. A request stage whose result has `N` rows costs `Σ ceil(rowsOfGooglePage / limit)` search
  calls — about `ceil(N / 500)` for each 10,000-row Google page. Measured in
  `convex/providers/google/paging.test.ts` (search calls and token mints counted separately).
- The Google Cloud project's daily operation quota (its access level, e.g. 2,880 production
  operations with Explorer) is shared by **all tenants**; measure it on a real account (GR17).
- Page tokens: an expired or invalid token is `invalid_request`; the sync restarts the task once
  from page 1. Token reuse/expiry behavior is not documented → GR16.

## Errors

Classification uses structured `GoogleAdsFailure` error codes, the HTTP/RPC status and the OAuth
`error` field — never message text. With several errors, the most severe wins
(auth > permission > configuration > not found > rate limited > transient > request > data).

| Signal                                                                                                                                                                                                                                                                                   | Kind                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| OAuth `invalid_grant`, `access_denied`; `AuthenticationError.*` (`OAUTH_TOKEN_INVALID`, `NOT_ADS_USER`, …); HTTP 401                                                                                                                                                                     | `auth` → `needs_reauth`                                                            |
| `AuthorizationError.USER_PERMISSION_DENIED`, `CUSTOMER_NOT_ENABLED`, other authorization errors; HTTP 403                                                                                                                                                                                | `permission` → account blocked                                                     |
| `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` (Test-access project); legacy `DEVELOPER_TOKEN_NOT_APPROVED` / `_PROHIBITED` / `_INVALID`, `ORGANIZATION_NOT_ASSOCIATED_WITH_DEVELOPER_TOKEN`; OAuth `invalid_client` / `unauthorized_client` / `redirect_uri_mismatch`; missing/invalid env | `unknown` (configuration; no reauth, no block, never a skipped account)            |
| `CUSTOMER_NOT_FOUND`; HTTP 404                                                                                                                                                                                                                                                           | `not_found`                                                                        |
| `QuotaError.RESOURCE_EXHAUSTED` / `RESOURCE_TEMPORARILY_EXHAUSTED`; HTTP 429                                                                                                                                                                                                             | `rate_limited`; `retryAfterMs` from `google.rpc.RetryInfo` / quota details (≤ 1 h) |
| `InternalError.*`; HTTP 5xx; `UNAVAILABLE`, `DEADLINE_EXCEEDED`; network; timeout                                                                                                                                                                                                        | `transient`                                                                        |
| `RequestError.*` (incl. invalid/expired page tokens), `QueryError.*`; HTTP 400; own-cursor errors                                                                                                                                                                                        | `invalid_request`                                                                  |
| schema drift, account mismatch                                                                                                                                                                                                                                                           | `data`                                                                             |

## Mappings (Stage B)

All semantic choices are named definitions in `convex/providers/google/semantics.ts`, tagged
`[doc]` (Google Ads API v25 reference / canonical model) or `[PROVISIONAL GRn]`. The engine
(`index.ts`) owns plumbing only; `mapping.ts` declares the GAQL stages and `normalize.ts` turns
rows into canonical records. Anything that cannot be represented exactly **fails closed** (a
`data` error for the page) or stays **absent** — it is never guessed.

### Structure

No status filters: removed campaigns, ad groups, asset groups and ads are listed with their
history (G-D14, GR6). Full listings only (`incrementalEntities: false`).

| Canonical                 | Google source (GAQL)                                                                     | Rule                                                                                                                                                                                                          | Class                    |
| ------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| campaign id / name        | `campaign.id`, `campaign.name`                                                           | name required (missing → `data`)                                                                                                                                                                              | documented               |
| campaign `status`         | `campaign.status`                                                                        | ENABLED→active, PAUSED→paused, REMOVED→removed, else unknown; raw kept                                                                                                                                        | documented               |
| campaign `deliveryStatus` | `campaign.serving_status`                                                                | SERVING→delivering, ENDED→ended, PENDING→scheduled, SUSPENDED→not_delivering, NONE/UNKNOWN→unknown; absent → absent                                                                                           | provisional (GR5)        |
| `objective`               | —                                                                                        | always `unknown` (Google has no objective; the channel carries intent)                                                                                                                                        | documented               |
| `channelType`             | `campaign.advertising_channel_type`                                                      | SEARCH, DISPLAY, SHOPPING, VIDEO, PERFORMANCE_MAX, DEMAND_GEN 1:1; MULTI_CHANNEL→app; others (HOTEL, LOCAL, SMART, …, UNKNOWN)→other; raw in `attributes.advertisingChannelType`                              | documented               |
| budget                    | `campaign_budget.period` / `amount_micros` / `total_amount_micros`                       | DAILY→`daily` with `amount_micros`; CUSTOM_PERIOD→`lifetime` with `total_amount_micros` (exact int64 micros); no budget → `none`; any other period → `data` (fail closed); missing amount → absent            | documented               |
| shared budget             | `campaign_budget.explicitly_shared`, `campaign_budget.id`                                | `isSharedBudget`; `budgetMicros` is the SHARED amount; `attributes.campaignBudgetId` relates the sharing campaigns                                                                                            | provisional (GR7)        |
| `budgetLevel`             | —                                                                                        | always `campaign` (Google budgets belong to campaigns)                                                                                                                                                        | documented               |
| `bidStrategy`             | `campaign.bidding_strategy_type`                                                         | raw value; UNKNOWN/UNSPECIFIED → absent                                                                                                                                                                       | documented               |
| `startDate` / `endDate`   | `campaign.start_date_time` / `end_date_time` ("yyyy-MM-dd HH:mm:ss", customer time zone) | the account-local day; absent end = running indefinitely; a far-future end is stored as returned                                                                                                              | documented / GR8         |
| ad group                  | `FROM ad_group`: id, name, status, type, `campaign.id`                                   | kind `ad_group`; raw type in `attributes.adGroupType`                                                                                                                                                         | documented               |
| asset group               | `FROM asset_group`: id, name, status, `campaign.id`                                      | kind `asset_group` (Performance Max); same canonical table as ad groups                                                                                                                                       | provisional (GR10, GR20) |
| ad                        | `FROM ad_group_ad`: `ad_group.id`, `ad_group_ad.ad.id`, status, `ad.type`, `ad.name`     | id `"{adGroupId}~{adId}"`; name = `ad.name` (set only for some ad types [doc]) else `Ad {adId}`; raw type in `attributes.adType`                                                                              | documented               |
| ad `format`               | `ad_group_ad.ad.type`                                                                    | RSA→responsive_search, RDA→responsive_display, TEXT_AD/EXPANDED_TEXT_AD→text, IMAGE_AD→image, VIDEO_*/IN_FEED_VIDEO_AD→video, DEMAND_GEN_CAROUSEL_AD→carousel, EXPANDED_DYNAMIC_SEARCH_AD→dynamic, else other | provisional (GR9)        |
| creative                  | same `ad_group_ad` row                                                                   | one creative per ad, **same external id** (no duplicates); RSA/RDA `headlines`/`descriptions` (texts), `final_urls[0]`→`linkUrl`, RDA `call_to_action_text`→`callToAction`                                    | documented               |

Not mapped (no canonical field or out of scope): ad-group/ad delivery status (`primary_status`),
campaign sub-type, RDA long headline and images, Performance Max assets and listing groups.

### Daily metrics (`fetchDailyMetrics`)

| Level    | Stages (`segments.date BETWEEN from AND to`, ORDER BY ids, date[, network])                             |
| -------- | ------------------------------------------------------------------------------------------------------- |
| account  | `FROM customer`; placement: + `segments.ad_network_type`                                                |
| campaign | `FROM campaign`; placement: + network                                                                   |
| ad_group | `FROM ad_group`, `FROM asset_group`; placement: + `FROM ad_group` with network (**never asset groups**) |
| ad       | `FROM ad_group_ad`; placement: + network                                                                |

| Canonical               | Google metric (`metrics.*`)                                                                                | Class            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| `spendMicros`           | `cost_micros` (int64 micros, account currency) — exact bigint                                              | documented       |
| `impressions`, `clicks` | `impressions`, `clicks` (int64; beyond 2^53 → `data`)                                                      | documented       |
| `conversions`           | `conversions` — Google's Conversions column: primary actions (`primary_for_goal`) plus custom-goal actions | documented       |
| `conversionValueMicros` | `conversions_value` (double, account currency) → rounded to micros                                         | documented       |
| `allConversions`        | `all_conversions` — every action, primary or secondary                                                     | documented       |
| `reach`, `linkClicks`   | never reported (no equivalent in this mapping)                                                             | —                |
| video / engagement      | never reported                                                                                             | deferred (G-D21) |

- **Missing vs zero (G-D13).** Metrics are proto3 `optional`: a returned `0` stays `0`, an absent
  metric stays **absent**, and a missing row means no delivery. Whether Google omits selected zero
  metrics or zero-delivery rows is GR12.
- **Currency:** `customer.currency_code` on every row (checked against the account by the sync).
- **Reconciliation** of the stored columns with the Google Ads UI columns is GR13.

### Placements (`segments.ad_network_type`)

| Google value (v25)                                      | Placement         | Class                                        |
| ------------------------------------------------------- | ----------------- | -------------------------------------------- |
| SEARCH ("Google search")                                | `google_search`   | documented                                   |
| SEARCH_PARTNERS ("Search partners")                     | `search_partners` | documented                                   |
| CONTENT ("Display Network")                             | `google_display`  | documented                                   |
| YOUTUBE                                                 | `youtube`         | documented                                   |
| GMAIL                                                   | `gmail`           | documented                                   |
| DISCOVER ("Discover Feed")                              | `discover`        | documented                                   |
| MIXED ("Cross-network")                                 | `cross_network`   | documented (Google's own value)              |
| GOOGLE_TV, GOOGLE_OWNED_CHANNELS, MAPS, UNKNOWN, (none) | `other`, raw kept | documented; accumulated across pages (carry) |

- Only values Google returns are mapped. **No placement is ever synthesized** (G-D12): an
  asset group's "all" row is never copied into a `cross_network` (or any) placement row.
- **Asset groups are queried without the network segment**, so they have "all" rows only.
  Consequence: ad-group-level placement breakdowns exclude Performance Max asset groups (the gap
  is visible: placement totals < "all" totals); campaign- and account-level placement rows come
  from Google's own segmentation of the campaign. Whether asset groups support network
  segmentation is GR10.
- Whether network rows add up to the "all" row, and how often unmapped values occur, is GR11.

### Conversion actions (`fetchActionMetrics`)

| Canonical                    | Google source                                                                                                                                                                                                                                                                   | Class                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| row                          | one per `segments.conversion_action` (with `segments.date`); conversion metrics only [doc]                                                                                                                                                                                      | documented                                  |
| `rawActionType`              | `segments.conversion_action` = the action's **resource name** `customers/{customer_id}/conversionActions/{id}` (`resource_name` is "Immutable" [doc])                                                                                                                           | documented                                  |
| `conversionActionExternalId` | the id part of that resource name (`conversion_action.id`)                                                                                                                                                                                                                      | documented                                  |
| display name                 | `segments.conversion_action_name` is mutable and **not stored** (no canonical field on action rows)                                                                                                                                                                             | —                                           |
| `count`                      | `metrics.all_conversions` of the action (required; missing → `data`)                                                                                                                                                                                                            | documented metric / provisional use (GR15)  |
| `valueMicros`                | `metrics.all_conversions_value` (absent stays absent)                                                                                                                                                                                                                           | documented metric / provisional use (GR15)  |
| `actionType`                 | `segments.conversion_action_category`: PURCHASE, ADD_TO_CART, BEGIN_CHECKOUT→initiate_checkout, SIGNUP→complete_registration, SUBSCRIBE_PAID→subscribe, PAGE_VIEW, CONTACT; lead family (SUBMIT_LEAD_FORM, IMPORTED/QUALIFIED/CONVERTED_LEAD, PHONE_CALL_LEAD)→lead; else other | documented / lead family provisional (GR15) |
| `isPrimary`                  | `conversion_action.primary_for_goal` (the lookup); absent when not reported — no default assumed                                                                                                                                                                                | documented / provisional (GR15)             |
| `attributionWindow`          | the constant bucket **`action_setting`** (see below) — never a day count                                                                                                                                                                                                        | canonical bucket (GR15)                     |
| `attributionBasis`           | `impression_or_click_date` (conversions are dated on the interaction [doc])                                                                                                                                                                                                     | documented                                  |

**Identity (natural key).** `actionMetricsDaily` rows are keyed by (entity, placement, date,
`rawActionType`, `attributionWindow`). For Google, `rawActionType` is the conversion action's
immutable resource name, so:

- a renamed action stays the same logical action (its rows are replaced, never duplicated);
- two actions with the same display name but different ids never collide;
- a removed action keeps its identity and history (the lookup has no status filter);
- actions owned by another customer (for example a manager) keep their own resource name.

The schema comment in `convex/tables/metrics.ts` describes Google's `rawActionType` as the
"conversion action name": the value stored is the action's API resource name (its stable name),
not the mutable display name. The display name has no field on action rows; showing it would need
a future model decision. Analytics and the dashboard therefore label Google action groups by
resource name (plus `actionType`).

**isPrimary.** Canonical meaning (Phase 2): "counts toward the account's primary `conversions`",
with Google's `primary_for_goal` named as the source. Google's conversion-goals guide (v25):

- `primary_for_goal = true` → the action's conversions are included in **Conversions** and
  **All conversions** (and in bidding per the biddable customer/campaign goals);
- `primary_for_goal = false` → not included in bidding or **Conversions** unless the action is used
  in a custom conversion goal; it still appears in **All conv.**;
- `include_in_conversions_metric` is **deprecated** ("set primary_for_goal instead"); it is not
  read (`metrics.proto` still words `conversions` in terms of it).

The flag is the action's **current** setting at sync time (Google reports no per-row flag): days
re-synced after a change follow it, older stored days keep the value of their last sync (GR15).

**Relationship of the columns** (documented; never enforced, never forced):

| Column                           | Contains                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| wide `conversions` / value       | Google's Conversions: primary actions, plus a campaign's custom-goal actions whatever their flag |
| wide `allConversions`            | every action, primary or secondary                                                               |
| action rows (`count`)            | `all_conversions` per action — expected to add up to `allConversions` (GR13)                     |
| Σ `isPrimary = true` action rows | **not** the wide `conversions` (custom goals); never used to derive or replace it                |

**attributionWindow = `action_setting`.** Google reports no attribution window per row (no segment
carries one), and `click_through_lookback_window_days` / `view_through_lookback_window_days` are
the action's **current** settings. The canonical field is required, so every Google action row
carries the constant bucket `action_setting`, meaning "counted under the conversion action's own
lookback setting in effect when Google attributed the conversion". No day count is claimed and the
lookback fields are not read. A constant keeps the natural key stable when a setting changes.
Deferred: splitting rows by `segments.conversion_attribution_event_type` (impression /
interaction / engaged view), which Google does report.

- **Lookup.** The first page of every action request reads `FROM conversion_action` (`id`,
  `primary_for_goal`; no status filter) across **all** its Google pages and carries id → flag in
  the cursor; more than 10,000 conversion actions fail closed (`data` / `lookup_limit`).
- **Performance Max:** at the ad-group level the asset-group stage requests
  `segments.conversion_action` too (GR10); if Google refused it, the task would fail visibly
  rather than miss conversions silently.
- Conversion-date rows (`*_by_conversion_date`) are deferred (they would collide on the natural key).

### Capabilities (Stage B)

| Field               | Value                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| entities            | campaigns, ad groups, ads, creatives                                                                |
| adGroupKinds        | `ad_group`, `asset_group`                                                                           |
| incrementalEntities | `false`                                                                                             |
| metricLevels        | account, campaign, ad_group, ad                                                                     |
| placementBreakdown  | `true`                                                                                              |
| placements          | all, google_search, search_partners, google_display, youtube, gmail, discover, cross_network, other |
| reportedMetrics     | spendMicros, impressions, clicks, conversions, conversionValueMicros, allConversions                |
| actionMetrics       | `true` (planned by the sync without a breakdown)                                                    |
| attributionWindows  | `action_setting` (a canonical bucket, see Conversion actions)                                       |
| maxMetricsRangeDays | 31                                                                                                  |
| page sizes          | 500 / 500                                                                                           |
| restatementLookback | 30 days (conversion restatement beyond 30 days is a known limitation, G-D20)                        |

Nothing is declared that the mapping does not emit; the sync plans tasks from these values only.

### Canonical mapping limitations

- Ad-group-level placement analytics exclude Performance Max asset groups (see Placements).
- Shared budgets: `budgetMicros` is the shared amount on each sharing campaign; summing budgets
  across campaigns would double count (the dashboard shows budgets per campaign only).
- Ad and asset group ids live in one canonical table per account (GR20).
- The ad level excludes Performance Max delivery (asset groups have no ads).
- No reach, link clicks, video or engagement metrics; no conversion-date rows.
- Conversion actions are identified by resource name; their display names are not stored (no
  field on action rows), so Google action groups are labeled by resource name and action type.
- `isPrimary` is the action's current `primary_for_goal`; the window is the `action_setting`
  bucket, not a factual per-row window.

## Documented vs provisional vs deferred

**DOCUMENTED** (implemented from the v25 reference, no account evidence needed): endpoints,
headers, OAuth, `listAccessibleCustomers`, `customer` / `customer_client` fields, GAQL grammar and
the `segments.conversion_action` compatibility rule, page tokens and the fixed 10,000-row page,
money as int64 micros / doubles in account currency, `segments.date` as the account-local day,
the status / channel / budget-period / ad-network / conversion-category enums, the
`conversions` / `all_conversions` definitions, `start_date_time` / `end_date_time` format and
"clear to run indefinitely", the `GoogleAdsFailure` error model and `RetryInfo`.

**PROVISIONAL** (implemented; real-account validation required): see the table below.

**DEFERRED** (not implemented): video views and engagement metrics (G-D21), reach,
conversion-date-basis rows, restatement beyond the 30-day lookback (G-D20), incremental listing
via `change_status`, Performance Max assets and listing groups, keywords, search terms, audiences,
geo/device, platform revoke (G-D6), `searchStream`, any synthetic Performance Max placement
(G-D12), a cross-tenant quota scheduler, email display (G-D4).

## Real-account validation required

No real Google Ads account or Google Cloud project access level has been used. **Nothing below is
verified.** The
fake Google Ads API models documented behavior only.

| Id   | Item                                                                                                                                             | Status      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| GR3  | Which manager `login-customer-id` accepts in deep or shared hierarchies                                                                          | pending     |
| GR5  | `serving_status` → canonical delivery status                                                                                                     | pending     |
| GR6  | Removed resources and their metrics returned without status filters                                                                              | pending     |
| GR7  | Daily vs custom-period budgets; shared-budget representation                                                                                     | pending     |
| GR8  | Whether indefinite campaigns ever return a far-future `end_date_time`                                                                            | pending     |
| GR9  | Ad type → canonical format                                                                                                                       | pending     |
| GR10 | Asset-group metrics by date; network and conversion-action segmentation on asset groups                                                          | pending     |
| GR11 | Frequency of unmapped networks; network rows add up to "all"                                                                                     | pending     |
| GR12 | Missing vs zero: JSON presence of selected zero metrics; zero-delivery rows omitted or not                                                       | pending     |
| GR13 | Stored columns vs UI columns (Cost, Conversions, Conv. value, All conv.)                                                                         | pending     |
| GR15 | Action rows: `all_conversions` per action; `primary_for_goal` as `isPrimary` (current setting); the `action_setting` bucket; custom-goal effects | pending     |
| GR16 | Page size in practice, page-token reuse and expiry, ORDER BY determinism for slicing                                                             | **pending** |
| GR17 | Operation accounting per page, real `RetryInfo` delays, daily-quota reset                                                                        | **pending** |
| GR20 | Ad-group vs asset-group id spaces within one account                                                                                             | pending     |
| GR21 | Which error enums occur in which real situation                                                                                                  | pending     |
| GR22 | Cloud-project access: which calls return `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` (search vs `listAccessibleCustomers`); no developer token   | pending     |

Validation path: a Test-access Cloud project with test accounts under a test manager (OAuth,
discovery, routing, structure: GR3, GR5–GR9, GR21, GR22), then an Explorer- or Basic-access project
on an account with delivery (GR10–GR13, GR15–GR17, GR20). Findings are reported, never invented.

## Quota measurement (fake dataset)

The e2e test (`convex/sync/google.e2e.test.ts`) records Google calls of one initial sync of
222-000-0001 (21 tasks: 2 month windows): **21** routing searches (`customer_client`, first page
of each task) + **21** `listAccessibleCustomers`, **8** conversion-action lookups (one per action
task), **33** data searches (5 structure, 18 daily-metric, 10 action), **36** provider pages of
which **2** carry-flush pages make no call, and **34** OAuth token requests (one per non-flush
provider page; not Ads operations). Slicing cost for large results is measured in
`paging.test.ts`: a 2,000-row ad-level window with network rows (6,000 records) takes 4 + 8 = 12
searches. Real operation accounting is GR17.

## Testing

No Google credentials in CI. `convex/providers/google/fakeGoogleAds.fixtures.ts` serves a fake
Google Ads API behind the stubbed global `fetch`: token endpoint (PKCE, refresh, `invalid_grant`,
missing refresh token), userinfo, `listAccessibleCustomers`, a GAQL-subset evaluator
(customer, customer_client, campaign + campaign_budget, ad_group, asset_group, ad_group_ad,
conversion_action; `segments.date`, `segments.ad_network_type`, `segments.conversion_action*`;
the documented `conversions` / `all_conversions` definitions), configurable page size, page
tokens that can expire, the Cloud-project access level (a Test project gets
`CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` on production accounts; every request is logged with
`developerTokenHeader`, which tests assert is never sent), `login-customer-id` enforcement, injected
5xx/quota/query errors, proto3-JSON shapes (camelCase, int64 as strings, unset fields omitted) and
**operation counters**. It contains synthetic data only and is not evidence of real account
behavior. Its modeling assumptions are explicit: asset groups refuse the network segment (GR10;
the provider never asks), an aggregated metric is present only if every contributing fact
reported it, and tests can omit metrics from a row (GR12).
`tests/lint/google-fixture-scrub.test.ts` rejects token-, secret- and credential-shaped strings.

Suites (`convex/providers/google/`): `client`, `errors`, `gaql`, `cursor` (incl. the lookup),
`carry`, `route`, `oauth`, `mapping` (every mapping decision on synthetic rows), `provider`
(config/credential, discovery, routing, structure, metrics, actions, capabilities), `paging`
(slicing cost, cursors, carry, lookup, the 2,000-row measurement), `pending` (the fail-closed
mapping seam), `contract` (the shared AdsProvider + OAuthSpec contracts with the production
mapping), `registry` (D8 matrix); `convex/connections/googleFlow.test.ts` and
`googleDiagnostics.test.ts` (connect flow, D28b, isolation); `convex/sync/google.e2e.test.ts`
(fake API → provider → sync → canonical tables → v1 analytics: idempotency, page boundaries,
pruning, removal, partial failure and coverage, quota throttling, expired page tokens, transient
retries, capability-driven planning, the quota table, tenant isolation, secret scan);
`tests/lint/google-guards.test.ts` (analytics ban, purity, no logging, read-only source scan,
allowlisted hosts).

## Runbooks

- **Version bump:** Google releases several versions per year and sunsets each about a year after
  release. Set `GOOGLE_ADS_API_VERSION=vNN` on a dev deployment, run a sync, compare, then bump the
  constant and remove the override. In-flight cursors of the old version restart their task once.
- **Reconnect:** `invalid_grant` moves a connection to `needs_reauth`; the user reconnects through
  `beginConnect`. Reconnecting the same Google user updates the credential in place.
- **Monitoring:** `needs_reauth`, `rate_limited` spikes and `throttledUntil` (quota),
  `google_config_invalid` / `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` (raise the project's
  access level), `not_found` / `permission` blocks (routing), and
  the D28b codes on `connection.oauth_failed`.
