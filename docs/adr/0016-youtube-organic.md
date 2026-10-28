# ADR 0016 — YouTube organic provider

- Status: Checkpoints 1 (provider foundation), 2 (OAuth and account connection), 3 (analytics
  sync and storage, after the policy review), 3b (retention and deletion) and 4 (tenant-scoped
  v1 API) implemented and tested against mock and fake data only. Checkpoints 5–6 (dashboard,
  verification) are planned.
  Nothing was validated against a real YouTube channel or a real Google OAuth client (YR1–YR14
  provisional).
- Date: 2026-10-25

## Context

YouTube organic analytics extends the organic social architecture of Phase 10 (ADR 0011): the
`SocialProvider` contract, the social sync subject, the social tables and the organic analytics.
YouTube ads stay Google Ads (placement `youtube`).

- `@opencoredev/social-sdk@0.5.0` has a YouTube adapter, but it needs a ready access token and
  channel id (no OAuth, no refresh, no `channels.list?mine=true` discovery), reads post metrics
  with one `videos.list` request per video, cannot pass `filters` to Analytics reports, retries
  GETs itself and ships write operations (upload, delete, comment moderation).
- The YouTube Analytics API reports days in Pacific Time with 48–72 h of latency; the Data API
  has a daily quota of 10,000 units per Google Cloud project.
- The YouTube API Services Developer Policies restrict derived metrics and require deleting data
  after revocation and refreshing or deleting stored metadata after 30 days.

Details: [docs/providers/youtube.md](../providers/youtube.md).

## Decisions (approved in the Checkpoint 0 plan)

1. **Y-D1 No SDK for YouTube.** A minimal, allowlisted, read-only `fetch` client
   (`convex/providers/youtube/client.ts`) in the style of the Google Ads client. It runs in both
   runtimes; the social worker resolves the provider through `providers/social/nodeRegistry.ts`
   like every social sync provider. No new `"use node"` file.
2. **Y-D2 Own connection provider `youtube`** (Checkpoint 2), separate from `google_ads`, as
   Instagram is separate from Meta. The identity is the channel id from
   `channels.list?mine=true`; no `openid`, no email. Every YouTube account is a `channel`
   (new `SOCIAL_ACCOUNT_TYPES` value).
3. **Y-D3 Dedicated Google OAuth client** `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`, in its
   own Google Cloud project: Google documents that revocation "removes all OAuth 2.0 scopes
   previously granted to a project", so sharing the Google Ads client or project could revoke
   Google Ads grants on a YouTube disconnect.
4. **Y-D4 Scopes** `youtube.readonly` and `yt-analytics.readonly` (Checkpoint 2), PKCE S256,
   offline access, `prompt=consent`, `include_granted_scopes=false`.
5. **Y-D5 Tokens:** the refresh token is encrypted in the credential store; access tokens are
   minted per provider call and kept in memory only. No refresh cron. `invalid_grant` or HTTP
   401 is `auth` and moves the connection to `needs_reauth`.
6. **Y-D6 Day basis** (Checkpoints 3–4): YouTube reporting days (Pacific Time) are stored as
   reported; the organic DTO `timezone` is widened additively; account sets spanning platforms are
   refused by `organicAnalytics:overview`.
7. **Y-D7 Reporting delay** (Checkpoint 3): an optional `accountMetricsDelayDays` capability so
   lagging days stay unknown; lookback 7 days, horizon 395 days, 31-day chunks.
8. **Y-D8 Metrics** (Checkpoint 3): only values YouTube reports; no derived values until the
   policy questions below are settled.
9. **Y-D9 Videos:** the uploads playlist (`playlistItems.list`) plus `videos.list`; every upload
   is a `video` (the Data API identifies no Short); the title is the caption (at most 100
   characters); description, tags and thumbnails are never stored; the permalink is built as
   `https://www.youtube.com/watch?v=<id>` and is the only URL; public, unlisted and private
   uploads are ingested; `upcoming` broadcasts are excluded.
10. **Y-D10 Retention** (Checkpoint 3b): disconnect and unlink delete the channel's data; stale
    metadata is refreshed or deleted after 30 days. The current policy text is re-verified first.
