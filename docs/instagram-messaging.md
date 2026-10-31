# Instagram direct messages

Instagram DMs for the org's linked Instagram professional accounts, on the Instagram API with
Instagram Login. Decisions: [ADR 0017](adr/0017-instagram-messaging.md). The analytics
connection it builds on: [providers/instagram.md](providers/instagram.md).

**Status:** implemented and tested in-process only (IM1–IM6), against signed fake deliveries and
a fake Instagram API built from Meta's documented examples, and once in a browser against a
local mock deployment (IM5). Nothing has run against Meta: no Meta app is configured to call
these endpoints, none of the env vars below is set on any deployment, and
`instagram_business_manage_messages` has no App Review. Everything marked [assume] waits for the
[real-account checklist](#real-account-validation-required).

## Endpoints

All under `<CONVEX_SITE_URL>` (`convex/http.ts`). Nothing here logs; responses carry only a
status line (or the documented JSON).

### Webhook: `/instagram/webhook` (IM2)

| Request                  | Result                                                     |
| ------------------------ | ---------------------------------------------------------- |
| GET, valid handshake     | 200, body = `hub.challenge`                                |
| GET, anything else       | 403 (also when `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` is unset)  |
| POST, secret not set     | 503 (Meta retries later)                                   |
| POST, bad Content-Length | 400                                                        |
| POST, body > 3 MiB       | 413                                                        |
| POST, bad signature      | 401 (`X-Hub-Signature-256`, HMAC-SHA256 over the raw body) |
| POST, malformed envelope | 400                                                        |
| POST, stored             | 200 (idempotent; unrouted events are counted and dropped)  |

### Deauthorize and data deletion (IM6)

| Request                                                | Result                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| POST `/instagram/deauthorize`, verified                | 200 `OK`: every active connection of the user -> `needs_reauth`; DMs stop (30-day grace) |
| POST `/instagram/data-deletion`, verified              | 200 `{"url": "<status page>", "confirmation_code": "<20 chars>"}`; deletion starts       |
| GET `/instagram/data-deletion/status?code=…`           | 200 plain-text status (code, received, state below, what is deleted); 404 otherwise      |
| POST, `INSTAGRAM_CALLBACK_APP_SECRET` not set          | 503, nothing read                                                                        |
| POST data-deletion, no https `CONVEX_SITE_URL`         | 503 (loopback http is accepted on a local deployment)                                    |
| POST, bad Content-Length / body > 8 KB                 | 400 / 413                                                                                |
| POST, no `signed_request` form field                   | 400 (urlencoded or multipart form)                                                       |
| POST, bad signature                                    | 401                                                                                      |
| POST, payload not `HMAC-SHA256` / no decimal `user_id` | 400                                                                                      |

`signed_request` is Meta's documented format: `base64url(HMAC-SHA256(payload segment, secret))`
`.` `base64url(JSON {algorithm, expires, issued_at, user_id})`, verified before the payload is
decoded. A repeated delivery of the same signed request gets the same confirmation code (the
request key is an HMAC of the payload under the callback secret). A callback issued
(`issued_at`) more than 5 minutes before a connection's current authorization
(`connections.authorizedAt`) does not apply to that connection. More than 50 matching
connections per lookup answers 500 (Meta retries) rather than handling only some.

What a data-deletion request deletes, in every org with an Instagram connection of that user:
the connection's credential (the connection row stays, with its Instagram identity erased), its
unclaimed OAuth grants, the Instagram account's stored analytics (posts, snapshots, daily
metrics, sync history) and the account row, and its direct messages (webhook events, messages,
conversations) and the messaging accounts recorded when the org's part started (never one
created later). Each org's part runs in its own mutations (one org's failure never blocks
another's), in bounded steps that resume themselves (every 30 s while waiting; the hourly sweep
resumes pending requests, oldest `nextAttemptAt` first). While it runs, linking the account
again is refused (`CONFLICT purge_pending`). A connection authorized again after the request is
a new consent: its identity and credential are kept.

**Status** (`instagramDataDeletionRequests.status`, shown on the status page):

