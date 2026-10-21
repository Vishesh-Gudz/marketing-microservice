# ADR 0010 — Google Ads provider

- Status: accepted (Stage A: infrastructure; Stage B: mappings — real-account validation pending);
  amended 2026-10-20 (Google Cloud project access, see "Amendment")
- Date: 2026-09-28

## Context

Phase 8 integrated Meta behind the `AdsProvider` / `OAuthSpec` contracts. Phase 9 integrates Google
Ads the same way, without changing the schema, the public v1 API, analytics, the dashboard, the mock
providers or the sync engine. Google differs from Meta in ways the contracts must absorb inside the
provider: manager (MCC) hierarchies and the `login-customer-id` header, a developer token, GAQL
queries with a server-fixed page size, OAuth refresh tokens, and conversion actions. No real Google
Ads account is available, so behavior that only a real account can confirm is implemented
provisionally in Stage B and listed for validation (docs/providers/google-ads.md).

## Decisions (H0, Phase 9 plan revision 2)

1. **G-D1** Pinned API version `v25` (latest general release at implementation time; v25 released
   2026-07-22) with a validated `GOOGLE_ADS_API_VERSION` override. `providerId`
   (`google-ads-api/<version>`) is run metadata only; the version is part of every cursor
   fingerprint.
2. **G-D2** REST `customers/{id}/googleAds:search` with page tokens. No `searchStream` (it cannot be
   checkpointed per page).
3. **G-D3** The `login-customer-id` route is resolved inside the provider on the first page of each
   request (direct access first, else the first accessible manager — in sorted order — whose
   hierarchy lists the account as not hidden) and carried in the cursor. No contract or sync change.
   `parentExternalId` is that routing manager.
4. **G-D4** Scopes `https://www.googleapis.com/auth/adwords` and `openid` only. The identity is the
   OpenID `sub`; no email or profile is requested or persisted; `displayName` stays absent.
5. **G-D5** The credential (encrypted) holds the refresh token, the OAuth client id, the issue time
   and the granted scopes. `refreshable: true`, no `expiresAt`, no stored access token.
6. **G-D5a** `OAuthSpec.refresh` exists in the shared contract but the connection layer does not
   call it; the Google client therefore exchanges the stored refresh token for a short-lived access
   token at the start of each provider call. Access tokens are memory-only (never stored, logged,
   returned or put in a URL). No Phase 4 change.
7. **G-D6** No platform revoke on disconnect (revoking can end the same Google user's grant used by
   another org); manual revocation is documented.
8. **G-D7** `GOOGLE_ADS_DEVELOPER_TOKEN` is a Convex env secret; developer-token and configuration
   errors are ProviderError `unknown` (never reauth, never an account block). **Superseded by the
   Amendment** (no developer token; configuration errors keep this classification).
9. **G-D8** Read-only client: an endpoint allowlist (token, userinfo, `listAccessibleCustomers`,
   `googleAds:search`) is enforced before any network call; every other path — `:mutate`,
   `:searchStream`, other hosts — is refused.
10. **G-D11 = A** A Google-local carry (`convex/providers/google/carry.ts`) with the Phase 8
    semantics; `convex/providers/meta/carry.ts` is not moved or modified.
11. **G-D12** Performance Max: only network values Google returns are mapped; no placement is ever
    synthesized from an asset-group aggregate (Stage B, provisional GR10).
12. **G-D16** Provider pages stay ≤ 500 records. Google search pages are a fixed 10,000 rows
    (documented for v19+; `page_size` cannot be set), so one Google page is served as several
    provider pages and **re-retrieved** for each (cursor = stage, page token, offset). The cost is
    measured in tests (operation counters of the fake API).
13. **G-D17** Discovery: `listAccessibleCustomers`, then `customer` for each accessible customer and
    the `customer_client` hierarchy of each manager. Managers are listed (not linkable), hidden
    clients skipped, cancelled/closed clients listed as `closed`, duplicates listed once (first
    route), accessible customers always listed on their own (direct route), at most 10,000 accounts
    (fail closed beyond).
14. **G-D19** OAuth-failure diagnostics (D28b) extended with the stages `token_exchange`,
    `identity`, `api_access`, `config` and an explicit Google code allowlist.
15. **Live registry.** In `PROVIDER_MODE=live`, the Google provider and OAuth spec replace the
    unavailable stub **when Google is configured** (any of `GOOGLE_CLIENT_ID`,
    `GOOGLE_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN` set; incomplete or invalid values then fail
    closed with `google_config_invalid`). A live deployment without any Google configuration keeps
    the Phase 8 D8-A stub, so Meta-only live deployments behave exactly as in Phase 8. (Amendment:
    "configured" is now `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET`.)

## Stage A

Infrastructure: configuration, credential, client, error classification, GAQL builder, staged
cursor with slicing and carry, routing, OAuth, discovery (`listAccounts`, `getAccount`), registry,
D28b-G, the fake Google Ads API and tests.

## Stage B decisions (mappings)

Every semantic choice is a named definition in `convex/providers/google/semantics.ts`, tagged
`[doc]` or `[PROVISIONAL GRn]` (docs/providers/google-ads.md has the full tables and the
"Real-account validation required" list). Verified against the v25 reference (proto comments and
enums) before implementation; nothing is verified against a real account.

- **B1 Structure.** Campaigns (`FROM campaign` with the attributed `campaign_budget`), ad groups
  (`FROM ad_group`), Performance Max asset groups (`FROM asset_group`, kind `asset_group`), ads and
  their one-per-ad creatives (`FROM ad_group_ad`, id `{adGroupId}~{adId}`, creative id = ad id).
  No status filters (G-D14). Google campaigns have no objective (`unknown`); the channel is mapped
  from `advertising_channel_type`.