11. **Y-D11 Connect UI** on `/connections` (Checkpoint 5).
12. **Y-D12 Mock:** a deterministic mock YouTube provider in `PROVIDER_MODE=mock` that serves
    raw-shaped data through the REAL YouTube mapping (`providers/social/mock/youtube*.ts`).

### Checkpoint 1 (implemented)

- `SOCIAL_PLATFORMS` gains `youtube` and `SOCIAL_ACCOUNT_TYPES` gains `channel` (additive
  validator widening of the social tables, `discoveredSocialAccounts` and `syncRuns.platform`; no
  migration, existing rows unchanged).
- The provider implements `getAccount` (token + `channels.list?mine=true`: the channel must be
  owned by the authorization, re-checked on every sync) and `listPosts` (uploads playlist,
  50 per page). Capabilities declare no metric, so the planner never plans a metric task;
  `fetchPostMetrics` / `fetchAccountMetrics` fail as `unsupported` before any request.
- `providers/social/validate.ts` adds the YouTube id, handle, permalink and title rules;
  Instagram rules are unchanged.
- The default registry (discovery, OAuth spec) and the connection provider were left to
  Checkpoint 2.

### Checkpoint 2 (implemented)

- `CONNECTION_PROVIDERS` and `SOCIAL_CONNECTION_PROVIDERS` gain `youtube` (additive validator
  widening of `connections`, `oauthStates`, `oauthGrants`; no migration). The generic OAuth
  state, PKCE, S2 claim, encrypted credential store, discovery and disconnect paths are reused
  unchanged.
- `providers/youtube/oauth.ts` (PKCE S256, offline, `prompt=consent`,
  `include_granted_scopes=false`, both scopes required, the consent's single channel as
  identity, revocation in the form body), `discovery.ts`, and `session.ts` (the config,
  credential and token-minting checks shared with the sync provider).
- `CLIENT_ENV.youtube` reads `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`, plus `GOOGLE_CLIENT_ID`
  only to refuse a client shared with Google Ads. Google Ads behavior is unchanged.
- Registered in every `PROVIDER_MODE` (mock OAuth spec and discovery in mock mode). A linked
  channel's metadata syncs through the existing engine; `invalid_grant` moves the connection to
  `needs_reauth`. The token refresh job is unchanged and never sees YouTube.
- D28b diagnostics allowlist the YouTube codes; the dashboard's reconnect notice names YouTube
  (read-only until Checkpoint 5).

### Checkpoint 3 (implemented)