| Status              | Meaning                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pending`           | Deletion is running                                                                                                           |
| `review`            | Every part is done, but an older (pre-IM6) Instagram connection exists somewhere; the page says older connections are checked |
| `completed`         | Set ONLY by verification: every part done AND a full scan finds no older Instagram connection anywhere                        |
| `closed_unverified` | An operator closed the review without full verification; the page says so and never says "Completed"                          |

**One unresolved older Instagram connection anywhere blocks the automatic completion of ALL
deletion requests** (they stay `review`, or `closed_unverified` after an operator closure,
until every older connection is reconnected or erased). An older connection is one without a
recorded scoped id (connected before IM6) whose identity is not erased: Meta's callback cannot
be matched to it, so it may hold the requester's data. Since IM6 every connect records the id,
so this set only shrinks.

## Configuration (Convex environment variables)

| Variable                                   | Purpose                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | The Instagram app (Instagram Login), as for analytics                                              |
| `INSTAGRAM_WEBHOOK_APP_SECRET` (secret)    | The ONLY secret that verifies webhook deliveries; no fallback (RI1: which secret Meta uses)        |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`           | The verify token you also enter in the App Dashboard                                               |
| `INSTAGRAM_CALLBACK_APP_SECRET` (secret)   | The ONLY secret that verifies the deauthorize / data-deletion `signed_request`; no fallback (RI14) |
| `INSTAGRAM_MESSAGING_ENABLED`              | Exactly `true` opens asking for the permission, `enable` and `retrySetup` on cloud deployments     |
| `INSTAGRAM_LOGIN_CONFIG_ID`                | Set: Instagram API with Unified Login (below) instead of Instagram Login                           |

Local deployments and tests are open without `INSTAGRAM_MESSAGING_ENABLED`. Turning messaging
off, disconnecting, the webhook and both callbacks are never gated by it.

## Instagram API with Unified Login (new Meta apps)

Meta apps created since late October 2026 show "API setup with Instagram login is not available
for newer apps" and use **Unified Login**: a Facebook Login for Business configuration that issues
a Business Integration System User access token; every call goes to `graph.facebook.com` with
the Instagram account id. The Instagram provider switches to it when `INSTAGRAM_LOGIN_CONFIG_ID`
is set (unset: Instagram Login, unchanged):

| Variable                       | Value under Unified Login                                    |
| ------------------------------ | ------------------------------------------------------------ |
| `INSTAGRAM_APP_ID`             | The Meta app id                                              |
| `INSTAGRAM_APP_SECRET`         | The Meta app secret (App settings > Basic)                   |
| `INSTAGRAM_LOGIN_CONFIG_ID`    | The configuration id ("API setup with Unified login" step 1) |
| `INSTAGRAM_WEBHOOK_APP_SECRET` | The Meta app secret ([doc] "your app's App Secret")          |

Meta configuration: redirect URL `<CONVEX_SITE_URL>/oauth/callback`; webhooks on the "API setup
with Unified login" tab with callback `<CONVEX_SITE_URL>/instagram/webhook`, the verify token,
and the fields `messages` and `messaging_seen` (the only messaging fields Meta lists for Unified
Login). The configuration needs `instagram_basic` (account lookup) and
`instagram_manage_messages`.

| Step         | Request                                                               | Status        |
| ------------ | --------------------------------------------------------------------- | ------------- |
| Sign-in      | `www.facebook.com/dialog/oauth` with `config_id`, no `scope`          | [doc]         |
| Exchange     | `GET /v26.0/oauth/access_token` (client_id, secret, code, redirect)   | [doc]         |
| Inspect      | `GET /v26.0/debug_token`: valid, this app, `instagram_basic` required | [doc] (Graph) |
| Account      | `GET /v26.0/me/assigned_instagram_accounts?fields=id,username`, one   | [doc]         |
| Subscribe    | `POST /v26.0/{ig-id}/subscribed_apps` (`messages,messaging_seen`)     | [doc]         |
| Send         | `POST /v26.0/{ig-id}/messages`                                        | **[assume]**  |
| Token header | `Authorization: Bearer` on Graph calls                                | **[assume]**  |
| Payload      | `object: instagram`, `entry[].id` = account id, echoes in `messages`  | **[assume]**  |

Differences from Instagram Login: the token never expires and is never refreshed (no expiry is
stored); a Unified connection gets **no organic sync** (its token cannot read
`graph.instagram.com`; a leftover schedule is parked); discovery records the account type as
`business` (PROVISIONAL: `graph.facebook.com` has no `account_type`); there is no platform
revoke (the client removes the app in Business Settings > Integrations > Connected apps). Not
covered yet: the deauthorize / data-deletion callbacks cannot match a Unified connection (no
app-scoped user id), so leave `INSTAGRAM_CALLBACK_APP_SECRET` unset until that is designed.

## Meta configuration (per app, when the user decides to go live)