- **B2 Budgets.** DAILY → `daily` / `amount_micros`, CUSTOM_PERIOD → `lifetime` /
  `total_amount_micros` [doc]; no budget → `none`; any other period fails the page closed.
  Shared budgets keep the shared amount, `isSharedBudget` and `attributes.campaignBudgetId`
  (GR7).
- **B3 Dates.** v25 exposes `start_date_time` / `end_date_time` ("yyyy-MM-dd HH:mm:ss", customer
  time zone) and documents "clear the field to run indefinitely"; the canonical dates are the
  date part; absent end = none. The plan's `2037-12-30` sentinel is not documented for v25 and is
  not special-cased (a returned value is stored as is, GR8).
- **B4 Daily metrics.** `cost_micros` (exact), `impressions`, `clicks`, `conversions`,
  `conversions_value`, `all_conversions` [doc]; absent stays absent, 0 stays 0 (G-D13 / GR12).
  No reach, link clicks, video or engagement metrics (G-D21).
- **B5 Placements.** The documented v25 `ad_network_type` values with a canonical placement map
  1:1 (SEARCH, SEARCH_PARTNERS, CONTENT, YOUTUBE, GMAIL, DISCOVER, MIXED "Cross-network"); all
  others → `other` (carry). The plan listed GMAIL/DISCOVER under "other"; the v25 enum documents
  them ("Gmail", "Discover Feed") and the canonical model has those placements, so they are mapped.
- **B6 Performance Max (G-D12).** Asset groups are never queried with the network segment and
  never get placement rows; no placement is synthesized (GR10).
- **B7 Action rows (G-D10).** One row per `segments.conversion_action`: count =
  `all_conversions`, value = `all_conversions_value`, category → action type.
  - **Identity:** `rawActionType` = the action's immutable resource name
    (`customers/{id}/conversionActions/{id}`), `conversionActionExternalId` = its id. The mutable
    display name is not stored (no canonical field): renames never create a new logical action and
    same-named actions never collide. The Phase 2 schema comment's "conversion action name" is
    read as the API resource name; the schema is unchanged.
  - **isPrimary** = `conversion_action.primary_for_goal`, as the Phase 2 contract names it
    ("counts toward the account's primary conversions"). Google's goals guide documents that
    primary actions are included in Conversions and secondary ones only in All conversions
    (except custom goals), and that `include_in_conversions_metric` is deprecated. Read once per
    request by a lookup (all Google pages, ≤ 10,000 actions) carried in the cursor; absent when
    not reported; the current setting at sync time (GR15).
  - **attributionWindow** = the constant bucket `action_setting` ("the conversion action's own
    lookback setting when the conversion was attributed"). Google reports no per-row window and
    the lookback fields are current settings, so no day count is claimed; the field is required,
    so it cannot be absent.
  - Wide `conversions` is never derived from or reconciled with action rows.
- **B8 Capabilities.** Declared from the mapping only (placements, six reported metrics, action
  metrics with the `action_setting` window bucket); the sync plans tasks from them unchanged.
- **B9 No sync, schema, analytics, v1, dashboard, mock or Meta change.** The engine gained a
  per-request lookup (Google-local) and the cursor a lookup field.

## Consequences

- Google connections can be created, discovered, linked and synced into the canonical tables in
  live mode; provisional semantics are listed for real-account validation (GR3–GR21).
- Every provider call that reaches Google costs one OAuth token request (not an Ads operation) plus
  one search call; sliced pages re-retrieve the same Google page (documented, measured); carry flush
  pages make no call.
- The Google Cloud project's operation quota (originally: the developer token's) is shared by all
  tenants; action requests add one conversion-action lookup per request (measured in the e2e quota
  table).
- Ad-group-level placement analytics exclude Performance Max asset groups (visible, never
  mislabeled).

## Amendment (2026-10-20): Google Cloud project access, no developer token

Context: Google sunset developer tokens on 2026-09-09. The `developer-token` header is optional and
ignored, and will be rejected in a future major version; API access levels (Test, Explorer, Basic,
Standard) now belong to the Google Cloud project that owns the OAuth client
([Developer token](https://developers.google.com/google-ads/api/docs/api-policy/developer-token),
[Access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels)).
A Cloud project created after the sunset cannot obtain a token, so requiring one blocked every
connection before the consent screen.

Decisions:

1. `GOOGLE_ADS_DEVELOPER_TOKEN` is removed from the provider and OAuth configuration, the
   registry's "configured" check and every request; no `developer-token` header is ever sent
   (tests assert it on every logged request). A leftover env value is ignored.
2. `AuthorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` (a Test-access project calling a
   production account, v25+) is configuration (`unknown`), like `google_config_invalid`: never a
   `permission` failure, so discovery fails visibly instead of skipping the customer, and sync
   neither requests reauth nor blocks the account (the run fails and is retried with the
   standard failure backoff).
3. The legacy developer-token error enums stay classified as configuration (harmless; pre-sunset
   bodies) and stay in the D28b allowlist next to the new code.
4. Unchanged: OAuth (PKCE S256, offline access, `prompt=consent`, refresh-token requirement,
   OpenID `sub` identity), encrypted credentials, the read-only allowlist, discovery, routing,
   paging, sync, analytics, tenant isolation, mock mode, Meta and Instagram.

Consequence: OAuth works with only `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`; real accounts need
the project's Explorer (or higher) access level, and all tenants share that project's quota.
