# YouTube organic provider (ADR 0016)

Status: **Checkpoints 1–3 implemented against mock and fake data only.**

- **Checkpoint 1:** the allowlisted read-only client, the `SocialProvider` for channel and video
  metadata, the mapping and boundary validation, the mock provider and the Node sync registry.
- **Checkpoint 2:** the `youtube` connection provider, the OAuth spec (PKCE, own client),
  channel discovery, the credential lifecycle (`needs_reauth`, revocation on disconnect),
  registration in every `PROVIDER_MODE`, the mock OAuth spec and discovery, D28b diagnostics.
- **Checkpoint 3:** analytics sync and storage: the channel day report (`reports.query`) and
  per-video lifetime statistics (`videos.list`), Pacific Time days, the 3-day reporting delay,
  7-day lookback, 31-day chunks, the 395-day history. Only values YouTube reports are stored; the
  organic analytics does not aggregate them yet ([Policy](#policy-and-the-organic-analytics)).
- **Planned:** retention (3b), the v1 API (4), the `/social` dashboard and the connect UI (5),
  verification and setup docs (6).

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

| Route                                       | Parameters                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `POST https://oauth2.googleapis.com/token`  | none (form body: the authorization-code grant with the PKCE verifier, or the refresh grant)                 |
| `POST https://oauth2.googleapis.com/revoke` | none (form body: `token`; the documented `?token=` form is never used) [YR11]                               |
| `GET …/youtube/v3/channels`                 | `part=snippet,statistics,contentDetails`, `mine=true`, `maxResults=50` (exact)                              |
| `GET …/youtube/v3/playlistItems`            | `part=contentDetails`, `playlistId`, `maxResults` 1–50, optional `pageToken` (printable ASCII)              |
| `GET …/youtube/v3/videos`                   | `part=snippet` or `snippet,statistics`, `id` = 1–50 distinct video ids                                      |
| `GET youtubeanalytics…/v2/reports`          | `ids=channel==MINE`, `startDate`, `endDate` (date keys), `metrics` = the exact list below, `dimensions=day` |

Refused: every other path or host (search, comments, captions, writes), any other report
(another channel id, a content owner, filters, other dimensions or metrics, revenue), API keys
and any token parameter (also on the revocation endpoint).

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
- **Identity:** the channel id is `connections.externalUserId` and the credential's `channelId`.
  No `displayName` is stored (Checkpoint 3b: a connection row outlives the channel's data), and
  discovery stores no handle. No `openid`, email or profile data is requested. Reconnecting a
  different channel into a connection is an `identity_mismatch`.
- **Granular consent:** without `youtube.readonly` the exchange fails
  (`identity:youtube_scope_missing`, nothing is requested from the Data API); without
  `yt-analytics.readonly` the connection is created and lists it in `missingScopes`.
- **Stored credential:** `{kind:"youtube", v:1, refreshToken, clientId, channelId, issuedAt, scopes}`,
  encrypted. No expiry and no refresh job: access tokens are minted per call.
- **Lifecycle:** `invalid_grant` (revoked in the Google account, expired, or the 7-day expiry of
  Google's Testing mode) on any call is `auth`: the sync engine moves the connection to
  `needs_reauth`; reconnecting the same channel makes it active again.
- **Disconnect** revokes at Google, deletes the credential, drops discovery and hard-deletes the
  channel's stored data; **unlink** hard-deletes it too ([Retention](#retention-checkpoint-3b)).
- **D28b stages:** `config`, `token_exchange`, `identity`; the allowlisted codes are listed in
  `connections/oauthDiagnostics.ts`.

## Operations (sync)

| Operation             | Requests                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `getAccount`          | 2: token + `channels.list?mine=true` (the channel must be owned by the authorization)            |
| `listPosts`           | first page 4: token + channel (uploads playlist) + `playlistItems.list` + `videos.list`; later 3 |
| `fetchPostMetrics`    | like `listPosts`, with `videos.list` statistics; ends at the first upload before the window      |
| `fetchAccountMetrics` | 2: token + ONE `reports.query` for the whole window (≤ 31 days); one record per requested day    |

Before any request, every operation checks the configuration (`youtube_config_invalid`,
`unknown`), the credential shape and OAuth client (`auth`), and that the requested channel is the
credential's channel (`permission` / `account_mismatch`). Access tokens are minted per call from
the stored refresh token and kept in memory only. `fetchAccountMetrics` also fails as
`permission` / `analytics_scope_missing` before any request when the connection was granted
without `yt-analytics.readonly` (the channel is then blocked until it is reconnected).

**Quota (estimate, default 10,000 Data API units per project per day):** a 500-upload channel
costs about 70 units for the hourly incremental runs (3 per run) plus about 25 for the daily
lookback (listing and snapshot pages): roughly 100 channels per Google Cloud project. Day
reports use the separate Analytics API (1 request per window) [PROVISIONAL YR14].

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

**Video lifetime statistics** (`fetchPostMetrics`, uploads published in the last 90 UTC days, one
snapshot per upload per UTC capture day):

| `videos.list` statistics | Snapshot column | Notes                                                    |
| ------------------------ | --------------- | -------------------------------------------------------- |
| `viewCount`              | `views`         | [doc] uint64 string; malformed = `data` error            |
| `likeCount`              | `likes`         | absent when the owner hides likes: stays absent, never 0 |
| `commentCount`           | `comments`      | absent when comments are disabled: stays absent, never 0 |

`dislikeCount` and `favoriteCount` are never read.

**Channel day report** (`fetchAccountMetrics`, `ids=channel==MINE`, `dimensions=day`):

| Report metric                          | Stored as                        | Notes                                          |
| -------------------------------------- | -------------------------------- | ---------------------------------------------- |
| `views`                                | `views` (canonical column)       |                                                |
| `likes`, `comments`, `shares`          | `extras` under the same names    |                                                |
| `estimatedMinutesWatched`              | `extras.estimatedMinutesWatched` | YouTube's value; never our estimate            |
| `averageViewDuration`                  | `extras.averageViewDuration`     | seconds, YouTube's per-day value; not additive |
| `subscribersGained`, `subscribersLost` | `extras` under the same names    | the net change is never calculated             |

- **Days:** YouTube's Pacific Time day keys, stored unchanged (DST days of 23 and 25 hours are one
  key each; nothing is converted to an instant). Windows end 3 days before today (UTC).
- **Missing is never zero:** a requested day without a row is stored as synced with no values
  ("not reported"); a requested metric the table leaves out, or a null cell, is absent; an
  explicit 0 stays 0 [PROVISIONAL YR13].
- **Fail closed (`data`):** an unknown column, a duplicate or out-of-window day, a row of the
  wrong width, or a value that is not a non-negative integer.
- **Never requested:** `dislikes`, `engagedViews`, `averageViewPercentage` (a ratio),
  `videosAddedToPlaylists`, revenue, demographics, traffic sources. **Never stored:** a follower
  change, reach, accounts engaged or total interactions.

## Policy and the organic analytics

The YouTube API Services Developer Policies (III.E.4.h) forbid creating derived data or metrics;
Google's Developer Policies Guide lists simple sums and averages of YouTube data as acceptable,
while engagement ratios and custom scores need the III.L program (Checkpoint 3 policy review,
[ADR 0016](../adr/0016-youtube-organic.md#open-compliance-questions)).
Until the open questions are answered:

- the sync stores only values YouTube reports, under their own names;
- `v1/youtubeAnalytics` (Checkpoint 4) exposes them one channel at a time:
  - `channelDays`: day by day on Pacific Time days;
  - `videos` / `video`: lifetime statistics on UTC capture days;

  nothing is summed, averaged, compared or combined
  ([docs/analytics.md](../analytics.md#youtube-analytics-adr-0016-checkpoint-4));

- `v1/organicAnalytics` does **not** aggregate YouTube:
  - a single YouTube account reads as `unsupported` with no values;
  - a selection of several accounts that includes a YouTube channel is refused
    (`platform_not_aggregated`);
  - org-wide totals leave YouTube out (`convex/analytics/organic/queries.ts`);
- `v1/socialPosts` still lists YouTube videos with their own lifetime snapshots (no
  aggregation). `v1/youtubeAnalytics:videos` is the YouTube-specific view: YouTube's metric
  names only, and no Instagram metric or KPI.

## Retention (Checkpoint 3b)

`convex/connections/youtubeRetention.ts`, constants `YOUTUBE_RETENTION` in
`convex/connections/config.ts`. Policy basis: YouTube API Services Developer Policies III.D.2.3
and III.E.4 (last updated 2026-10-15).

**25 days is our conservative operational cutoff, not a deadline the policy states.** The policy
asks for a re-check of authorization, and a refresh or deletion of metadata, within 30-day
intervals, and for deletion within 30 days after a revocation in Google's settings. 25 days
leaves room for a failed daily run before the 30 days are reached.

### What a purge deletes

A purge HARD-deletes one YouTube channel's stored data, in this order:

1. its videos, each after its lifetime snapshots;
2. its day rows;
3. its sync tasks and runs;
4. its sync state;
5. the channel row, last.

Deleting the channel row last keeps the resume marker until everything else is gone. Each step
deletes at most 500 rows and schedules the next one. A chain of steps stops after 1,000 steps,
and the hourly sweep resumes every channel still marked (status `disconnected`). Every step
re-reads what is left, so repeated, retried or overlapping runs never delete anything twice.

A purge never touches:

- an Instagram row, or a row of another org (each row's platform and org are re-verified);
- the connection row or the credential (the connection lifecycle owns those);
- the audit log.

### When a purge starts

| Trigger                                       | Reason recorded          | When the deletion runs                               |
| --------------------------------------------- | ------------------------ | ---------------------------------------------------- |
| `v1/connections:disconnect`                   | `disconnected`           | at once; Google revocation through the existing flow |
| `v1/connections:unlinkSocialAccount`          | `unlinked`               | at once; the grant stays (other channels unaffected) |
| daily check, `invalid_grant` from Google      | `authorization_invalid`  | at once                                              |
| daily check, the channel is not owned         | `channel_not_authorized` | at once                                              |
| daily check, no stored credential             | `credential_missing`     | at once                                              |
| daily check, connection `revoked`             | `disconnected`           | at once                                              |
| daily check, a stale channel already unlinked | `unlinked`               | at once                                              |

Disconnect and unlink mark the channel and unlink it in the admin's own transaction. The
policy allows 7 days after an in-app revocation; we delete at once.

**Relinking while a purge is pending** is refused (`CONFLICT`, `reason: "purge_pending"`). Once
the purge has completed, the channel links as a new row and is backfilled from scratch. No
partially deleted history is ever resumed.

**In-flight sync work** never writes after a purge has started:

- the purge cancels the channel's active run;
- a page fetched before an unlink is refused at commit, because the engine checks the linkage
  in the commit's own transaction;
- a commit after the run's rows are gone finds no claim.

Tests cover both orders.

### Daily authorization check: the exact decision logic

**Candidates.** Linked channels with status `active` whose authorization was last confirmed more
than 25 days ago. `socialAccounts.lastSeenAt` records the last confirmation. It is set by:

- every successful sync preflight (a fresh token plus `channels.list?mine=true`);
- linking;
- a check that found the channel.

A channel that syncs normally is never checked. A channel whose sync stopped (`needs_reauth`,
blocked, failing) is checked once a day until the check concludes.

**The check.** One fresh token from the stored refresh token, plus `channels.list?mine=true`,
through the existing discovery: 2 requests, and the token stays in memory. It runs also for
`needs_reauth` connections (`allowNeedsReauth`).

**Before acting.** The check and the purge each re-verify that the channel is still active,
linked, YouTube, of the same org, and still unconfirmed since the cutoff. A sync that confirmed
the authorization in the meantime wins: the check is skipped.

| Outcome                                                                                                                                                             | Result                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| the channel is returned                                                                                                                                             | authorized: `lastSeenAt` = now, nothing else changes |
| Google's token endpoint answers `invalid_grant` (HTTP 4xx)                                                                                                          | **confirmed** `authorization_invalid`: purge         |
| the channel is not among the authorization's channels (`account_mismatch`)                                                                                          | **confirmed** `channel_not_authorized`: purge        |
| no credential is stored, or the connection row is gone                                                                                                              | **confirmed** `credential_missing`: purge            |
| the connection is `revoked`                                                                                                                                         | **confirmed** `disconnected`: purge                  |
| network error, timeout, any 5xx (also an OAuth error with 5xx)                                                                                                      | inconclusive (`transient`)                           |
| quota or rate limit (`quotaExceeded`, `rateLimitExceeded`, 429)                                                                                                     | inconclusive (`rate_limited`)                        |
| our configuration: `invalid_client`, `unauthorized_client`, `youtube_config_invalid`                                                                                | inconclusive (`unknown`)                             |
| any other `auth` or `permission` code (`authError` 401, `credential_invalid`, `client_id_mismatch`, `insufficientPermissions`, `channelClosed`, `channelSuspended`) | inconclusive (`auth` / `permission`)                 |
| any other kind (`not_found` such as `channelNotFound`, `invalid_request`, `data`), an undecryptable credential, an internal error                                   | inconclusive (that kind / `internal`)                |

An inconclusive check:

- keeps every row;
- writes an audit entry `socialAccount.authorization_check_inconclusive` with the failure kind
  and an allowlisted code (`[A-Za-z0-9_:]{1,64}`) only;
- is retried by the next daily run.

`invalid_grant` means that Google refused the refresh token: it was revoked, it expired, or it
hit the 7-day Testing-mode expiry. **We never claim which.** In particular, an outcome never
claims that the user revoked access in Google's settings, only that the token can no longer be
refreshed (III.D.2.3's "users whose tokens cannot be refreshed").

### Videos no listing has refreshed

The hourly sweep deletes YouTube videos whose `lastSeenAt` is more than 25 days old, together
with their snapshots. The daily lookback runs a full listing that refreshes every listed upload.
Before deleting, the sweep re-verifies that the row is a YouTube row, and that the owning channel
is a YouTube channel of the same org.

**Absence from the listing is not evidence that a video was deleted on YouTube.** The sweep
records no audit entry and makes no such claim. It deletes the row because its metadata can no
longer be refreshed (III.E.4.c), whatever the reason. The reasons are:

- the video was deleted or made unavailable;
- the channel's sync stopped (the channel's analytics days stay while its authorization is
  confirmed);
- the video is beyond the **5,000-upload listing cap** (`maxListingPages`).

A consequence of the cap: on a channel with more than 5,000 uploads, the oldest uploads are never
stored. Uploads that a newer upload pushes past the cap are deleted 25 days after their last
listing, with their lifetime snapshots, even though they still exist on YouTube.
`v1/socialPosts` then lists at most the newest 5,000 uploads.

### Identifiers that remain after a purge

| Where                                                             | What                                       | Why it is kept                                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connections.externalUserId` (revoked or active connection row)   | the channel id                             | the connection's identity: a reconnect of the same channel reuses the row, a different channel is an `identity_mismatch`; audit entries refer to the row |
| `discoveredSocialAccounts` (unlink only, connection still active) | the channel id and account type, no handle | the admin can link the channel again without a new consent; deleted on disconnect                                                                        |
| audit log                                                         | Convex row ids, reasons, kinds, counts     | the deletion record itself; it holds no YouTube id, title, handle, token or error text                                                                   |

Nothing else remains:

- the connection stores no channel title; disconnect also clears a `displayName` stored by an
  earlier version;
- the credential is deleted on disconnect;
- `syncRuns` (with their errors) and `syncAccounts` go with the purge.

The purge's audit counts are the rows deleted by the chain that completed the purge. A chain that
was interrupted and resumed reports only what it deleted itself.

### Deletion requests (operational runbook)

A user who asks for their YouTube data to be deleted (III.E.4.g: within 7 days) gets it through
the existing admin API until the dashboard offers it.

**An in-product deletion path must be provided in the dashboard phase (Checkpoint 5).**

1. Identify the org and the channel's `socialAccounts` id (`v1/socialAccounts:list` as an org
   admin). Confirm that the requester is entitled to the channel's data.
2. Delete:
   - **everything, and revoke Google access:** `v1/connections:disconnect` with the YouTube
     connection id;
   - **one channel, keeping the connection:** `v1/connections:unlinkSocialAccount` with the
     `socialAccountId`.
3. Verify. The audit log holds `socialAccount.purge_started` with the reason, then
   `socialAccount.purged` with the counts. `socialAccounts`, `socialPosts`,
   `socialPostMetricSnapshots`, `socialAccountMetricsDaily`, `syncRuns` and `syncAccounts` hold
   no row for that `socialAccountId`. For a large channel the purge may take a few minutes;
   `socialAccount.purged` marks completion. If the sweep is still resuming after an hour,
   check the Convex logs.
4. After a disconnect, the connection row keeps only the channel id (see above). Removing it too
   is not supported yet (open question in ADR 0016).
5. Record the request date and the `socialAccount.purged` time in the support ticket.

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
| post metrics               | `views`, `likes`, `comments`                | [doc] `videos.list` statistics           |
| account metrics            | `views` (+ the reported extras)             | [doc] the channel day report             |
| snapshot window            | 90 days                                     | ours (Y-D8)                              |
| snapshot page              | 50 (1,000 per task; truncation is reported) | [doc] / ours                             |
| listing page               | 50                                          | [doc] Data API page limit                |
| listing pages              | 100 (5,000 uploads; truncation is reported) | ours                                     |
| requests per provider call | 4                                           | token + channel + playlistItems + videos |
| account-metric horizon     | 395 days                                    | ours (Y-D7)                              |
| account-metric lookback    | 7 days                                      | ours (Y-D7) [YR9]                        |
| account-metric delay       | 3 days (`accountMetricsDelayDays`)          | [doc] 48–72 h latency                    |
| account-metric chunk       | 31 days = 1 report                          | ours                                     |

## Mock mode

`PROVIDER_MODE=mock` resolves the mock YouTube OAuth spec, discovery and provider (no network,
no Google credentials): instant consent with PKCE (`mock-yt-code.<user>.<fingerprint>`), one
upload every second UTC day for 180 days, every 8th an `upcoming` premiere; lifetime statistics
grow with age (one slot hides likes, one disables comments, today's upload has 0 views); day
reports skip every 9th day (no row) and report every 11th as zeros. Users:

- data: `<n>` (a channel with a handle), `hidden` (hidden subscriber count), `empty` (no
  uploads), `edge` (an upload without a publish time);
- consent: `limited` (`yt-analytics.readonly` unticked: day reports fail as `permission`),
  `noyoutube` (`youtube.readonly`
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
| YR13 | the report returns a row for days without activity; how late processing shows; value types   |
| YR14 | quota use per channel per day in real use                                                    |

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
