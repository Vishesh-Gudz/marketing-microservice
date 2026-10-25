# ADR 0016 — YouTube organic provider

- Status: Checkpoint 1 (provider foundation: channel and video metadata) implemented and tested
  against mock and fake data only. Checkpoints 2–6 (OAuth and connection, analytics sync,
  retention, public API, dashboard, verification) are planned. Nothing was validated against a
  real YouTube channel (YR1–YR9 provisional).
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
- The default registry (discovery, OAuth spec) and the connection provider are Checkpoint 2, so
  no YouTube account can be connected or synced yet.

## Open compliance questions (to settle before Checkpoints 3, 3b and 4)

- **Derived metrics (Developer Policies III.E.4.h, III.L):** whether summing daily values over a
  range, period totals and period-over-period comparisons count as "derived data or metrics".
  Until confirmed, only metrics YouTube reports directly are exposed and nothing is calculated.
- **Retention (III.D, III.E.4.b/c/g):** the exact deletion deadlines after an in-app disconnect,
  a revocation on Google's side and a user deletion request, and the 30-day refresh-or-delete
  rule for metadata. Re-verified against the current policy before Checkpoint 3b.
- **Production use:** OAuth app verification (whether the scopes are "sensitive" is unconfirmed),
  the privacy-policy and Terms-of-Service requirements (III.A) and branding.

## Consequences

- Organic analytics stays one architecture: the planner, sync engine, write path and analytics
  gain YouTube through the existing capability-driven contract, not a second framework.
- Before production use, every YR item must be checked on a real channel
  ([docs/providers/youtube.md](../providers/youtube.md#real-channel-validation-required)).
- One schema inventory assertion changed additively (`socialAccounts.platform` includes
  `youtube`).