- **Policy review first** (2026-10-25; YouTube API Services Developer Policies, last updated
  2026-10-15; Developer Policies Guide and "Additional policies for derived metrics and data
  storage", both last updated 2026-09-14). Findings below.
- `fetchAccountMetrics`: ONE `reports.query` per window (`ids=channel==MINE`, `dimensions=day`,
  views, likes, comments, shares, estimatedMinutesWatched, averageViewDuration,
  subscribersGained, subscribersLost); one record per requested day; each value under its own
  YouTube name (`views` in the column, the rest in `extras`). No follower change, ratio or
  estimate is stored. Without the `yt-analytics.readonly` grant the task fails as `permission`
  before any request.
- `fetchPostMetrics`: `videos.list` statistics (views, likes, comments) of the uploads published
  in the last 90 UTC days, 50 per request; hidden or disabled counts stay absent.
- The optional capability `accountMetricsDelayDays` (YouTube 3) ends account-metric windows
  before the platform's processing latency; Instagram declares none and is unchanged.
- Pacific Time day keys are stored unchanged; DST days are single keys.
- **Read guard:** `convex/analytics/organic/queries.ts` reads YouTube accounts as `unsupported`
  and never reads their day rows; org-wide totals leave them out. YouTube values are therefore
  never summed, compared or combined with Instagram's until Checkpoint 4 settles the questions
  below. (This also closes the org-wide follower total, which would otherwise have added the
  YouTube subscriber captures that Checkpoint 2's preflight already stores.)

### Checkpoint 3b (implemented)

Retention and deletion (`convex/connections/youtubeRetention.ts`; the exact rules are in
[docs/providers/youtube.md](../providers/youtube.md#retention-checkpoint-3b)).

- **Disconnect and unlink hard-delete** the channel's stored data: videos, snapshots, day rows,
  sync runs, tasks and state, then the channel row. Disconnect also revokes at Google through the
  existing flow. The deletion is bounded (500 rows per step), resumable (the hourly sweep resumes
  every channel still marked `disconnected`) and idempotent.
- **A sync that is in flight never writes after an unlink.** The engine's linkage check refuses
  the commit, and the active run is cancelled. Relinking while a purge is pending is refused
  (`purge_pending`).
- **Daily authorization check** of every linked channel whose authorization (`lastSeenAt`) was
  last confirmed more than 25 days ago. 25 days is our conservative operational cutoff, not a
  policy deadline. Only a confirmed failure purges:
  - `invalid_grant`;
  - the channel is not owned;
  - no credential;
  - a revoked connection.

  Network errors, outages, quota and configuration errors are inconclusive: the data is kept, the
  outcome is audited and the check is retried daily.

- **Stale videos:** the hourly sweep deletes videos that no listing has refreshed for 25 days,
  with their snapshots. It never claims that a video was deleted on YouTube; the 5,000-upload
  listing cap is one documented cause.
- **Minimized identifiers:**
  - the connection no longer stores the channel title (`displayName`), and disconnect clears an
    old one;
  - discovery no longer stores the handle;
  - retention audit entries carry row ids, reasons, kinds and counts only.
- **Two approved global indexes** (`socialAccounts.by_platform_status_seen`,
  `socialPosts.by_platform_seen`): the system jobs have no tenant caller, and every row read
  through these indexes is re-verified (platform, org) before any deletion.
- **Deletion requests:** an operational runbook (admin API) is in place. **An in-product deletion
  path must be provided in the dashboard phase (Checkpoint 5).**

### Checkpoint 4 (implemented)

The tenant-scoped v1 API for YouTube: `v1/youtubeAnalytics`
([docs/analytics.md](../analytics.md#youtube-analytics-adr-0016-checkpoint-4)).

- **One channel per request, values as reported.** Every function takes one channel or one
  video. Nothing is summed, averaged, compared, ranked or combined, across days, channels or
  platforms, and no rate, percent change or score exists. The open questions below decide
  whether that may change.
- **`channelDays`:** one entry per Pacific Time day (`timezone: "America/Los_Angeles"`), with
  YouTube's own metric names:
  - each day has a `status` of `reported`, `not_reported` or `unknown`;
  - the response gives the data state of the range, the coverage, the reporting delay (3 days)
    and the channel's analytics grant (`analyticsAccess`: `granted`, `scope_missing`,
    `reauth_required`, `not_linked` or `unknown`);
  - the subscriber captures stored on the same rows are UTC capture days and stay out of the
    day series.
- **`videos` / `video`:** lifetime `videos.list` statistics (views, likes, comments) on our UTC
  capture days. Hidden or disabled counts are `not_reported`, never 0. No Instagram-only metric
  and no KPI appears.
- **The organic aggregation still never aggregates YouTube.** A single YouTube account in
  `v1/organicAnalytics` stays `unsupported`; org-wide totals leave YouTube out. An explicit
  selection of several accounts that includes a YouTube channel is refused (`INVALID_ARGUMENT`,
  `platform_not_aggregated`). Before this checkpoint, such a mixed selection returned the
  Instagram sums labelled `unsupported`. Instagram-only requests are unchanged.

## Policy review findings (Checkpoint 3)

- **III.E.4.h:** no API Data replaced by independently calculated data and no "new or derived
  data or metrics"; own metrics only with a clear disclosure.
- **Developer Policies Guide, "Acceptable metrics":** simple calculations on YouTube API data
  only (addition, subtraction, averages, multiplication, division), e.g. "Average daily views in
  a month", "Total views in a group of videos/channels", "Number of subscribers gained or
  lost", graphs of increases. Not acceptable: estimating watch time or unique reach, custom
  scores from averages or ratios, totals that differ from YouTube's, merging with other data.
- **III.L (opt-in, audited analytics developers):** custom channel scores and ratios (e.g.
  engagement ratios, growth rates) and 36-month statistics storage. This service is not in it.
- **III.E.2 / III.E.3.b:** aggregation only across channels of the same content owner, viewable
  only by that owner; Authorized Data only for the authorizing user or agents they approved.
- **III.E.4.b/c/e/f:** analytics and statistics may be stored as long as necessary with a 30-day
  authorization re-check (and a 30-day check that each video still exists); other authorized data
  (titles, metadata) must be refreshed or deleted after 30 days; show current data, historical
  data accurately in its time context.
- **III.D.2.3 / III.E.4.g:** in-app revocation → revoke at Google and delete authorized data within
  7 days; revocation in Google's settings → delete the user's API data within 30 days; delete the
  data of users whose tokens cannot be refreshed; user deletion requests within 7 days.

## Open compliance questions

1. Is the Guide's "acceptable metrics" list authoritative next to III.E.4.h, i.e. may a
   date-range total be summed from stored daily rows?
2. Are period-over-period percent changes simple calculations or III.L "ratios"? (Absolute
   differences are subtraction.)
3. What does "content owner" (III.E.2) mean for ordinary channels; may one organization sum
   channels of different owners?
4. Are an organization's members "agents expressly approved" (III.E.3.b) by the person who
   connected the channel; is explicit consent wording needed at connect time?
5. Is a 395-day history "as long as necessary"? (Checkpoint 3b answered the second half by
   design: every row of a channel goes on disconnect and on unlink.)
6. Do the sync preflight and the daily check (each a fresh token plus `channels.list?mine=true`)
   satisfy the 30-day authorization re-check? Checkpoint 3b assumes so.
7. Should the service apply for III.L (audit + quota extension) for ratios and growth metrics?
8. Production: OAuth verification (whether the scopes are "sensitive" is unconfirmed), privacy
   policy and Terms-of-Service links (III.A), branding (III.F.2), quota extension via the API
   Compliance Audit (III.D.3).
9. (Checkpoint 3b) An authorization check can stay inconclusive for days, for example after our
   own misconfiguration or a long outage. The data is kept and the outcome is audited daily, but
   nothing alerts an operator yet. Is there a maximum time after which unconfirmed data must go
   anyway?
10. (Checkpoint 3b) A closed or suspended channel (`channelClosed`, `channelSuspended`) is
    inconclusive today, not a confirmed deauthorization. Should it purge?
11. (Checkpoint 3b) A revoked connection row keeps the channel id (`externalUserId`) without
    limit, for reconnect identity and for the audit trail. Is a channel id "Authorized Data" that
    III.E.4.c requires us to delete or refresh after 30 days? If so, disconnected rows need a
    scrub job.
12. (Checkpoint 3b) For channels with more than 5,000 uploads, the oldest uploads are never stored,
    and uploads pushed past the cap are deleted after 25 days. Is that acceptable for the product,
    or should older uploads be read some other way?
13. (Checkpoint 4, a sync behavior) A channel connected without `yt-analytics.readonly` has its
    whole sync blocked after the first run fails on the day report. Its video statistics stop
    updating, and 25 days later the retention sweep deletes the videos. Should listings and video
    statistics keep syncing when only the analytics scope is missing? That would be a change to
    the sync implementation, not the API.

Until answered: only metrics YouTube reports are stored and exposed (one channel at a time,
through `v1/youtubeAnalytics`), nothing is derived, there is no multi-channel or cross-platform
aggregation, and there are no period totals or comparisons for YouTube. Nothing in this service
claims that such totals or comparisons are policy-approved.

## Consequences

- Organic analytics stays one architecture: the planner, sync engine, write path and analytics
  gain YouTube through the existing capability-driven contract, not a second framework.
- Before production use, every YR item must be checked on a real channel
  ([docs/providers/youtube.md](../providers/youtube.md#real-channel-validation-required)).
- One schema inventory assertion changed additively (`socialAccounts.platform` includes
  `youtube`).
- YouTube rows are the only synced rows that are hard-deleted: other platforms keep their rows
  on unlink and disconnect, and sync itself never deletes. The approved global index list grows
  by two (Checkpoint 3b).
