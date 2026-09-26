# Connections (Phase 4)

How an organization connects a platform identity (a Meta user or a Google account), and how its
credentials are handled. The code lives in `convex/connections/`, `convex/v1/connections.ts` and
`convex/http.ts`. Security details: [security/credentials.md](security/credentials.md).

> Phase 4 ships **mock OAuth specs** ("instant consent") for both platforms. The real Meta OAuth spec
> arrives in Phase 8 and the real Google Ads spec in Phase 9. They implement the same `OAuthSpec`
> interface (`convex/providers/oauth.ts`), so nothing else changes.

## Flow

```text
v1/connections:beginConnect (admin, ACTION: secure randomness)
  nonce + PKCE verifier (crypto.getRandomValues) ─► oauthStates { sha256(nonce), verifier, org, initiator, returnUrl, TTL 10 min }
  ◄─ authorizeUrl (state = raw nonce)        mock: the authorize URL IS the callback URL
browser ─► platform consent ─► GET <CONVEX_SITE_URL>/oauth/callback?state&code
  consume state (single-use; expired / app disabled / org gone → rejected)
  OAuthSpec.exchangeCode (PKCE) ─► grant { credential, identity, scopes, expiresAt }
  encrypt (AES-256-GCM, AAD = orgId|provider|externalUserId|v1)   ← plaintext only in this action
  upsertConnectionWithCredential (atomic; natural key org+provider+identity)
  discovery: AdsProvider.listAccounts({ credential, attempt })  ─► discoveredAssets
  302 ─► allow-listed returnUrl?status=connected&connection=<id>   (or a static page)
v1/connections:linkAdAccounts ─► mapAdAccount(record, OrgScope) ─► adAccounts { connectionId, linkedAt }
```

## v1 surface

| Function                              | Wrapper            | Role   |
| ------------------------------------- | ------------------ | ------ |
| `v1/connections:beginConnect`         | `orgAdminAction`   | admin  |
| `v1/connections:list` / `get`         | `orgQuery`         | viewer |
| `v1/connections:listDiscoveredAssets` | `orgQuery` (admin) | admin  |
| `v1/connections:linkAdAccounts`       | `orgAdminMutation` | admin  |
| `v1/connections:unlinkAdAccount`      | `orgAdminMutation` | admin  |
| `v1/connections:disconnect`           | `orgAdminMutation` | admin  |
| `v1/connections:refreshAssets`        | `orgAdminMutation` | admin  |
| `v1/adAccounts:list`                  | `orgQuery`         | viewer |

`beginConnect` args: `{ provider, returnUrl?, reconnectConnectionId? }` → `{ authorizeUrl, expiresAt }`.

**Callback result parameters:**

- `status=connected&connection=<id>`, plus `&warning=discovery_failed` when discovery failed.
- `status=error&error=<code>`, where `<code>` is one of `access_denied`, `invalid_state`,
  `expired_state`, `exchange_failed`, `identity_mismatch`, `internal`.

## Lifecycle

```text
(none) ─callback─► active ─provider auth error / token expiry─► needs_reauth ─reconnect─► active
active | needs_reauth ─disconnect─► revoked   (credential deleted; ad accounts unlinked, rows kept)
```

- **Reconnect** with the same identity updates the same connection: new credential,
  `credentialVersion + 1`. An explicit reconnect (`reconnectConnectionId`) by a **different**
  identity fails with `identity_mismatch`.
- **Relinking** an ad account to another connection of the same org is allowed and audited
  (`adAccount.relinked`).
- **Linking starts syncing (Phase 5).** The link writes the account through the canonical write
  path (`convex/sync/upsert.ts`) and creates or resumes its `syncAccounts` state in the same
  transaction; the next planner tick starts the initial sync. Unlink parks the sync state; a run in
  flight is cancelled at its next step. See [sync.md](sync.md).
- **The health sweep** (`convex/crons.ts`, hourly):
  - deletes expired states
  - marks active connections whose `tokenExpiresAt` has passed as `needs_reauth`
  - deletes any credential still attached to a revoked connection
- **Sync on provider `auth` errors (Phase 5)** calls `markConnectionNeedsReauth` (the helper behind
  `internal.connections.lifecycle.markNeedsReauth`) inside its own failure transaction, audited as
  subject `system:sync`, and cancels the connection's other active runs.

## Configuration

| Convex env var                                           | Purpose                                                                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `TOKEN_ENCRYPTION_KEYS`                                  | `{"1":"<base64 32 bytes>"}`; highest version encrypts. **Required**; missing = fail closed                                   |
| `CONVEX_SITE_URL`                                        | Built in; the redirect URI is `<CONVEX_SITE_URL>/oauth/callback`                                                             |
| `PROVIDER_MODE`                                          | Phase 8: `mock` or `live`; **required on every cloud deployment** (fails closed, see [providers/meta.md](providers/meta.md)) |
| `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID` | Phase 8 (real Meta spec, `PROVIDER_MODE=live`); optional `META_GRAPH_API_VERSION`                                            |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`               | Phase 9 (real Google spec)                                                                                                   |

Per app, the return-URL allowlist is set with
`npx convex run admin/integrationApps:setAllowedReturnUrls '{"issuer":"…","urls":["https://app.example.com/settings/"]}'`.
It matches the exact origin plus a path prefix.

Development: `npm run dev:auth setup` also generates `TOKEN_ENCRYPTION_KEYS` into the dev deployment
and allowlists `http://localhost:3000/`.

## Platform requirements (for Phases 8–9)

|             | Meta                                                                     | Google Ads                                                    |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Login       | Facebook Login for Business (`config_id`)                                | OAuth 2.0 web client, `access_type=offline`, `prompt=consent` |
| Scopes      | `ads_read` only (Phase 8, D9; `business_management` only if G1 requires) | `…/auth/adwords`, `openid`, `email`                           |
| Identity    | `/me` id                                                                 | ID token `sub`                                                |
| Token model | long-lived user token (~60 days), no refresh → `needs_reauth` on expiry  | refresh token; `invalid_grant` → `needs_reauth`               |
| Also        | `appsecret_proof`; deauthorize + data-deletion callbacks (Phase 11)      | developer token; `login-customer-id` from `parentExternalId`  |

### Meta (Phase 8)

The real Meta spec (Facebook Login for Business, long-lived user token, `ads_read` only, no PKCE,
no platform revoke) is documented in [providers/meta.md](providers/meta.md). A failed Meta code
exchange keeps the callback outcome `exchange_failed`; the `connection.oauth_failed` audit entry
additionally carries only the allowlisted D28b diagnostics (`failureKind`, `failureStage`,
`providerCode`), never tokens, codes, state, secrets, URLs, messages, bodies or `fbtrace_id`.
With `PROVIDER_MODE` misconfigured there are no OAuth specs and `beginConnect` is refused.
