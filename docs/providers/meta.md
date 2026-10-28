# Meta Ads provider (Phase 8)

The real Meta Marketing API behind the existing `AdsProvider` and `OAuthSpec` contracts
([architecture.md](architecture.md)). Decisions: [ADR 0009](../adr/0009-meta-ads-provider.md).

> **Status: Stage B — implemented with PROVISIONAL semantics.** Connecting, discovery, structure,
> daily insights (with the placement breakdown), conversions and action metrics are implemented
> end to end and flow through the Phase 5 sync into the Phase 6 analytics and the Phase 7
> dashboard. The G1 real-account spike could not be run (no real Meta ad account was available),
> so **every Meta-specific semantic assumption is provisional and unverified**. It is implemented
> from the Marketing API reference and our canonical model, isolated in
> `convex/providers/meta/semantics.ts`, pinned by tests, and listed under
> [Real-account validation required](#real-account-validation-required). No recording in this
> repository comes from a real account.

## Stages

| Stage       | Status                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0          | Answered (D3, D4, D8, D8-A, D9, D28b).                                                                                                                                                      |
| Stage A     | Done: provider mode, unavailable stub, Graph client, error classifier, cursor codec, OAuth spec (`ads_read` only), D28b, D34, fake Graph, contract wiring.                                  |
| G1          | **Not run** (no real ad account). Replaced by provisional mappings plus the validation checklist below; `scripts/meta-g1-spike.mjs` records the evidence when an account is available.      |
| **Stage B** | Done with provisional semantics (this document).                                                                                                                                            |
| Validation  | A mentor/operator connects a real Meta ad account on a cloud dev deployment (`PROVIDER_MODE=live`) and works through [Real-account validation required](#real-account-validation-required). |

If real-account evidence contradicts an assumption, only `semantics.ts` / `normalize.ts` /
`mapping.ts` change (and their tests); the schema, v1, sync, analytics and dashboard stay as they
are. Anything that cannot be represented by the canonical model (for example an attribution basis
that fits neither canonical value) is reported for a decision, not absorbed.

## Provider mode (D8)

`PROVIDER_MODE` selects the providers. It **fails closed**: there is never a silent fallback to
live or to mock.

| `PROVIDER_MODE`                                  | Deployment                                                    | Result                               |
| ------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------ |
| unset                                            | local backend (`CONVEX_CLOUD_URL` absent, or a loopback host) | mock                                 |
| `mock`                                           | any                                                           | mock                                 |
| `live`                                           | any                                                           | live                                 |
| unset                                            | cloud (dev or prod)                                           | config error `provider_mode_missing` |
| any other value (case-sensitive, including `""`) | any                                                           | config error `provider_mode_invalid` |

- **mock:** the deterministic mock providers for both platforms (unchanged).
- **live:** the Meta provider and Meta OAuth spec (a connection is refused before any OAuth state
  exists while the Meta app settings are missing or invalid; see [Connection flow](#connection-flow)).
  Google Ads uses its live provider when `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is set and
  otherwise the generic **unavailable stub** (D8-A): every call throws `auth` /
  `provider_unavailable`, so leftover mock Google connections move to `needs_reauth` and no
  synthetic data is written; no Google OAuth spec ([google-ads.md](google-ads.md)).
- **config error:** unavailable stubs for both platforms (declaring the live capabilities, so stored
  data stays readable). Every call throws `unknown` with the mode code; no OAuth specs, so
  `beginConnect` is refused; no Graph calls, no mock data, no reauth, no account block. Fixing the
  env takes effect on the next call. Registry construction never throws.

Code: `convex/providers/mode.ts`, `convex/providers/index.ts`, `convex/providers/unavailable.ts`.

## Setup runbook (operator)

Ownership is **operator configuration**: the developer app is owned by the project's Meta Business
portfolio. Its name and id are recorded in the deployment setup, **never in this repository**.

1. In the owning Business portfolio, create a **Business**-type app with **Marketing API** and
   **Facebook Login for Business**.
2. Create an FLfB **configuration**: user access token, ad-account assets, permission `ads_read`
   only. Its id is `META_LOGIN_CONFIG_ID`.
3. Facebook Login settings: strict mode, **exact** redirect URI
   `https://<deployment>.convex.site/oauth/callback`; enable **Require App Secret**. Local
   deployment (app in development mode only): Meta refuses `http://127.0.0.1:3211/oauth/callback`,
   so set `META_OAUTH_REDIRECT_ORIGIN=http://localhost:3211` on it; Meta then uses
   `http://localhost:3211/oauth/callback`, which it allows automatically in development mode and
   which is **not** added to Valid OAuth Redirect URIs. That is the only value the setting
   accepts (any `https` origin is refused); cloud deployments leave it unset. Publishing the app
   requires an HTTPS redirect URI, a cloud deployment's
   `https://<deployment>.convex.site/oauth/callback`; see
   [connections.md](../connections.md#configuration).
4. App settings: privacy-policy URL and data-deletion **instructions** URL (no callback until
   Phase 11; see [Data deletion](#data-deletion)).
5. App roles: add the engineers who run the G1 spike and dev syncs.
6. Set the Convex env of the (dev) deployment — never in files:

   ```bash
   npx convex env set PROVIDER_MODE live
   npx convex env set META_APP_ID <numeric app id>
   npx convex env set META_APP_SECRET <app secret>
   npx convex env set META_LOGIN_CONFIG_ID <configuration id>
   ```

   Optional: `META_GRAPH_API_VERSION` (validated `vNN.0`; default `v26.0`), and on a **local**
   deployment only `META_OAUTH_REDIRECT_ORIGIN=http://localhost:3211` (step 3). The existing
   `TOKEN_ENCRYPTION_KEYS` is required as for every connection.

7. **Every cloud deployment must set `PROVIDER_MODE`** (`mock` or `live`) before its first deploy,
   or all provider calls fail with `provider_mode_missing`.

Production additionally needs Business Verification and Access Verification by the owning
portfolio, Advanced Access to `ads_read` and `public_profile`, and Marketing API access tier Full.
Safety for development: `ads_read` only, GET-only ads client, a dedicated dev deployment, never a
client's production accounts.

## Connection flow

`beginConnect` → FLfB dialog (`https://www.facebook.com/<version>/dialog/oauth` with `client_id`,
`redirect_uri`, `state`, `response_type=code`, `config_id`, `auth_type=rerequest`; no `scope`
parameter, no PKCE) → `/oauth/callback` → `exchangeCode`:

| Stage                 | Call                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `code_exchange`       | `POST oauth/access_token` (form body: code, client id/secret, redirect URI)                             |
| `long_lived_exchange` | `POST oauth/access_token` (`grant_type=fb_exchange_token`, form body)                                   |
| `debug_token`         | `GET debug_token` with the app token in the header: validity, app id, scopes, granular scopes, expiries |
| `identity`            | `GET me` (user token in the header, `appsecret_proof`); must match `debug_token.user_id`                |
| `config`              | invalid version / app id / secret / configuration id (before any call)                                  |

- Configuration check first: `beginConnect` asks the spec `isConfigured` before it creates any
  OAuth state. While `META_APP_ID`, `META_APP_SECRET` or `META_LOGIN_CONFIG_ID` is missing or
  invalid, or `META_GRAPH_API_VERSION` is set but invalid, the connection is refused with
  `INVALID_ARGUMENT` (`field: "provider"`), exactly like an unconfigured Google Ads: no OAuth state,
  connection or credential is written and Graph is not called. The `config` stage above remains for
  settings that change between `beginConnect` and the callback.
- Scopes: `requestedScopes = requiredScopes = ["ads_read"]` (D9). A grant without `ads_read`
  connects with a `missingScopes` warning.
- Credential (`MetaCredential` v1, encrypted at rest): long-lived user token, app id, `expiresAt` =
  the earliest finite of token expiry and data-access expiry (0 = never), granted ad-account ids.
  `refreshable: false`: about every **60 days** the user reconnects (`expiresSoon`, then
  `needs_reauth`). No platform revoke on disconnect (D7).
- Discovery: `GET me/adaccounts` (`id, account_id, name, currency, timezone_name, account_status,
disable_reason, business{id}`), 15 s timeout. Filtering by granular grants is a G1 item (V3).
- Known exception pending V2 (G2): `debug_token` takes the user token as the `input_token` query
  parameter. It is the only place a user token is in a URL; the client never logs URLs.

### OAuth-failure diagnostics (D28b)

A failed exchange still ends with the callback outcome `exchange_failed`. The existing
`connection.oauth_failed` audit entry additionally carries **only** these allowlisted values
(`convex/connections/oauthDiagnostics.ts`); anything else is dropped, never stored:

| Audit key      | Allowed values                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reason`       | existing callback code (unchanged)                                                                                                                              |
| `failureKind`  | a `ProviderError` kind                                                                                                                                          |
| `failureStage` | `code_exchange`, `long_lived_exchange`, `debug_token`, `identity`, `config`                                                                                     |
| `providerCode` | Meta numeric code with optional subcode (`^\d{1,6}(/\d{1,9})?$`), or `app_id_mismatch`, `meta_config_invalid`, `provider_mode_missing`, `provider_mode_invalid` |

Never stored: tokens, authorization codes, OAuth state, the app secret, URLs, request or response
bodies, error messages (`message`, `error_user_msg`, `error_user_title`), `fbtrace_id`, provider
payloads. Org admins see the entries through `v1/audit:list` (contract unchanged).

## Graph client (D1, D2, D6)

- Version: `v26.0` constant (`convex/providers/meta/config.ts`) with the validated
  `META_GRAPH_API_VERSION` override. `providerId = "meta-marketing-api/<version>"` is **run metadata
  only** (`syncRuns.providerId`); connections, sync accounts and natural keys key on
  `platform = meta` and external ids, so a version bump never changes identity.
- Plain `fetch`, no SDK. Ads reads are GET-only; the token travels in the `Authorization` header;
  every call carries `appsecret_proof` (HMAC-SHA256 of the token with the app secret). OAuth
  secrets go in form bodies. `paging.next` is never followed; no retries inside the client.
- Timeouts: 60 s for sync calls, 15 s for OAuth and discovery.
- Cursors (D15): `m1.<base64url>` wrapping Meta's `after` value and a fingerprint of the operation,
  **API version**, account, request window and request plan. A cursor from another request or
  another version is `invalid_request` (`cursor_invalid`), so the sync engine restarts the task
  once instead of mixing versions. Insights cursors also carry the stage, the carry, a flush
  marker and, after a page had to be re-requested with fewer rows, that row count (`l`; see
  [Page fit](#action-metrics-fetchactionmetrics)).

## Errors (D22, D23, D24)

Classification uses Graph codes, HTTP status and usage headers only — never message text
(`convex/providers/meta/errors.ts`). `providerCode` is `<code>` or `<code>/<subcode>`.

| Signal                                                           | Kind                                                                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| network, timeout, 5xx, codes 1, 2, `is_transient`                | `transient` (retried)                                                                                                         |
| `100/1487534` "too much data"                                    | `transient` (retried; from the 3rd attempt of a page the page size halves per attempt, floor 50: D23)                         |
| 4, 17, 32, 341, 368, 613, 80000–80014, HTTP 429                  | `rate_limited`; `retryAfterMs` = max of BUC regain time, `X-Ad-Account-Usage` reset, `Retry-After`, capped at 1 h             |
| 190 (any subcode), 102, HTTP 401, foreign app id                 | `auth` → `needs_reauth`                                                                                                       |
| 3, 10, 200–299, HTTP 403                                         | permission probe (`GET me/permissions`): `auth` if `ads_read` is gone, else `permission`                                      |
| `100/33`, 803, HTTP 404                                          | `not_found` (account blocked)                                                                                                 |
| 100 (other), 2500, 2635, 3018; own-cursor errors                 | `invalid_request` (one restart if a cursor exists)                                                                            |
| schema drift, account mismatch, `insights_row_too_large`         | `data`                                                                                                                        |
| missing/invalid `META_*` env; `PROVIDER_MODE` missing or invalid | `unknown` with `meta_config_invalid` / `provider_mode_missing` / `provider_mode_invalid`; fails the task, no reauth, no block |
| an operation without a mapping entry (defensive; none today)     | `unknown` with `meta_mapping_pending_g1`                                                                                      |
| anything else                                                    | `unknown`                                                                                                                     |

Messages are generic (`Meta request failed (<kind>)`) and never contain tokens, URLs or bodies.

### Public reasons

Sync errors (`v1/adAccounts:list`, `sync.lastError`) and discovery errors on a connection
(`v1/connections:get`, `lastError`) keep the error kind and a fixed generic message. A known
condition also gets an allowlisted `reason` (`convex/sync/publicStatus.ts`); the Graph code itself is
never stored on the connection or returned. Because one Graph code can be classified differently
(a permission code becomes `auth` when the `ads_read` probe finds the grant gone), Meta reasons come
from the code **and** the classified kind; Google Ads codes never explain a Meta error:

| Condition                                                            | `reason`                      |
| -------------------------------------------------------------------- | ----------------------------- |
| kind `auth` (190, 102, HTTP 401, `ads_read` gone, foreign app id)    | `reauth_required`             |
| kind `permission` (3, 10, 200–299, HTTP 403 with `ads_read` granted) | `permission_denied`           |
| kind `rate_limited` (4, 17, 32, 341, 368, 613, 80000–80014, 429)     | `rate_limited`                |
| `100/33` (account does not exist or cannot be loaded)                | `account_not_accessible`      |
| 803 (unknown alias)                                                  | `account_not_found`           |
| `meta_config_invalid`                                                | `provider_config_invalid`     |
| `provider_mode_missing` / `provider_mode_invalid`                    | `provider_mode_misconfigured` |
| `provider_unavailable`                                               | `provider_unavailable`        |
| anything else (transient, data, invalid request, unknown codes)      | none: kind + message only     |

A disabled ad account is not an error: its `account_status` is reported as the account status
(discovery and the ad account). The code-to-reason mapping is provisional (R2, R20). The dashboard
explains these reasons in Meta words (`META_ERROR_REASON_MESSAGES` in `lib/connections/messages.ts`).

### Dashboard connection flow

The dashboard's `/connections` page has a **Meta Ads** section
([dashboard.md](../dashboard.md#connections-google-ads-meta-ads-and-youtube), ADR 0008 amendment):
**Connect Meta Ads** → Facebook Login for Business → `/oauth/callback` → discovery → choose one ad
account → **Link selected account** → the first sync starts automatically → the linked account's
sync status and **View analytics**. Reconnect only accepts the Facebook account that created the
connection; **Disconnect Meta Ads** lets an admin start over with another one. While the Meta app
settings are missing, the section explains that Meta Ads is not available (no OAuth state is
created). Tested with mocks and the fake Graph only: no real Meta account has been connected
from the dashboard.

## Account mapping (D10)

`account_status`: 1, 9 → `active`; 2, 3, 100 → `disabled`; 7, 8 → `pending`; 101 → `closed`; else
`unknown` (raw value kept in `rawStatus`). `isManager: false`; `parentExternalId = business.id` from
Meta data; a non-zero `disable_reason` is kept in `attributes`. A payload whose `id` and
`account_id` disagree is a `data` error.

## Mapping (Stage B, provisional)

All Meta semantics live in `convex/providers/meta/semantics.ts` (named definitions, tagged
`[doc]` or `[PROVISIONAL Rn]`), `normalize.ts` (pure raw → record functions) and `mapping.ts`
(Graph requests). The engine (`index.ts`) owns plumbing only. Missing data is never turned into
0: an absent field, an absent action type or a currency we cannot convert stays **absent**.

### Structure

| Canonical              | Meta source                                                                                                                                                                               | Notes                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| listings               | `act_<id>/campaigns`, `/adsets`, `/ads` with `effective_status=[complete enum]`; `/adcreatives`                                                                                           | DELETED and ARCHIVED objects included (R6); full listings only (`incrementalEntities: false`) |
| account facts          | `act_<id>?fields=currency,timezone_name` before each campaign/ad set page                                                                                                                 | budgets are in account currency; dates are account-local                                      |
| `status` / `rawStatus` | `status`: ACTIVE→active, PAUSED→paused, ARCHIVED→archived, DELETED→removed, else unknown                                                                                                  | [doc]                                                                                         |
| `deliveryStatus`       | `effective_status` (R5): ACTIVE→delivering; paused/review/billing/in-process→not_delivering; WITH_ISSUES→limited; ARCHIVED/DELETED→ended; else unknown                                    | raw value in `attributes.effectiveStatus`                                                     |
| `objective`            | `OUTCOME_*` and legacy objectives (R4); absent→unknown; unlisted→other                                                                                                                    | raw in `rawObjective`; `channelType: social`                                                  |
| budgets                | `daily_budget` / `lifetime_budget` in currency offset units (R10)                                                                                                                         | campaign budget ⇒ `budgetLevel: campaign` (CBO), else `ad_group` (ABO); "0" = no budget       |
| dates                  | `start_time`/`stop_time`/`end_time` instants → account-local day (R3)                                                                                                                     | `platformCreatedAt/UpdatedAt` from `created_time`/`updated_time`                              |
| ad set                 | `optimization_goal`; `attribution_spec` → label like `7d_click_1d_view`                                                                                                                   | `kind: ad_set`                                                                                |
| ad                     | `creative{id,object_type}` → `creativeExternalId`, `format`                                                                                                                               | an ad without a creative has neither                                                          |
| creative               | `object_type` (R8: PHOTO→image, VIDEO→video, STATUS→text, else other), title, body, CTA, link, thumbnail/image URL, video id, `effective_instagram_media_id`, `effective_object_story_id` | raw type in `attributes.objectType` (R7, R8)                                                  |

**Budget currencies (R10).** Converted only when the unit is unambiguous: 2-minor-digit ISO
currencies ×10 000 micros per unit (cents), 0-minor-digit currencies (JPY, KRW, VND, …)
×1 000 000. For COP, CRC, HUF, IDR, TWD (Meta is understood to use offset 1 there) and 3-digit
currencies, `budgetMicros` stays absent and the raw integer is kept in
`attributes.rawDailyBudget` / `rawLifetimeBudget`.

### Daily insights (`fetchDailyMetrics`)

One `MetricsRequest` is answered in **stages**, and the cursor records the stage:

1. **Stage 0 ("all")**: `act_<id>/insights?level=…&time_increment=1&time_range=…` with
   `use_unified_attribution_setting=true` and `action_report_time=impression`; `reach` is requested
   here only.
2. **Stage 1 (placement breakdown only)**: the same request with `breakdowns=publisher_platform` and
   without `reach`.

Campaign/ad set/ad levels add `filtering=[{"field":"<level>.effective_status","operator":"IN",
"value":[complete enum]}]` so the delivery of archived and deleted objects is included (R6).

| Canonical column                                                                   | Meta source (per row)                                                                                                           | Absent when                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `date`                                                                             | `date_start` (= `date_stop`; account-local day [doc]; otherwise a `data` error)                                                 | —                           |
| `currency`                                                                         | `account_currency` (the sync rejects rows whose currency differs from the account)                                              | —                           |
| `placement` / `rawPlacement`                                                       | stage 0: `all`; stage 1: `publisher_platform` facebook/instagram/audience_network/messenger/threads, else `other` (R9)          | —                           |
| `spendMicros`                                                                      | `spend` (decimal, account currency)                                                                                             | field absent                |
| `impressions`, `clicks`                                                            | `impressions`, `clicks`                                                                                                         | field absent                |
| `reach`                                                                            | `reach`, **stage 0 only**, windows starting within 380 days (R12)                                                               | breakdown rows, old windows |
| `linkClicks`                                                                       | `inline_link_clicks`                                                                                                            | field absent (R11)          |
| `videoPlays`, `videoCompletions`                                                   | sum of `video_play_actions`, `video_p100_watched_actions` (R13)                                                                 | list absent/empty           |
| `videoViews`, `engagements`, `reactions`, `comments`, `shares`, `saves`, `follows` | `actions[]` of `video_view`, `post_engagement`, `post_reaction`, `comment`, `post`, `onsite_conversion.post_save`, `like` (R13) | action type absent (R11)    |
| `conversions`                                                                      | `actions[]` `omni_purchase` + `lead` (`value`, ad set attribution setting) (R15)                                                | neither type reported       |
| `conversionValueMicros`                                                            | `action_values[]` `omni_purchase` + `lead` (R15)                                                                                | neither value reported      |
| `allConversions`                                                                   | never                                                                                                                           | always                      |

Rows only exist for days with delivery; inside sync coverage a missing row means "no delivery"
(the existing Phase 5/6 semantics).

**Accumulating "other" across pages (R9).** Several unknown `publisher_platform` values of one
entity/day all map to the canonical key (entity, day, `other`), and Meta may return them on
different Graph pages. Because the sync replaces one canonical row per key, the provider never
emits such rows page by page:

- Rows with a unique key ("all" rows, known platforms) are emitted with their page as before.
- `other` contributions are accumulated in a **carry** inside the request-bound cursor
  (`convex/providers/meta/carry.ts`). The sync commits the cursor atomically with each page,
  so a retried or replayed page recomputes from the same cursor and nothing is double counted;
  a restart from page 1 rebuilds the carry from scratch.
- When the stage has no more Graph pages, the accumulated rows are emitted on **flush pages**
  (no Graph call, at most one page size each), before the next stage starts.
- Merge semantics: a metric reported by every contribution is summed exactly (an explicit 0
  stays 0); a metric reported by none stays absent; a metric reported by only some is **absent**
  (the total is unknown, so a partial sum is never stored as exact). `rawPlacement` lists every
  raw value (for example `oculus,unknown`). Action rows accumulate `count` the same way and
  `valueMicros` all-or-absent.
- Fail closed: a carry that would exceed the cursor cap (256 KiB, several hundred accumulated
  rows) fails the task with the non-retryable `data` error `placement_carry_limit`; rows are
  never dropped silently.

### Action metrics (`fetchActionMetrics`)

Same staged request with `action_attribution_windows=["1d_click","7d_click","1d_view"]` and
`action_report_time=impression` (no unified setting). One row per (entity, day, placement,
conversion action type, window) for every window key present (R16):

| Meta `action_type`               | `actionType`                                 | `isPrimary` |
| -------------------------------- | -------------------------------------------- | ----------- |
| `omni_purchase`                  | purchase                                     | true        |
| `lead`                           | lead                                         | true        |
| `omni_add_to_cart`               | add_to_cart                                  | false       |
| `omni_initiated_checkout`        | initiate_checkout                            | false       |
| `omni_complete_registration`     | complete_registration                        | false       |
| `omni_view_content`              | view_content                                 | false       |
| `omni_app_install`               | app_install                                  | false       |
| `offsite_conversion.custom.<id>` | custom (`conversionActionExternalId = <id>`) | false       |

`attributionBasis` is `impression_or_click_date` because the provider requests
`action_report_time=impression` (R14). `valueMicros` comes from `action_values` for the same
window. The combined `value` of a windowed request is not stored. Channel-specific types (for
example `offsite_conversion.fb_pixel_purchase`, part of `omni_purchase`) and engagement types are
not stored, so nothing is counted twice. Different windows are separate rows and analytics never
sums them. The wide `conversions` (ad set attribution setting) and these fixed-window rows are not
expected to reconcile exactly; that is by design, as for Google (`all_conversions`).

**Page fit.** One insights row becomes up to (conversion types × 3 windows) action rows, while the
sync engine accepts at most 500 records per page (larger pages fail as `page_too_large`, without
retry). When a Graph page normalizes to more than `maxPageSize` records, the provider requests the
**same** position again with fewer rows: an estimate from the page's density, strictly fewer rows
than the page held, and at least half after the first miss, so it ends within a few requests. Every
attempt starts from the carry the request arrived with, and the next cursor starts right after the
rows emitted, so no row is skipped or emitted twice. The cursor keeps the row count that fit (`l`)
for the stage's next page and doubles it again after a sparse page, up to the page size. A single
row with more than 500 records fails closed as `data` / `insights_row_too_large` (the task fails;
nothing is split or dropped). Re-requesting the same `after` with a different `limit` is part of
R17.

### Capabilities

`META_CAPABILITIES`: all four entity listings and metric levels; placements `all`, `facebook`,
`instagram`, `audience_network`, `messenger`, `threads`, `other`; all wide metrics above;
`actionMetrics: true` with windows `1d_click`, `7d_click`, `1d_view`; `incrementalEntities: false`;
`maxMetricsRangeDays: 31`; page size 500 (default and max, provisional R17);
`restatementLookbackDays: 28`.

## Real-account validation required

**Nothing below has been verified against a real Meta ad account.** When a real account is
connected (cloud dev deployment, `PROVIDER_MODE=live`, the project's Meta app), verify each item.
Record the evidence with `scripts/meta-g1-spike.mjs` (read-only, scrubbed; see the script header)
and compare synced totals with Ads Manager for the same account, date range and attribution
setting. An invalidated item changes only `semantics.ts` / `normalize.ts` / `mapping.ts` and their
tests.

| Id  | Assumption (implemented)                                                                                                                                                                                          | How to validate                                                                                                                                                                                                                                           | Decision |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| R1  | `/me/adaccounts` with `ads_read` returns every ad account the user granted in FLfB; granular-grant filtering is not applied.                                                                                      | Grant a subset of accounts in the FLfB dialog; compare discovery with `debug_token.granular_scopes`. If business-owned accounts are missing, report (would need `business_management`).                                                                   | D9       |
| R2  | `account_status` codes and `business{id}` as mapped (D10).                                                                                                                                                        | Check a disabled/closed account if available.                                                                                                                                                                                                             | D10      |
| R3  | `date_start` of daily insights is the account-local day; object times are instants converted to the account time zone.                                                                                            | Account in a non-UTC zone: compare one day's spend with Ads Manager for that day; compare start dates with Ads Manager.                                                                                                                                   | D14      |
| R4  | Objective mapping (ODAX + legacy).                                                                                                                                                                                | Compare `rawObjective` values seen with the table; unknown ones appear as `other`.                                                                                                                                                                        | —        |
| R5  | `effective_status` → delivery status mapping.                                                                                                                                                                     | Check statuses of paused, in-review and disapproved objects.                                                                                                                                                                                              | —        |
| R6  | Listings and insights exclude DELETED/ARCHIVED objects unless asked; our complete-enum `effective_status` parameters and `filtering` are accepted and include them.                                               | Delete/archive a test ad; confirm it is listed and its past delivery still appears. Reconcile Σ campaign-level spend with account-level spend for a range (must be equal). If Meta rejects an enum value the task fails with `invalid_request` (visible). | D11      |
| R7  | `/adcreatives` with `ads_read` lists every creative an ad references (also for archived/deleted ads) and the requested fields are readable.                                                                       | A sync must finish without `unresolved` records; check `syncRuns.counts.unresolved`.                                                                                                                                                                      | D12      |
| R8  | `object_type` PHOTO/VIDEO/STATUS → image/video/text; everything else (SHARE incl. carousels) → other.                                                                                                             | Inspect `attributes.objectType` of real creatives.                                                                                                                                                                                                        | —        |
| R9  | `publisher_platform` values facebook/instagram/audience_network/messenger/threads; others → `other`, accumulated across all pages of the request (all-or-absent per metric); breakdown rows sum to the "all" row. | Compare placement breakdown totals with the "all" row and with Ads Manager's placement breakdown.                                                                                                                                                         | D16      |
| R10 | Budgets are integers in the currency offset unit (cents for 2-digit currencies, units for 0-digit ones); COP/CRC/HUF/IDR/TWD ambiguous and not converted.                                                         | Compare a campaign's `budgetMicros` with Ads Manager (USD and, if possible, a 0-digit currency).                                                                                                                                                          | D14      |
| R11 | **D18 missing vs zero**: an absent field or action type is "not reported" (absent), a reported `"0"` is 0, and days without delivery have no row.                                                                 | Look at rows of a low-delivery ad: are zero `inline_link_clicks` / action types omitted or `"0"`? Are zero-spend days returned? If Meta omits zero values systematically, a later decision may treat an explicitly requested but omitted field as 0.      | **D18**  |
| R12 | Reach is requested on "all" rows only and only for windows starting within 380 days.                                                                                                                              | Query reach for a window older than 13 months; check error or omission.                                                                                                                                                                                   | D17      |
| R13 | Engagement and video columns: `post_engagement`, `post_reaction`, `comment`, `post`, `onsite_conversion.post_save`, `like`, `video_view`, `video_play_actions`, `video_p100_watched_actions`.                     | Compare with the Ads Manager columns of the same names.                                                                                                                                                                                                   | —        |
| R14 | **D20 basis**: with `action_report_time=impression`, conversions are dated on the impression date → `impression_or_click_date`.                                                                                   | Compare daily conversions with `action_report_time=conversion` (spike request 62): the distribution must differ where conversions lag. If Meta's semantics fit neither canonical basis, **stop and report**.                                              | **D20**  |
| R15 | **D19 conversions** = `omni_purchase` + `lead` with the ad set attribution setting (`use_unified_attribution_setting=true`), value from `action_values`.                                                          | Compare with Ads Manager "Purchases" + "Leads" (and "Purchases conversion value") for the same range. If "Results" is required instead, report.                                                                                                           | **D19**  |
| R16 | **D20 windows/types**: `1d_click`, `7d_click`, `1d_view` are valid windows; window keys appear per action entry; the listed `omni_*` types exist.                                                                 | Spike requests 58–60; check which window keys and action types real rows carry.                                                                                                                                                                           | **D20**  |
| R17 | Page size 500 is accepted for listings and insights, also re-requesting one `after` with a smaller `limit`; rate-limit headers (BUC regain minutes, `x-ad-account-usage` reset seconds) as parsed.                | Measure pages and throttling on a real account (G2); adjust `defaultPageSize`/`maxPageSize` if needed.                                                                                                                                                    | D33, D24 |
| R18 | Incremental listing (`updated_time` filtering) is **disabled**: every sync lists the full structure.                                                                                                              | Optional: validate the filtering syntax, then enable `incrementalEntities`.                                                                                                                                                                               | V17      |
| R19 | `debug_token` accepts the user token as the `input_token` query parameter (the only token in a URL).                                                                                                              | Keep; check whether a header/body alternative exists.                                                                                                                                                                                                     | V2       |
| R20 | `granular_scopes` / expiry fields of `debug_token` have the shape the OAuth spec reads; long-lived tokens last about 60 days.                                                                                     | Connect once; check the stored expiry on the connection.                                                                                                                                                                                                  | D5       |

## Testing

- No Meta credentials in CI. `convex/providers/meta/fakeGraph.fixtures.ts` serves a fake Graph
  behind the stubbed global `fetch` (`installFakeGraph`; with env, `stubLiveMeta` in
  `convex/test.helpers.ts`). It returns Marketing-API-SHAPED responses that model the documented
  API and the provisional assumptions (only requested fields; unknown fields are error 100;
  DELETED/ARCHIVED hidden unless asked for; zero `inline_link_clicks` and zero action types
  omitted; attribution-window keys only when requested). It enforces the header token and
  `appsecret_proof` and records every call. It is **not** evidence of real Meta behavior and
  contains no recorded data.
- **No test hooks in production code.** `createMetaAdsProvider`, `createMetaOAuthSpec` and
  `createGraphClient` take deployment configuration only and have no `fetch` or `mapping` option.
  HTTP always goes through the runtime's global `fetch` and the mapping is always `META_MAPPING`;
  tests stub the global `fetch`. A guard test (`provider.test.ts`) fails to compile if either
  option is re-added and proves at runtime that neither is honored.
- `tests/lint/meta-fixture-scrub.test.ts` rejects Graph tokens (`EAA…`), `access_token=`, 32-hex
  secrets and `fbtrace_id` in fixture files and any future recordings.
- Suites:
  - `convex/providers/meta/contract.test.ts`: the shared AdsProvider and OAuth contracts against
    the production mapping (referential integrity incl. archived/deleted objects, capabilities,
    staged paging, page-size invariance, request-bound cursors).
  - `convex/providers/meta/mapping.test.ts`: every provisional assumption (R3–R16) plus page
    shrink (D23), throttling and data errors.
  - `convex/providers/meta/carry.test.ts` and `placementPaging.test.ts`: `other` accumulated
    across pages (page caps 1/2/3/unlimited give identical rows), explicit zero, missing,
    mixed, replayed pages, `all` rows unaffected, fail closed on carry overflow.
  - `actionPaging.test.ts` (page fit): with many conversions every page holds at most 500
    records and all pages equal the one-row-per-page reference; the row count is kept for the
    stage; one oversized row fails closed (`insights_row_too_large`).
  - `client`, `errors`, `cursor` (staged cursors, row count), `provider` (config, D10, permission
    probe, version identity, fail-closed engine path, injection guard), `oauth` (incl.
    `isConfigured`).
  - `convex/providers/mode.test.ts` (D8), `convex/connections/metaFlow.test.ts` (connect, D28b,
    tenant isolation, D8, D1, refusal before any OAuth state for each missing or invalid
    setting), `convex/connections/oauthDiagnostics.test.ts`, `convex/connections/discoveryReason.test.ts`
    and `convex/sync/publicStatus.test.ts` (public reasons).
  - `convex/sync/meta.e2e.test.ts`: fake Graph → provider → sync → canonical tables → v1 analytics
    (overview, timeSeries, performance, breakdown, actions); idempotent re-sync; stored rows
    identical with Graph pages of 2 rows (R9); an account with many conversions completes with
    coverage and the same rows as 2-row pages; throttled page; tenant isolation; leak scan; Google
    stub; 190, `100/33` and 10 with their public reasons; 17; `1487534`.
  - `convex/sync/compat.test.ts` (D34).

## Runbooks

### Version bump

1. Read Meta's changelog for the target version; check every field in `normalize.ts` and the
   mapping.
2. On a dev deployment set `META_GRAPH_API_VERSION=vNN.0`; run a live sync; compare with the
   previous version's rows.
3. Update `META_API_VERSION` and the docs; remove the override. In-flight cursors of the old
   version restart their task once.

### Reconnect cadence

Long-lived user tokens last about 60 days and cannot be refreshed. Connections report
`expiresSoon` ahead of expiry and move to `needs_reauth` on `190`; the parent app prompts the user
to reconnect through `beginConnect`. Reconnecting the same Meta user updates the credential in
place (no duplicate accounts).

### Data deletion

Until the Phase 11 callbacks, a user's deletion request is handled manually: disconnect the
connection (`v1/connections:disconnect`), then purge that org's Meta rows with the operator tooling
of the time, and confirm to the requester. Record the request date and completion in the ops log.

### Monitoring

Watch, on the existing surfaces (`sync/admin:*`, `v1/sync`, audit log): `needs_reauth`, throttle
hits and `throttledUntil`, `page_limit`, spikes of `unknown` (including `provider_mode_*`,
`meta_config_invalid`), `data` and `invalid_request` codes (a rejected field or enum value), blocked
accounts, repeated partial backfills (`consecutiveFailures`), and D28b codes on
`connection.oauth_failed`. Keep a version-bump calendar and a monthly reconciliation against Ads
Manager (after Stage B).
