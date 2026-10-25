# YouTube organic provider (ADR 0016)

Status: **Checkpoint 1 (provider foundation) implemented against mock and fake data only.**

- **Checkpoint 1:** the allowlisted read-only client, the `SocialProvider` for channel and video
  metadata, the mapping and boundary validation, the mock provider and the Node sync registry.
- **Planned:** OAuth and connection (Checkpoint 2), analytics sync (3), retention (3b), the v1 API
  (4), the `/social` dashboard and the connect UI (5), verification and setup docs (6).

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
sync/socialWorker.ts ("use node", entry point only)
  └ providers/social/nodeRegistry.ts
      └ providers/youtube/provider.ts      (plain fetch; no SDK; no "use node")
          └ providers/youtube/client.ts    allowlist + budget + timeout, every request
          └ providers/youtube/mapping.ts   ← semantics.ts
mock mode: providers/social/mock/youtube.ts (raw-shaped data → the REAL mapping)
```

The YouTube modules import no Convex runtime API and no SDK; ESLint keeps them (and the YouTube
mock) out of `convex/analytics/**`, like the Instagram provider.

## Client allowlist (`providers/youtube/client.ts`)

Every request is checked **before any network access**: https only; no user info, port or
fragment; the raw URL must spell the route exactly; exactly the route's parameter names (no
duplicates), each value checked; required parameters present. Tokens travel only in the
`Authorization: Bearer` header (Data API) or the form body (token endpoint), never in a URL. Every
request takes one unit of an explicit per-call budget. Fetch exceptions are never propagated.

| Route                                      | Parameters                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `POST https://oauth2.googleapis.com/token` | none (form body: the refresh grant)                                                            |
| `GET …/youtube/v3/channels`                | `part=snippet,statistics,contentDetails`, `mine=true`, `maxResults=50` (exact)                 |
| `GET …/youtube/v3/playlistItems`           | `part=contentDetails`, `playlistId`, `maxResults` 1–50, optional `pageToken` (printable ASCII) |
| `GET …/youtube/v3/videos`                  | `part=snippet`, `id` = 1–50 distinct video ids                                                 |

Refused: every other path or host (search, comments, captions, writes, Analytics until
Checkpoint 3, revocation until Checkpoint 2), API keys and any token parameter.

## Operations (Checkpoint 1)

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

`PROVIDER_MODE=mock` resolves the mock YouTube provider: one upload every second UTC day for 180
days, every 8th an `upcoming` premiere. Users: `<n>` (a channel with a handle), `hidden` (hidden
subscriber count), `empty` (no uploads), `edge` (an upload without a publish time), and a
`revoked` credential (`auth`). The mock OAuth spec and discovery that issue these credentials are
Checkpoint 2.

## Real-channel validation required

| Item | What to verify                                                             |
| ---- | -------------------------------------------------------------------------- |
| YR1  | channel and video id formats                                               |
| YR2  | the uploads playlist id format                                             |
| YR3  | the page token alphabet and length                                         |
| YR4  | the error reasons and statuses (quota, scope, revoked, deleted)            |
| YR5  | `customUrl` carries the handle with "@"                                    |
| YR6  | unlisted (and private) uploads appear in the owner's uploads playlist      |
| YR7  | the uploads playlist lists newest first                                    |
| YR8  | the `publishedAt` format                                                   |
| YR9  | whether Analytics data is revised after it first appears (lookback length) |

## Configuration

Planned for Checkpoint 2 (not read by anything a user can reach yet):

| Convex env var                               | Purpose                                                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | Google OAuth web client of a dedicated Cloud project. With `PROVIDER_MODE=live`, setting either enables the YouTube provider; invalid values fail closed with `youtube_config_invalid` |
