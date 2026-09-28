# Instagram organic provider (Phase 10)

Status: **Stage A (infrastructure)**. Connecting, discovering and linking Instagram
professional accounts works end to end. Token refresh works. The social sync subject runs
through the Phase 5 engine. **No Instagram data is mapped yet**: every sync operation fails
closed with `instagram_mapping_pending` before any network call. Stage B adds the semantic
mapping (posts, post snapshots, account metrics), organic analytics, the organic v1 API and
the `/social` dashboard.

Nothing here has been validated against a real Instagram account. Tests run against a fake
Instagram API (`convex/providers/instagram/fakeInstagram.fixtures.ts`) that models
**documented** behavior only and is not evidence. Pending real-account items are listed in
[Real-account validation](#real-account-validation-required).

Legend used below:

- **[doc]**: Meta's official Instagram Platform documentation.
- **[SDK]**: `@opencoredev/social-sdk@0.5.0` source.
- **ours**: a decision of this service (approved in the Phase 10 plan).
- **[PROVISIONAL IRn]**: unverified; real-account item IRn.

## Scope

- Instagram **organic** data only, for Business and Creator accounts, through **Instagram
  Login**. The `instagram` connection is separate from the Meta connection (I-D1).
- Instagram **ads** stay Meta ads (Meta provider, placement `instagram`), unchanged.
- The organic and paid trees are separate tables. Organic values never enter ad metrics.
- Not in Phase 10: comments, stories, DMs, messaging, webhooks, alerts, publishing.

## Architecture

```text
default runtime (V8)                               "use node" (Node 22, Gate V1: 22.23.2 in cloud)
─────────────────────────────────────────────────  ─────────────────────────────────────────────
v1/connections:beginConnect {provider:"instagram"} sync/socialWorker.ts   (entry point only)
/oauth/callback (httpAction)                         └ providers/social/nodeRegistry.ts
  └ providers/instagram/oauth.ts   (our OAuthSpec)      └ providers/instagram/node/provider.ts
  └ providers/instagram/discovery.ts                    └ providers/instagram/node/sdk.ts
      └ providers/instagram/graphReader.ts                  └ @opencoredev/social-sdk (ONLY here)
          └ providers/instagram/transport.ts  ◄──── every request, both runtimes ───┘
connections/tokenRefresh.ts (daily cron)
sync planner / runs / upsert  (subject: ad | social)
```

- **SDK isolation (ESLint and `tests/lint/social-sdk-isolation.test.ts`).**
  - Only `convex/providers/instagram/node/**` may import the SDK.
  - Only `providers/social/nodeRegistry.ts` may import that directory.
  - Only `sync/socialWorker.ts` may import the node registry.
  - Exactly these four files are `"use node"`.
  - No SDK type, error, reference or cursor leaves `node/`: callers get our read types, our
    `ig1.` cursors and `ProviderError`s.
- **Default-runtime half** (`providers/social/*`, registry family `social`): static
  capabilities, run metadata and the SDK-free account discovery. The planner and the OAuth
  callback never load the SDK. The approved discovery path is the OAuth identity, with no Node
  hop.
- **Runtime.** `convex.json` pins `node.nodeVersion: "22"` (I-D4). Gate V1 measured Node
  22.23.2 on the Convex **cloud** runtime (linux/arm64), which satisfies the SDK's `>=22.12`.

## Connection and OAuth

| Step                  | Request                                                                                                | Notes                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| consent               | `https://www.instagram.com/oauth/authorize?client_id&redirect_uri&response_type=code&scope&state`      | [doc] comma-separated scopes; **no PKCE** (not documented), so the single-use state nonce is the CSRF defense |
| `token_exchange`      | `POST https://api.instagram.com/oauth/access_token` (form body)                                        | [doc] response `{data:[{access_token, user_id, permissions}]}`; the flat shape of older docs is tolerated     |
| `long_lived_exchange` | `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret&access_token` | [doc] `{access_token, token_type, expires_in}` (60 days); **the approved secret-in-URL exception**            |
| `identity`            | `GET https://graph.instagram.com/v25.0/me?fields=user_id,username,account_type` (Bearer)               | Graph reader; `account_type` is requested but dropped by the SDK                                              |
| discovery             | same `/me` read, from the stored credential                                                            | one request; minimum identity only                                                                            |

- **Scopes:** `instagram_business_basic` and `instagram_business_manage_insights`, and nothing
  else. [PROVISIONAL IR16] The business-login page does not list `manage_insights`, but the
  insights references require it.
- **Identity:** `/me.user_id` [doc] ("the Instagram professional account ID") becomes both
  `connections.externalUserId` and the discovered account id. [PROVISIONAL IR2] We do not
  assume the code exchange's `user_id` equals it.
- **Ids are strings:** 17-digit ids exceed 2^53, so ids that arrive as JSON numbers must be
  safe integers, otherwise the flow fails closed with `identity_invalid`.
- **Account type (I-D16) [doc]:** `Business` maps to `business` and `Media_Creator` to
  `creator`. **Anything else fails closed** with `permission` / `account_type_unsupported`;
  there is no "unknown" value.
- **Granted scopes:** read from `permissions` (a comma string, or an array). Missing values
  grant nothing and are never invented.
- **Stored credential** (encrypted, `connections/credentialStore.ts`):
  `{kind:"instagram", v:1, accessToken (long-lived), tokenType:"long_lived", appId, userId, issuedAt, expiresAt?}`.
  Authorization codes and short-lived tokens are never stored.
- **D28b diagnostics:** the stages are `token_exchange`, `long_lived_exchange`, `identity`,
  `config` and `token_refresh`. The code values are numeric Graph/OAuth codes or the allowlisted
  internal codes `instagram_config_invalid`, `account_type_unsupported`, `identity_invalid`,
  `credential_invalid`, `token_too_new`, `transport_blocked` and `request_budget_exceeded`.
  Transport markers (`network`, `timeout`, `http_*`, `schema`) are dropped, as for Meta and
  Google.
- **No revoke:** Instagram Login documents none. Disconnect deletes the local credential.

### Token refresh (I-D8, I-D9)

- **When:** a daily cron (`connections/tokenRefresh.ts`, 03:17 UTC) refreshes **active
  Instagram** connections whose token expires within 10 days (ours) and is at least 24 h old
  [doc].
- **How:** `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token`
  (the second approved exception).
- **Atomic replacement:** `credentialStore.replaceRefreshedCredential` swaps the ciphertext
  together with the expiry and `credentialVersion + 1`, and writes a
  `connection.token_refreshed` audit entry. The swap only happens if the connection is still
  active **and** still on the credential generation the refresh started from, so a reconnect
  or disconnect that happened meanwhile always wins. Granted scopes are never overwritten.
- **Failures:**
  - An `auth` failure (e.g. 190) or an unusable credential moves the connection to
    `needs_reauth` (reason `token_refresh_failed`, audited).
  - A token that is too new is skipped.
  - Anything else records only `{kind, "Token refresh failed"}` and is retried the next day.
- **Scope:** Meta and Google are never refreshed by this job.

## Transport guard and the secret-in-URL exception

`providers/instagram/transport.ts` checks **every** Instagram request (OAuth, Graph reader and
the fetch injected into the SDK) **before any network access**:

- The rules are checked in this order:
  1. https only;
  2. no userinfo, fragment or explicit port;
  3. a host, method, path and query allowlist per caller.
- **Global rule (unchanged):** no secret-like query parameter (`access_token`,
  `client_secret`, `code`, `refresh_token`, `token`, `input_token`, `fb_exchange_token`,
  `appsecret_proof`, and anything containing `secret` or `token`) in any URL.
- **The only exception:** exactly two shapes, `oauth` caller only, GET, no version prefix, no
  `Authorization` header, with exactly these parameter sets:
  - `/access_token`: `grant_type=ig_exchange_token`, `client_secret`, `access_token`;
  - `/refresh_access_token`: `grant_type=ig_refresh_token`, `access_token`.

  Any variation is refused: an extra or missing parameter, a duplicate, a wrong grant, another
  host (including `graph.facebook.com`), a versioned path, POST, http. These URLs are built
  right before the fetch and are never logged, persisted or carried by an error. Failures are
  structured (`blocked`, `budget_exceeded`, `network`, `timeout`, `invalid_json`, `http` with
  code/subcode/usage), and fetch exceptions are never propagated because they may contain the
  URL.

- **Graph reads** carry the token only in `Authorization: Bearer`. Allowlists:

| Caller       | Route (`graph.instagram.com/v25.0/…`) | Parameters                                                                                                                                                                    |
| ------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| graph_reader | `me`                                  | `fields=user_id,username,account_type` (exact)                                                                                                                                |
| graph_reader | `{id}/insights`                       | `metric` ⊆ non-deprecated [doc] metrics; `period` (day, lifetime); `metric_type` (total_value, time_series); `breakdown=follow_type`; `since`/`until` (unix seconds). Stage B |
| sdk          | `{id}`                                | `fields` = the SDK profile field list or `media_product_type` (exact)                                                                                                         |
| sdk          | `{id}/media`                          | `fields` = the SDK media field list (exact); `limit` 1–100; `after`                                                                                                           |
| sdk          | `{id}/insights`                       | `metric=likes,comments,saved,shares,reach` or `shares,reach` (exact)                                                                                                          |

- **Deprecated metrics** (`impressions`, `plays`, `video_views`, `profile_views`,
  `website_clicks`) are refused by the allowlist.
- **Refused before the network:** comments, messaging, publishing, other versions, encoded
  paths and non-numeric ids. The Graph `paging.next` URLs (which embed a token) are never
  followed.

## Graph reader (I-D3 option B)

`providers/instagram/graphReader.ts` is minimal and read-only: the `graph_reader` allowlist,
an explicit `RequestBudget` per call, shape-validated responses reduced to our own types, and
classified errors. **Stage A implements only the identity read.** The allowlist already covers
the other documented SDK gaps (account insights; media `views` / `total_interactions`), whose
reads and mappings are Stage B. It is not a generic Graph client.

## social-sdk adapter (`node/sdk.ts`)

- **Construction:** one SDK client per session, built with our guarded fetch, SDK retries off
  (one attempt; the sync engine owns retries) and concurrency 3.
- **Reads** (Stage B uses them):
  - `profile()`: 1 request; drops biography, website, follows and media counts.
  - `listMedia()`: 1 request per page; the SDK's `social-v1.*` cursor is wrapped in our `ig1.`
    cursor.
  - `postMetrics()`: 2 requests; Instagram metric names; unknown names fail closed.
- **Errors:** [SDK] the SDK maps errors by HTTP status only and discards the body. Our fetch
  captures the Meta error code/subcode and the usage headers of every failed response before
  the SDK sees it, and `classifyInstagramFailure` **replaces** the SDK mapping. Without a
  capture, only the SDK error **code** is mapped (`sdk_<code>`), never its message.

## Errors (`providers/instagram/errors.ts`)

[PROVISIONAL IR4] The same Graph code family as Meta. The code wins over the HTTP status.

| Input                                           | Kind                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 190, 102, HTTP 401                              | `auth` (the connection moves to `needs_reauth`)                                             |
| 4, 17, 32, 341, 368, 613, 80000–80014, HTTP 429 | `rate_limited` (retryAfter from `X-Business-Use-Case-Usage` / `Retry-After`, capped at 1 h) |
| 10, 3, 200–299, HTTP 403                        | `permission`                                                                                |
| 100/33, HTTP 404/410                            | `not_found`                                                                                 |
| 1, 2, `is_transient`, 5xx, network, timeout     | `transient`                                                                                 |
| 100 (other)                                     | `invalid_request`                                                                           |
| transport refusal / budget exhausted            | `unknown` (`transport_blocked` / `request_budget_exceeded`; never retried)                  |

## Cursor (`providers/instagram/cursor.ts`)

`ig1.` + base64url(JSON `{v:1, fp, op, c}`) + `.` + the first 128 bits of SHA-256.

- **Bound:** to the request fingerprint (provider id with Graph version, operation, account,
  parameters) and to the operation.
- **Bounded:** at most 8 KB, and an inner position of at most 4 KB of printable ASCII.
- **Strict:** the exact key set is required.
- **Tamper-evident:** any edit fails closed with `invalid_request` / `cursor_invalid` (the
  engine restarts the task once). It is not a keyed MAC, but cursors live only in internal sync
  tables.

## Capabilities and request budget (I-D6)

Stage A declares **nothing it does not implement** (`posts: false`, no post or account
metrics), so the social planner plans the preflight only. The approved values are already in
place for Stage B:

| Value                      | Setting                                      | Source                                           |
| -------------------------- | -------------------------------------------- | ------------------------------------------------ |
| account-metric horizon     | 90 days                                      | [doc] "stored for up to 90 days" (I-D9)          |
| account-metric lookback    | 3 days                                       | ours: [doc] 48 h reporting delay + 1 day (I-D10) |
| account-metric chunk       | 31 days                                      | ours                                             |
| post snapshot window       | 90 days, UTC capture day                     | ours                                             |
| listing page               | 100                                          | [SDK] limit 1–100                                |
| requests per post snapshot | **3** (2 SDK + 1 reader)                     | approved                                         |
| concurrency                | 3 in flight                                  | approved                                         |
| posts per snapshot task    | 1,000 (truncation is reported, never silent) | approved                                         |
| listing pages              | 100 (10K media [doc])                        | approved                                         |
| requests per provider call | 31 (10 posts × 3 + 1 listing)                | approved                                         |

Budgets are enforced by `RequestBudget` (an explicit failure when exhausted). Tests assert
request counts: code exchange 3, discovery 1, refresh 1, profile 1, listing 1 per page,
post metrics 2.

## Sync (Stage A)

- **Subject:** a social account is its own sync subject (`socialAccountId`; see
  [sync.md](../sync.md)).
- **Execution:** runs go through the existing planner, runs, tasks, leases and claims. The
  first task is `getSocialAccount`, executed by the `"use node"` social worker.
- **Fail closed:** the Instagram provider checks configuration (app id), the credential and
  account ownership, then fails with `unknown` / `instagram_mapping_pending`. The run fails, the
  account backs off (15 min … 6 h), no data is written, and **no platform request is made**.
  In mock mode the mock social provider fails with `social_mapping_pending`.
- **Other outcomes:** `auth` moves the connection to `needs_reauth`. Disconnecting cancels the
  active run and parks the account.

## Real-account validation required

| Item     | What to verify                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| IR1      | ✅ Convex cloud Node 22 runtime ≥ 22.12 (Gate V1: 22.23.2, 2026-09-28)                                     |
| IR2      | the OAuth `user_id` vs `/me.user_id`                                                                       |
| IR3      | `caption` / `media_product_type` returned under Instagram Login                                            |
| IR4      | HTTP statuses of 190 / 4 / 17 / 80002; the error classification                                            |
| IR5      | the usage header present on graph.instagram.com                                                            |
| IR6–IR11 | day semantics, empty set vs 0, `follows_and_unfollows`, insight availability, `views`, retention (Stage B) |
| IR12     | the 10K media limit and removal                                                                            |
| IR13     | token refresh timing (60 days, ≥ 24 h)                                                                     |
| IR14     | the rate budget in real use                                                                                |
| IR15     | the follower snapshot vs the end-of-day value                                                              |
| IR16     | the `instagram_business_manage_insights` scope name on the consent screen; `permissions` format            |
| IR17     | the real Graph paging cursor alphabet (allowlist: printable ASCII ≤ 2048)                                  |

## Configuration

| Convex env var                             | Purpose                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | Instagram app (Instagram Login). With `PROVIDER_MODE=live`, setting either enables the real spec and provider; invalid values fail closed with `instagram_config_invalid` |

Redirect URI to register with the app: `<CONVEX_SITE_URL>/oauth/callback`. The Graph version
(v25.0) is pinned by the SDK and has no override; a bump follows an SDK upgrade.
