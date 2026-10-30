# Connections (Phase 4)

How an organization connects a platform identity (a Meta user or a Google account), and how its
credentials are handled. The code lives in `convex/connections/`, `convex/v1/connections.ts` and
`convex/http.ts`. Security details: [security/credentials.md](security/credentials.md).

> Phase 4 ships **mock OAuth specs** ("instant consent") for both platforms. The real Meta OAuth spec
> arrives in Phase 8 and the real Google Ads spec in Phase 9. They implement the same `OAuthSpec`
> interface (`convex/providers/oauth.ts`), so nothing else changes.

**Who starts connections.** Every client uses the same v1 functions below; there is no second
integration and no other credential store.

- **Google Ads and Meta Ads:** the standalone dashboard's `/connections` page
  ([dashboard.md](dashboard.md#connections-google-ads-meta-ads-and-youtube); ADR 0008 D17 amendments),
  and later the parent app through v1. Today the dashboard runs with the local development token
  only; hosted users cannot sign in or connect yet.
- **Instagram:** the parent app through v1. The dashboard shows its status read-only.
- **YouTube** (ADR 0016): the dashboard's `/connections` page, YouTube section (Checkpoint 5:
  connect, reconnect, link the channel, disconnect and delete its data), and the parent app
  through v1.

> **Ownership (S2):** the OAuth callback never creates a connection. It stores the consented,
> encrypted grant and returns a one-time claim code to the return URL; only the user who started
> the sign-in, signed in to the same org, can turn it into a connection
> ([Callback ownership](#callback-ownership-s2)). Cloud deployments still refuse new connections
> until an operator sets `OAUTH_CONNECTIONS_ENABLED=true` after S2 is deployed and verified.

> **WhatsApp** connections (ADR 0014) are stored here too, with provider `whatsapp`, but never use
> this OAuth flow: they come from Embedded Signup. `beginConnect` refuses `whatsapp`, and
> `disconnect` / `refreshAssets` refuse WhatsApp connections (reason `whatsapp_connection`). See
> [adr/0014-whatsapp-connections.md](adr/0014-whatsapp-connections.md).

## Flow

```text
v1/connections:beginConnect (admin, ACTION: secure randomness)
  nonce + PKCE verifier (crypto.getRandomValues) ─► oauthStates { sha256(nonce), verifier, org, initiator, returnUrl, TTL 10 min }
  ◄─ authorizeUrl (state = raw nonce)        mock: the authorize URL IS the callback URL
browser ─► platform consent ─► GET <CONVEX_SITE_URL>/oauth/callback?state&code   (unauthenticated)
  consume state (single-use; expired / app disabled / org gone / no returnUrl → rejected)
  OAuthSpec.exchangeCode (PKCE) ─► grant { credential, identity, scopes, expiresAt }
  encrypt (AES-256-GCM, AAD = orgId|provider|externalUserId|v1)   ← plaintext only in this action
  storeGrant ─► oauthGrants { ciphertext, identity, org, issuer, initiator, sha256(claim), TTL 10 min }
                (reconnect: a different identity is refused here already)
  302 ─► allow-listed returnUrl?status=pending&claim=<one-time code>   (or a static page)
v1/connections:completeConnect { claim } (admin, ACTION; the SAME issuer + user + org as beginConnect)
  claimGrant (atomic): owner, expiry and reconnect identity checked; connection + credential
                       (ciphertext moved unchanged) created; grant deleted
  discovery: AdsProvider.listAccounts({ credential, attempt })  ─► discoveredAssets
  ◄─ { connectionId, discoveryFailed }
v1/connections:linkAdAccounts ─► mapAdAccount(record, OrgScope) ─► adAccounts { connectionId, linkedAt }
```

## v1 surface

| Function                              | Wrapper            | Role   |
| ------------------------------------- | ------------------ | ------ |
| `v1/connections:beginConnect`         | `orgAdminAction`   | admin  |
| `v1/connections:completeConnect`      | `orgAdminAction`   | admin  |
| `v1/connections:list` / `get`         | `orgQuery`         | viewer |
| `v1/connections:listDiscoveredAssets` | `orgQuery` (admin) | admin  |
| `v1/connections:linkAdAccounts`       | `orgAdminMutation` | admin  |
| `v1/connections:unlinkAdAccount`      | `orgAdminMutation` | admin  |
| `v1/connections:disconnect`           | `orgAdminMutation` | admin  |
| `v1/connections:refreshAssets`        | `orgAdminMutation` | admin  |
| `v1/adAccounts:list`                  | `orgQuery`         | viewer |

`beginConnect` args: `{ provider, returnUrl, reconnectConnectionId? }` → `{ authorizeUrl, expiresAt }`.
`returnUrl` is **required** (S2): the claim code is delivered only there.

`completeConnect` args: `{ claim }` → `{ connectionId, discoveryFailed }`. Refusals carry a fixed
`details.reason` and nothing more:

- `NOT_FOUND` `invalid_claim`: unknown, already used, invalidated, or presented by another user,
  org or app.
- `CONFLICT` `expired_claim`: older than 10 minutes.
- `CONFLICT` `identity_mismatch`: the reconnect target no longer matches.
- `FORBIDDEN`: the caller is not an admin.
- `INVALID_ARGUMENT` `connections_disabled`: a cloud deployment without `OAUTH_CONNECTIONS_ENABLED`.

A claim presented by anyone other than the initiator **deletes the grant**, so it can never be
claimed afterwards.

**Callback result parameters** (appended to the allowlisted `returnUrl`; never tokens,
authorization codes or messages):

- `status=pending&claim=<code>`: the consent succeeded and waits to be claimed. The client must
  remove the code from its URL and call `completeConnect` as the signed-in user that started the
  connection, within 10 minutes. The code is a single-use capability: never log or display it.
- `status=error&error=<code>`, where `<code>` is one of `access_denied`, `invalid_state`,
  `expired_state`, `exchange_failed`, `identity_mismatch`, `internal`. The published code set
  (`CALLBACK_ERROR_CODES`) also contains `discovery_failed`; discovery now runs in
  `completeConnect` and is reported as `discoveryFailed: true` (the connection is kept and its
  `lastError` says why).
- Clients must treat unknown codes as a generic failure and must not display parameter values.
- Before S2 the callback returned `status=connected&connection=<id>[&warning=discovery_failed]`;
  it no longer does. The dashboard still reads that shape (display only).

**Google Ads today (Phase 9).** `beginConnect` builds Google's authorization URL (`adwords` and
`openid` scopes, `access_type=offline`, `prompt=consent`, PKCE S256). The callback exchanges the
code (a refresh token is required), reads the OpenID `sub` as the identity, and probes Google Ads
API access (`listAccessibleCustomers`) **before** anything is stored: a Google account with no
Google Ads access (`NOT_ADS_USER`) fails as `exchange_failed`, with no connection created. Then
it encrypts the credential and stores it as a pending grant; the claim (`completeConnect`)
creates the connection and runs discovery (manager hierarchies included). Details:
[providers/google-ads.md](providers/google-ads.md#connection-flow-and-credential).

**Discovered accounts and linking (additive fields).** `listDiscoveredAssets` returns, per account,
`managerStatus` (`manager` | `client` | `unknown`), `testAccountStatus` (`test` | `not_test` |
`unknown`) and `parentExternalId` (the manager it was discovered through; absent when directly
accessible). `unknown` means the platform did not report the fact (Google's `manager` /
`test_account` are optional fields) and is never treated as `client` / `not_test`.
`linkAdAccounts` links only accounts whose effective manager status is `client`: managers are
rejected as before, and an unknown manager status is `INVALID_ARGUMENT` with
`reason: "manager_status_unknown"` (refresh discovery to re-check). Platforms that always report
the account type (Meta, the mocks) derive it from `isManager`. Google Ads rows discovered before
these fields were recorded read `unknown` until discovery runs again. Linking never trusts a
client-supplied customer id: only ids this connection discovered can be linked.

**Discovery errors (additive).** A failed discovery (on claim or a retry) keeps the
connection and records a sanitized `lastError { kind, message, reason?, at }` on it:
`kind` is the provider error kind and `message` a generic text. For **Google Ads** connections the
platform code, and for **Meta Ads** connections the code and the error kind, is translated into an
allowlisted public `reason` (the same allowlist as sync errors, `convex/sync/publicStatus.ts`),
e.g. `cloud_project_not_approved_for_production`, `not_ads_user`, `reauth_required`,
`permission_denied`, `rate_limited` ([meta.md](providers/meta.md#public-reasons)). The code itself
is never stored or returned, an unlisted code yields no `reason`, and Instagram records none. A successful discovery clears
`lastError`. (Google Ads skips individual customers it cannot read, e.g. permission or not
found; those are not discovery failures.)

**Retry discovery.** `v1/connections:refreshAssets` (admin) re-runs discovery in the background
for an **active** connection (otherwise `CONFLICT`, `reason: "connection_inactive"`). Discovery
replaces the connection's discovered accounts. Completion is visible on the connection: its
`updatedAt` changes and `lastError` is cleared or set.

**Sync status (additive).** Each `adAccounts:list` entry carries an optional read-only `sync`
block: `syncState`, `lastSuccessAt`, `lastRunStatus`, `consecutiveFailures`, `nextRunAt`,
`coveredFrom` / `coveredThrough` and `lastError { kind, message, reason?, at }`. `reason` comes
only from an explicit allowlist (`convex/sync/publicStatus.ts`, e.g.
`cloud_project_not_approved_for_production`, `reauth_required`, `provider_config_invalid`); the
platform error code itself is never returned. See [sync.md](sync.md).

## Lifecycle

```text
(none) ─callback─► pending grant ─claim by the initiator─► active ─auth error / token expiry─► needs_reauth ─reconnect─► active
pending grant ─claim by anyone else / expiry / reconnect identity mismatch─► deleted (nothing connected)
active | needs_reauth ─disconnect─► revoked   (credential deleted; ad accounts unlinked, rows kept; YouTube channels purged)
```

- **Reconnect** with the same identity updates the same connection: new credential,
  `credentialVersion + 1`. An explicit reconnect (`reconnectConnectionId`) by a **different**
  identity fails with `identity_mismatch` (at the callback, and again when the grant is claimed).
  To switch accounts, disconnect first, then connect
  without `reconnectConnectionId` (in the dashboard: **Disconnect Google Ads**, then **Connect
  Google Ads**).
- **Relinking** an ad account to another connection of the same org is allowed and audited
  (`adAccount.relinked`).
- **Disconnect** schedules `revokeAtPlatform` for the credential version it disconnected: a
  best-effort platform revoke, then the credential is deleted. Both happen only while the
  connection is still `revoked` on that `credentialVersion` (re-checked in the deletion's own
  transaction). Every credential write increments the version, so a reconnect, even one followed
  by another disconnect, is never touched by an earlier disconnect's job (IM7.0). A job scheduled
  before versions existed never revokes or deletes (`legacy_job`); the health sweep deletes what
  is left. How the revoke ended is audited in the same transaction as the deletion
  (`connection.platform_revoke`, before `credential.deleted`), as `outcome`:
  - `revoked`: the platform accepted the revocation, or already considered the token revoked;
  - `failed`: the revocation request failed, with an allowlisted `failureKind` (a provider error
    kind) and `failureCode` (an identifier such as `revoke:http_503`; anything else is dropped);
  - `not_attempted`: nothing was sent, because the credential was already gone
    (`credential_unavailable`) or could not be used, the provider was not configured
    (`internal`), the connection was connected again since (`superseded`: nothing deleted
    either), or the job predates credential versions (`legacy_job`: nothing deleted either);
  - `not_supported`: the provider has no platform revoke (Google Ads G-D6, Meta D7, Instagram).

  A failed revoke is not retried: the credential is deleted either way, so the grant stays at
  the platform until the user removes it there.

- **Linking starts syncing (Phase 5).** The link writes the account through the canonical write
  path (`convex/sync/upsert.ts`) and creates or resumes its `syncAccounts` state in the same
  transaction; the next planner tick starts the initial sync. Unlink parks the sync state; a run in
  flight is cancelled at its next step. See [sync.md](sync.md).
- **The health sweep** (`convex/crons.ts`, hourly):
  - deletes expired states
  - deletes unclaimed grants past their 10-minute expiry, with their ciphertext (audited
    `connection.grant_expired`)
  - marks active connections whose `tokenExpiresAt` has passed as `needs_reauth`
  - deletes any credential still attached to a revoked connection (IM7.0,
    `convex/connections/credentialSweep.ts`): EVERY revoked connection is visited, 200 per
    transaction, from a cursor persisted in `maintenanceCursors`. Each page is processed and the
    cursor advanced in one transaction, and each row is re-read there, so a credential is
    deleted only while its connection is `revoked`. One run at a time (a lease, released when a
    pass completes or a run pauses; an interrupted run's lease expires after 10 minutes). A run
    reads at most 5,000 pages (about a million rows); the next hourly run resumes from the
    cursor, which is reset only at the end of the index (or when it can no longer be read:
    `cursorResets`). A connection revoked behind the cursor is visited by the next pass.
    Monitoring: `maintenanceCursors.lastPageAt` should move every hour, and
    `lastPassCompletedAt` once per pass; a `lastPageAt` older than 2 hours means a stuck sweep.
- **Sync on provider `auth` errors (Phase 5)** calls `markConnectionNeedsReauth` (the helper behind
  `internal.connections.lifecycle.markNeedsReauth`) inside its own failure transaction, audited as
  subject `system:sync`, and cancels the connection's other active runs.

## Callback ownership (S2)

The OAuth state binds a sign-in to the org, app and user that called `beginConnect`, but the
callback is unauthenticated: the person completing the platform consent may be someone else (a
forwarded authorization link). So a consent alone connects nothing. The callback stores the
encrypted grant (`oauthGrants`, 10 minutes) and sends a one-time claim code to the return URL;
`completeConnect` turns it into a connection only for the **same issuer, user and org** that
started it, once. A consent completed by someone else lands in their browser, where their own
session cannot claim it; their attempt invalidates the grant. Details, audit entries and the
browser-binding trade-offs:
[security/credentials.md](security/credentials.md#oauth-callback-ownership-s2).

## Configuration

| Convex env var                                           | Purpose                                                                                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `TOKEN_ENCRYPTION_KEYS`                                  | `{"1":"<base64 32 bytes>"}`; highest version encrypts. **Required**; missing = fail closed                                          |
| `CONVEX_SITE_URL`                                        | Built in; the redirect URI is `<CONVEX_SITE_URL>/oauth/callback`                                                                    |
| `PROVIDER_MODE`                                          | Phase 8: `mock` or `live`; **required on every cloud deployment** (fails closed, see [providers/meta.md](providers/meta.md))        |
| `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID` | Phase 8 (real Meta spec, `PROVIDER_MODE=live`); optional `META_GRAPH_API_VERSION`                                                   |
| `META_OAUTH_REDIRECT_ORIGIN`                             | Optional, Meta only, local deployments only: `http://localhost:<site port>` (see below)                                             |
| `OAUTH_CONNECTIONS_ENABLED`                              | Cloud deployments only: `beginConnect` / `completeConnect` refuse unless exactly `true`; set only after S2 is deployed and verified |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`               | Phase 9 (real Google spec)                                                                                                          |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`               | Phase 10 (Instagram Login, organic Instagram; see [providers/instagram.md](providers/instagram.md))                                 |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`             | ADR 0016 (organic YouTube; its own Google OAuth client, never `GOOGLE_CLIENT_ID`; see [providers/youtube.md](providers/youtube.md)) |

**Meta redirect origin (`META_OAUTH_REDIRECT_ORIGIN`).** Facebook Login for Business only accepts
HTTPS redirect URIs, except `http://localhost`, which Meta allows automatically while the app is in
development mode (it cannot be added to Valid OAuth Redirect URIs). A local deployment's
`CONVEX_SITE_URL` is `http://127.0.0.1:3211`, which Meta refuses, so the local deployment sets
`META_OAUTH_REDIRECT_ORIGIN=http://localhost:3211`: Meta's redirect URI becomes
`http://localhost:3211/oauth/callback` (the same backend). The **only** accepted value is
`http://localhost:<CONVEX_SITE_URL's port>` (an origin: no path, query, fragment or credentials) on
a local deployment, one whose `CONVEX_SITE_URL` is plain `http` on a loopback host. Everything
else is refused, including every `https` origin (even the deployment's own), other loopback names
(`127.0.0.1`, `[::1]`) and other ports, so an authorization code can never be redirected off the
deployment. A refused value makes `beginConnect` fail with `INTERNAL` naming the variable (never its
value) before any OAuth state exists, and a callback that finds it invalid fails with `internal`
without calling Meta. `beginConnect` and the callback's code exchange compute the URI the same way,
so authorization and exchange always send the same `redirect_uri`. Google Ads, Instagram and
YouTube always use `CONVEX_SITE_URL`. **Cloud deployments leave it unset**: Meta then uses the HTTPS
`<CONVEX_SITE_URL>/oauth/callback`, which a published app must register exactly.

Per app, the return-URL allowlist is set with
`npx convex run admin/integrationApps:setAllowedReturnUrls '{"issuer":"…","urls":["https://app.example.com/settings/"]}'`.
It matches the exact origin plus a path prefix.

Development: `npm run dev:auth setup` also generates `TOKEN_ENCRYPTION_KEYS` into the dev deployment
and allowlists `http://localhost:3000/` and `http://127.0.0.1:3000/` (any path below them, e.g. the
dashboard's `/connections`). Other origins, including Playwright's `http://127.0.0.1:3100`, are
not allowlisted: `beginConnect` refuses them with `INVALID_ARGUMENT` (`field: "returnUrl"`).

## Platform requirements (for Phases 8–9)

|             | Meta                                                                     | Google Ads                                                                                   |
| ----------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Login       | Facebook Login for Business (`config_id`)                                | OAuth 2.0 web client, `access_type=offline`, `prompt=consent`                                |
| Scopes      | `ads_read` only (Phase 8, D9; `business_management` only if G1 requires) | `…/auth/adwords`, `openid` (no email; Phase 9)                                               |
| Identity    | `/me` id                                                                 | ID token `sub`                                                                               |
| Token model | long-lived user token (~60 days), no refresh → `needs_reauth` on expiry  | refresh token; `invalid_grant` → `needs_reauth`                                              |
| Also        | `appsecret_proof`; deauthorize + data-deletion callbacks (Phase 11)      | Cloud-project access level (no developer token); `login-customer-id` from `parentExternalId` |

### Instagram (Phase 10, organic)

- **Separate connection:** `provider: "instagram"`, using Instagram Login (not the Meta
  connection).
- **Callback:** it runs the Instagram OAuthSpec in the default runtime (code, then long-lived
  token, then `/me` identity). Discovery then reads the same `/me` identity into
  **`discoveredSocialAccounts`**, never `discoveredAssets`.
- **Linking:** `v1/connections:listDiscoveredSocialAccounts`, `linkSocialAccounts` and
  `unlinkSocialAccount` (admin) link and unlink `socialAccounts` through `sync/upsert.ts` and
  create the account's sync state.
- **Ad and social paths never cross:**
  - `linkAdAccounts` on an Instagram connection returns `NOT_FOUND`;
  - `linkSocialAccounts` on an ad connection returns `INVALID_ARGUMENT`.
- **Disconnect:** also unlinks social accounts and drops `discoveredSocialAccounts`.
- **Meta callbacks (ADR 0017, IM6):** the Instagram Login app's deauthorize callback moves the
  user's connections to `needs_reauth`; its data-deletion callback disconnects them and deletes
  the account's stored data in every org ([instagram-messaging.md](instagram-messaging.md)).
- **Token refresh:** a daily job refreshes long-lived tokens (at least 24 h old, expiring within
  10 days) and replaces the credential atomically. An `auth` failure moves the connection to
  `needs_reauth`.
- **D28b:** the diagnostics also allowlist the `token_refresh` stage and the Instagram internal
  codes.

Full details: [providers/instagram.md](providers/instagram.md).

### YouTube (ADR 0016, organic)

- **Separate connection:** `provider: "youtube"`, through YouTube's own Google OAuth client
  (`YOUTUBE_CLIENT_ID`), never the Google Ads connection or client. A YouTube client id equal to
  `GOOGLE_CLIENT_ID` is refused (`beginConnect` `INVALID_ARGUMENT`; provider calls
  `youtube_config_invalid`), because revoking a YouTube grant must never revoke a Google Ads one.
- **Consent:** PKCE S256, `access_type=offline`, `prompt=consent`,
  `include_granted_scopes=false`; scopes `youtube.readonly` and `yt-analytics.readonly` (both
  required, nothing that can write).
- **Callback:** the YouTube OAuthSpec runs in the default runtime: code exchange (a refresh token
  is required), then `channels.list?mine=true`. The consent's channel is the identity
  (`externalUserId` = channel id; no `displayName`: no channel title outlives its data).
  Without `youtube.readonly`, with no channel or with more than one channel the exchange fails
  closed (`exchange_failed`); without `yt-analytics.readonly` the connection is created and
  reports the scope in `missingScopes`.
- **Discovery** returns that one channel into `discoveredSocialAccounts` (id and account type
  `channel`, no handle); linking uses the same social link functions as Instagram, and ad and
  social paths never cross.
- **Tokens:** only the refresh token is stored (encrypted). Access tokens are minted per provider
  call and never stored; the token refresh job never touches YouTube. `invalid_grant` (revoked
  or expired, e.g. after 7 days in Google's Testing mode) moves the connection to `needs_reauth`.
- **Disconnect:** revokes the refresh token at Google (`oauth2.googleapis.com/revoke`, token in
  the form body), then always deletes the credential and drops discovery; the channel and all its
  stored data are hard-deleted (Checkpoint 3b). The revoke outcome is audited
  (`connection.platform_revoke`, see [Lifecycle](#lifecycle)).
- **Unlink** (`unlinkSocialAccount`) hard-deletes the channel and its stored data too, keeping
  the connection and the id-only discovered row. Relinking is refused (`CONFLICT`,
  `purge_pending`) until the deletion has completed; the channel then links as a new row.
- **Retention:** a daily check purges channels whose authorization is confirmed invalid
  (`invalid_grant`, channel not owned, no credential); temporary failures never purge. Details,
  decision logic and the deletion-request runbook:
  [providers/youtube.md](providers/youtube.md#retention-checkpoint-3b).
- **D28b:** the diagnostics allowlist the YouTube codes (`no_channel`, `youtube_scope_missing`,
  `multiple_channels`, `youtube_config_invalid` and the YouTube API reasons).

Full details: [providers/youtube.md](providers/youtube.md).

### Meta (Phase 8)

The real Meta spec (Facebook Login for Business, long-lived user token, `ads_read` only, no PKCE,
no platform revoke) is documented in [providers/meta.md](providers/meta.md). A failed Meta code
exchange keeps the callback outcome `exchange_failed`; the `connection.oauth_failed` audit entry
additionally carries only the allowlisted D28b diagnostics (`failureKind`, `failureStage`,
`providerCode`), never tokens, codes, state, secrets, URLs, messages, bodies or `fbtrace_id`.
With `PROVIDER_MODE` misconfigured there are no OAuth specs and `beginConnect` is refused.
