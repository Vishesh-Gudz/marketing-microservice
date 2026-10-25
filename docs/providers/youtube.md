# YouTube organic provider (ADR 0016)

Status: **Checkpoints 1–2 implemented against mock and fake data only.**

- **Checkpoint 1:** the allowlisted read-only client, the `SocialProvider` for channel and video
  metadata, the mapping and boundary validation, the mock provider and the Node sync registry.
- **Checkpoint 2:** the `youtube` connection provider, the OAuth spec (PKCE, own client),
  channel discovery, the credential lifecycle (`needs_reauth`, revocation on disconnect),
  registration in every `PROVIDER_MODE`, the mock OAuth spec and discovery, D28b diagnostics.
  A linked channel's **metadata** (channel, uploads) already syncs; no metric does yet.
- **Planned:** analytics sync (3), retention (3b), the v1 API (4), the `/social` dashboard and
  the connect UI (5), verification and setup docs (6).

Nothing here has been validated against a real YouTube channel. Tests run against a fake Google
API (`convex/providers/youtube/fakeYouTube.fixtures.ts`) and a deterministic mock provider
(`convex/providers/social/mock/youtube*.ts`) that model **documented** behavior only and are not
evidence. Every item marked **[PROVISIONAL YRn]** stays provisional until checked on a real
channel ([Real-channel validation](#real-channel-validation-required)).

Legend: **[doc]** Google's official documentation; **ours** a decision of the Checkpoint 0 plan
(Y-Dn); **[PROVISIONAL YRn]** unverified.

## Scope

- YouTube **organic** channel data only, read-only. YouTube ads stay Google Ads (placement
  `youtube`). No publishing, comments, captions, playlists management, live streaming,
  monetization or revenue reports.
- Never stored: thumbnails or any URL other than the built permalink, descriptions, tags, channel
  banners, the privacy status.

## Architecture

```text
default runtime                                     sync (the "use node" social worker)
v1/connections:beginConnect {provider:"youtube"}    sync/socialWorker.ts
/oauth/callback (httpAction)                          └ providers/social/nodeRegistry.ts
  └ providers/youtube/oauth.ts      (OAuthSpec)           └ providers/youtube/provider.ts
v1/connections:completeConnect
  └ providers/youtube/discovery.ts
        all of them ─► providers/youtube/session.ts (config + credential checks, token minting)
                       ─► providers/youtube/client.ts (allowlist + budget + timeout, every request)
mock mode: providers/social/mock/youtube.ts (OAuth, discovery, provider; the REAL mapping)
```

The YouTube modules import no Convex runtime API and no SDK; ESLint keeps them (and the YouTube
mock) out of `convex/analytics/**`, like the Instagram provider.

## Client allowlist (`providers/youtube/client.ts`)

Every request is checked **before any network access**: https only; no user info, port or
fragment; the raw URL must spell the route exactly; exactly the route's parameter names (no
duplicates), each value checked; required parameters present. Tokens travel only in the
`Authorization: Bearer` header (Data API) or the form body (token endpoint), never in a URL. Every
request takes one unit of an explicit per-call budget. Fetch exceptions are never propagated.

| Route                                       | Parameters                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST https://oauth2.googleapis.com/token`  | none (form body: the authorization-code grant with the PKCE verifier, or the refresh grant)    |
| `POST https://oauth2.googleapis.com/revoke` | none (form body: `token`; the documented `?token=` form is never used) [YR11]                  |
| `GET …/youtube/v3/channels`                 | `part=snippet,statistics,contentDetails`, `mine=true`, `maxResults=50` (exact)                 |
| `GET …/youtube/v3/playlistItems`            | `part=contentDetails`, `playlistId`, `maxResults` 1–50, optional `pageToken` (printable ASCII) |
| `GET …/youtube/v3/videos`                   | `part=snippet`, `id` = 1–50 distinct video ids                                                 |

Refused: every other path or host (search, comments, captions, writes, Analytics until
Checkpoint 3), API keys and any token parameter (also on the revocation endpoint).

## Connection and OAuth (Checkpoint 2)

| Step           | Request                                                                                                                                | Notes                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| consent        | `https://accounts.google.com/o/oauth2/v2/auth` with PKCE S256, `access_type=offline`, `prompt=consent`, `include_granted_scopes=false` | scopes `youtube.readonly` + `yt-analytics.readonly`, both required                                    |
| token_exchange | `POST oauth2.googleapis.com/token` (code + verifier + client secret, form body)                                                        | a refresh token is required (`no_refresh_token`)                                                      |
| identity       | `GET channels?mine=true` (Bearer)                                                                                                      | exactly one channel: none = `no_channel`, several = `multiple_channels` [YR10]                        |
| discovery      | token + `channels?mine=true` from the stored credential                                                                                | returns the credential's channel; one not owned anymore = `permission` / `account_mismatch`           |
| revoke         | `POST oauth2.googleapis.com/revoke` (form body)                                                                                        | on disconnect, best effort; an already revoked token counts as done; the credential is deleted anyway |

- **Own OAuth client (Y-D3):** `YOUTUBE_CLIENT_ID` must not equal `GOOGLE_CLIENT_ID`. The spec
  reports itself unconfigured (so `beginConnect` refuses before any state exists), and the
  discovery, the sync provider and revocation fail closed with `youtube_config_invalid`. A
  credential issued to the Google Ads client is never revoked through YouTube.
- **Identity:** the channel id is `connections.externalUserId` and the credential's `channelId`;
  the channel title is the `displayName`. No `openid`, email or profile data is requested.
  Reconnecting a different channel into a connection is an `identity_mismatch`.
- **Granular consent:** without `youtube.readonly` the exchange fails
  (`identity:youtube_scope_missing`, nothing is requested from the Data API); without
  `yt-analytics.readonly` the connection is created and lists it in `missingScopes`.
- **Stored credential:** `{kind:"youtube", v:1, refreshToken, clientId, channelId, issuedAt, scopes}`,
  encrypted. No expiry and no refresh job: access tokens are minted per call.
- **Lifecycle:** `invalid_grant` (revoked in the Google account, expired, or the 7-day expiry of
  Google's Testing mode) on any call is `auth`: the sync engine moves the connection to
  `needs_reauth`; reconnecting the same channel makes it active again.
- **Disconnect** revokes at Google, deletes the credential, unlinks the channel and drops
  discovery. The channel's stored rows are kept until Checkpoint 3b implements the retention rules.
- **D28b stages:** `config`, `token_exchange`, `identity`; the allowlisted codes are listed in
  `connections/oauthDiagnostics.ts`.

## Operations (sync)

| Operation             | Requests                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `getAccount`          | 2: token + `channels.list?mine=true` (the channel must be owned by the authorization)            |
| `listPosts`           | first page 4: token + channel (uploads playlist) + `playlistItems.list` + `videos.list`; later 3 |
| `fetchPostMetrics`    | none: `unsupported` (Checkpoint 3)                                                               |
| `fetchAccountMetrics` | none: `unsupported` (Checkpoint 3)                                                               |

Before any request, every operation checks the configuration (`youtube_config_invalid`,
`unknown`), the credential shape and OAuth client (`auth`), and that the requested channel is the
credential's channel (`permission` / `account_mismatch`). Access tokens are minted per call from
the stored refresh token and kept in memory only.

## Mapping (`semantics.ts`, `mapping.ts`)

| YouTube                                      | Canonical                                     | Notes                                                      |
| -------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| channel `id`                                 | `socialAccounts.externalId`                   | "UC" + 22 characters [doc] [YR1]                           |
| `snippet.title`                              | `name`                                        | falls back to the handle, then the id                      |
| `snippet.customUrl` starting with "@"        | `username` (without "@")                      | legacy custom URLs are not handles [YR5]                   |
| `statistics.subscriberCount`                 | `followersCount`                              | rounded to 3 significant figures [doc]; absent when hidden |
| —                                            | `accountType` `channel`                       | Y-D2                                                       |
| `contentDetails.relatedPlaylists.uploads`    | (the listing source)                          | travels in the cursor [YR2]                                |
| video `id`                                   | `socialPosts.externalId`                      | 11 characters [doc] [YR1]                                  |
| `snippet.title`                              | `caption`                                     | at most 100 characters; empty = absent                     |
| `snippet.publishedAt`                        | `publishedAt`                                 | ISO 8601 UTC [YR8]; missing = unresolved                   |
| —                                            | `type` `video`                                | no Short marker in the Data API [doc]                      |
| built `https://www.youtube.com/watch?v=<id>` | `permalink`                                   | the only URL                                               |
| `snippet.liveBroadcastContent`               | `none` / `live` ingested, `upcoming` excluded | other values unresolved                                    |
| `snippet.channelId` ≠ the channel            | unresolved                                    | never stored                                               |

Uploads that `videos.list` no longer returns (deleted or made inaccessible between the two
reads) are unresolved, so the listing is incomplete and no removal is marked.

## Errors (`errors.ts`)

[PROVISIONAL YR4] Reasons from the Data API error reference; the reason wins over the status.

| Input                                                                                 | Kind                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------- |
| OAuth `invalid_grant` / `access_denied`; `authError`, `unauthorized`, HTTP 401        | `auth` (connection → `needs_reauth`)        |
| `insufficientPermissions`, `forbidden`, `youtubeSignupRequired`, `channelClosed`, 403 | `permission`                                |
| `accessNotConfigured`, `SERVICE_DISABLED`, OAuth `invalid_client`                     | `unknown` (deployment config; never reauth) |
| `quotaExceeded`, `dailyLimitExceeded`                                                 | `rate_limited`, retried after 1 h           |
| `rateLimitExceeded`, `userRateLimitExceeded`, HTTP 429                                | `rate_limited` (Retry-After capped at 1 h)  |
| `*NotFound`, HTTP 404                                                                 | `not_found`                                 |
| `backendError`, `internalError`, 5xx, network, timeout                                | `transient`                                 |
| `invalidPageToken`, `badRequest`, HTTP 400                                            | `invalid_request`                           |
| allowlist refusal / budget spent                                                      | `unknown` (never retried)                   |

## Cursor (`cursor.ts`)

`yt1.` + base64url(JSON `{v:1, fp, p, t}`): bound to the request fingerprint (provider id,
operation, channel), carrying the uploads playlist id and the Data API page token. The exact key
set is required; anything else is `invalid_request` / `cursor_invalid` (the engine restarts the
task once).

## Capabilities

| Value                      | Setting                                     | Source                                   |
| -------------------------- | ------------------------------------------- | ---------------------------------------- |
| account types              | `channel`                                   | Y-D2                                     |
| posts                      | yes                                         | Checkpoint 1                             |
| post / account metrics     | none yet                                    | Checkpoint 3                             |
| listing page               | 50                                          | [doc] Data API page limit                |
| listing pages              | 100 (5,000 uploads; truncation is reported) | ours                                     |
| requests per provider call | 4                                           | token + channel + playlistItems + videos |
| account-metric horizon     | 395 days                                    | ours (Y-D7)                              |
| account-metric lookback    | 7 days                                      | ours (Y-D7) [YR9]                        |

## Mock mode

`PROVIDER_MODE=mock` resolves the mock YouTube OAuth spec, discovery and provider (no network,
no Google credentials): instant consent with PKCE (`mock-yt-code.<user>.<fingerprint>`), one
upload every second UTC day for 180 days, every 8th an `upcoming` premiere. Users:

- data: `<n>` (a channel with a handle), `hidden` (hidden subscriber count), `empty` (no
  uploads), `edge` (an upload without a publish time);
- consent: `limited` (`yt-analytics.readonly` unticked), `noyoutube` (`youtube.readonly`
  unticked), `nochannel`, `norefresh` (no refresh token), `revoked` (a credential the mock
  rejects as `invalid_grant`).

## Real-channel validation required

| Item | What to verify                                                                               |
| ---- | -------------------------------------------------------------------------------------------- |
| YR1  | channel and video id formats                                                                 |
| YR2  | the uploads playlist id format                                                               |
| YR3  | the page token alphabet and length                                                           |
| YR4  | the error reasons and statuses (quota, scope, revoked, deleted)                              |
| YR5  | `customUrl` carries the handle with "@"                                                      |
| YR6  | unlisted (and private) uploads appear in the owner's uploads playlist                        |
| YR7  | the uploads playlist lists newest first                                                      |
| YR8  | the `publishedAt` format                                                                     |
| YR9  | whether Analytics data is revised after it first appears (lookback length)                   |
| YR10 | how Brand Accounts select the channel at consent; `mine=true` returns exactly one channel    |
| YR11 | the revocation endpoint accepts the token in the form body and answers 200 / `invalid_token` |
| YR12 | the consent screen shows both scopes; `scope` in the token response lists what was granted   |

## Configuration

| Convex env var                               | Purpose                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | Google OAuth web client of a dedicated Cloud project. With `PROVIDER_MODE=live`, setting either enables the YouTube OAuth spec, discovery and provider; invalid values, or a client id equal to `GOOGLE_CLIENT_ID`, fail closed with `youtube_config_invalid` |

Nothing here is needed for mock mode or the tests. For a **real** connection (manual, not yet
verified):

1. A Google Cloud project of its own (not the Google Ads project), with the **YouTube Data API
   v3** and the **YouTube Analytics API** enabled.
2. An OAuth consent screen with both scopes. In **Testing** status only listed test users can
   consent, and their refresh tokens expire after 7 days (the connection then needs reauth). An
   app name without "YouTube", a privacy policy (Developer Policies III.A) and Google's
   verification are needed before public use.
3. An OAuth client of type **Web application** whose authorized redirect URI is exactly
   `<CONVEX_SITE_URL>/oauth/callback` (the deployment's site URL; a local backend uses its
   `http://127.0.0.1:<port>` site URL).
4. `npx convex env set YOUTUBE_CLIENT_ID …` and `YOUTUBE_CLIENT_SECRET …`, plus
   `PROVIDER_MODE=live` (and `OAUTH_CONNECTIONS_ENABLED=true` on a cloud deployment, see
   [connections.md](../connections.md)).
5. Start the connection through `v1/connections:beginConnect` with `provider: "youtube"` (the
   `/connections` section is Checkpoint 5), then link the discovered channel.