1. App Dashboard > Instagram > API setup with Instagram business login:
   - permissions: `instagram_business_basic`, `instagram_business_manage_insights`,
     `instagram_business_manage_messages` (App Review and business verification required for
     accounts outside the app's roles);
   - Business login settings: OAuth redirect URI `<CONVEX_SITE_URL>/oauth/callback`, Deauthorize
     callback URL `<CONVEX_SITE_URL>/instagram/deauthorize`, Data deletion request URL
     `<CONVEX_SITE_URL>/instagram/data-deletion`;
   - Webhooks: callback URL `<CONVEX_SITE_URL>/instagram/webhook`, the verify token, fields
     `messages`, `messaging_seen`, `message_edit`.
2. Convex env (`npx convex env set`): the five variables above. Set
   `INSTAGRAM_CALLBACK_APP_SECRET` to the Instagram app secret first; if real callbacks answer
   401, try the Meta app secret (App settings > Basic) and record which one worked (RI14). The
   same applies to `INSTAGRAM_WEBHOOK_APP_SECRET` (RI1).
3. Per org: reconnect Instagram with `instagramMessaging: true`, then turn DMs on in
   `/instagram/messages/settings`.

## Public API (v1, ADR 0017)

Viewers: `listAccounts`, `getAvailability`, `listConversations`, `getConversation`,
`listMessages`. Editors and admins: `sendText`. Admins: `enable`, `retrySetup`, `disable`. Refusals
are fixed codes and reasons; another org's ids are `NOT_FOUND`.

## Operations

- Audit (ids, reasons, counts only): `instagram.messaging_*`, `instagram.data_deletion_requested`,
  `instagram.data_deletion_completed`, `socialAccount.purged`, `credential.deleted`,
  `connection.needs_reauth` with reason `instagram_deauthorized`.
- A deletion request still `pending` after a day needs a look: `instagramDataDeletionRequests`
  (global; Convex ids and the code only) shows which org's part is not `done`.
- **Before deploying IM6/IM7.0, on every deployment:** list the older (pre-IM6) Instagram
  connections (`npx convex run instagram/dataDeletion/requests:listLegacyInstagramConnections
'{"paginationOpts":{"numItems":200,"cursor":null}}'`, following `continueCursor`). Any found
  will hold every deletion request in `review`.
- **Resolving an older connection** (only these count): the org reconnects Instagram (the id is
  recorded), or an operator erases it with the org's consent or because it is abandoned:
  `eraseLegacyInstagramConnection({connectionId, reasonCode: "org_consented" |
"connection_abandoned", operator})` (its data is deleted and its identity erased, through the
  same steps; audited; no public status page). The hourly sweep then re-verifies.
- **Closing a review** when the requester cannot be reached or the remaining connections cannot be
  resolved: `closeDeletionReview({requestId, reasonCode: "org_confirmed_unrelated" |
"connection_unrecoverable" | "requester_unreachable", operator})`, only from `review`. The
  request becomes `closed_unverified` (never `completed`); a later successful verification still
  completes it.
- Meta documents periodic alerts (every 21 days) listing user ids to delete; ids not in the
  database may be disregarded. A connection made before IM6 is found only by its professional
  account id (RI14), and app-scoped id recovery for those is deferred (ADR 0017, decision 40).
- Credential cleanup: see [connections.md](connections.md) (health sweep; monitor
  `maintenanceCursors.lastPageAt`).

## Real-account validation required

Provisional until checked on a real Instagram professional account and a real Meta app:

| Item | What to verify                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| RI1  | the webhook HMAC secret (Meta app secret vs Instagram app secret)                                           |
| RI2  | `subscribed_apps` accepts the token as `Authorization: Bearer`                                              |
| RI3  | `entry.id` = `/me.user_id` = the stored `externalUserId`                                                    |
| RI4  | the `timestamp` unit                                                                                        |
| RI5  | echoes for API and app sends, and which field carries them                                                  |
| RI6  | the "seen" shape and `read.mid` meaning                                                                     |
| RI7  | delete / edit shapes and dedupe                                                                             |
| RI8  | re-consent keeps earlier scopes; the old token's fate; the consent screen                                   |
| RI9  | the "Allow access to messages" toggle under Instagram Login                                                 |
| RI10 | error codes for a closed window, a lost permission, a rate limit                                            |
| RI11 | the send response; `message_id` = the echo's `mid`                                                          |
| RI12 | the profile route fields                                                                                    |
| RI13 | v25.0 vs the v26.0 documentation                                                                            |
| RI14 | the callbacks' `signed_request` for Instagram Login: format, signing secret, which id `user_id` is, retries |
| RI15 | the 90-day unused-permission rule                                                                           |
| RI16 | the IGSID format                                                                                            |
| RI17 | 36-hour retries vs the `activatedAt` cutoff                                                                 |

For RI14: connect a test account, remove the app's access in the Instagram account's settings
and check the deauthorize result (connection `needs_reauth`); then request deletion and open the
returned status URL.
