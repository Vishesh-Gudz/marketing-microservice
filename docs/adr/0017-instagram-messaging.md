# ADR 0017 — Instagram direct messages

- Status: implemented, not validated. IM1 (data model and the one-org rule), IM2 (incoming
  webhook and the read API), IM3 (consent, turning messaging on and off, the D14 retention
  purge), IM4 (outbound text replies), IM5 (dashboard), IM6 (Meta's deauthorize and
  data-deletion callbacks) and IM7.0 (credential cleanup and deletion hardening) are
  implemented and tested in-process only, against signed fake
  deliveries and a fake Instagram API built from Meta's documented examples. Nothing here has
  run against Meta; every [assume] waits for a real account
  ([docs/instagram-messaging.md](../instagram-messaging.md), real-account checklist).
- Date: 2026-10-30

## Context

Phase 10 connects Instagram professional accounts through Instagram Login for organic analytics
only ([ADR 0011](0011-instagram-organic.md)); direct messages were deferred. Customers now want
to answer Instagram DMs from the dashboard, like WhatsApp ([ADR 0013](0013-whatsapp-inbox.md),
[ADR 0015](0015-whatsapp-messaging.md)).

Facts from Meta's documentation (Instagram API with Instagram Login: messaging, webhooks setup,
fields and examples, read 2026-10-29), marked [doc]; everything else is ours or provisional:

- DMs need `instagram_business_basic` and `instagram_business_manage_messages` [doc].
- Deliveries are `{object:"instagram", entry:[{id, time, messaging:[…]}]}`; `entry[].id` is the
  professional account id, the `/me.user_id` the Instagram connection already stores; for a
  customer's message `sender.id` is the customer and `recipient.id` the account; echoes
  (`is_echo`) are reversed [doc]. Ids appear as quoted strings in the examples [doc].
- Signed with `X-Hub-Signature-256: sha256=…` using "your app's App Secret" [doc]. Which secret
  that is for an Instagram Login app (the Meta app secret or the Instagram app secret) is not
  documented; unofficial reports say the Instagram app secret. UNVERIFIED.
- At most 1000 updates per delivery; retries for 36 hours; duplicates possible [doc].
- No delivery receipts: only "seen" (`read.mid`) and echoes [doc]. Edits (`message_edit`) and
  deletions (`is_deleted`) exist [doc].
- `timestamp` values in the examples have 13 digits; no unit is documented. `entry[].time` is
  described as when the notification was sent [doc].
- The same Instagram account can be linked for analytics in several orgs: nothing makes it
  unique across orgs.

## Decisions

### IM1: data model

1. **Separate tables** (`convex/tables/instagramMessaging.ts`): `instagramMessagingAccounts`,
   `instagramWebhookEvents`, `instagramConversations`, `instagramMessages`. WhatsApp's tables are
   unchanged. Shared with WhatsApp in `convex/messaging/` only where the meaning is the same:
   the event-processing status and message direction validators (IM1), the webhook signature
   check, `configuredSecret` and the 24-hour window (IM2; WhatsApp only changed its imports).
   Status rules are not shared: Instagram has no `delivered`, and `sent` comes from an echo.
2. **Messaging reuses the account's Instagram connection** (its token), which must be active,
   for the same account, and granted `instagram_business_manage_messages`.
3. **One org at a time per Instagram account.** An account `active` or `action_required` in one
   org refuses an enable in any other (`in_use`), checked through the approved global index
   `instagramMessagingAccounts.by_ig_account_status` in the same transaction as the write
   (`convex/instagram/messaging/accounts.ts`). Analytics linking is unchanged.
4. **Holds start at `activatedAt`.** Every enable and re-enable sets it. A re-enable clears the
   earlier subscription and setup error.
5. **Approved global indexes** (convex/schema.test.ts): the routing lookup above and
   `instagramWebhookEvents.by_status_received` for the recovery and retention sweeps.
6. **Audit** `instagram.messaging_enabled` / `instagram.messaging_disabled`, Convex ids and
   statuses only.

### IM2: incoming webhook and read API

7. **Endpoint** `/instagram/webhook` (`convex/instagram/messaging/webhook.ts`), the same checks
   in the same order as WhatsApp's: GET handshake with `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`
   (constant-time; unset 403); POST: secret configured (else 503), Content-Length (400), size
   3 MiB (413), HMAC over the raw bytes (401), strict JSON and envelope (400), one ingest
   mutation (500 on failure), 200. No logging.
8. **Signing secret:** only `INSTAGRAM_WEBHOOK_APP_SECRET`, with no default and no fallback to
   `INSTAGRAM_APP_SECRET` or the Meta app secret. It is set only after a Development-mode
   delivery has proved which secret Meta uses; until then every delivery is refused.
9. **Parser** (`payload.ts`): reads customer messages, echoes, deletions, "seen" and edits;
   ignores reactions, postbacks, referrals, opt-ins, handover, `standby`, `changes` and
   self-messaging tests. Ids are digit strings, or JSON numbers only when exact (17-digit ids
   lose precision as numbers; an inexact entry id rejects the delivery). The event time is each
   event's `timestamp`, never `entry[].time`. [assume] Milliseconds: only integers from
   2020-01-01 to receipt + 5 minutes are accepted, others are skipped (a value in seconds reads
   as 1970). Attachments are stored as their type only (no URL); unknown types `unsupported`;
   `reply_to.story` is `story_reply`. Events on the wrong side of the account are skipped.
10. **Routing** (`accounts.ts` `messagingHolder`, `ingest.ts`): to the ONE org holding the
    account (`active` or `action_required`). The holder is re-verified (its Instagram account and
    connection belong to its org and this account); a disconnected (`revoked`) connection
    receives nothing, one that only needs reauthorization still does. No holder, or more than
    one: dropped with 200. Events before the holder's `activatedAt` are dropped.
11. **Idempotent storage**: per-org dedupe keys `message:<mid>` (customer messages and echoes),
    `read:<mid>`, `edit:<mid>:<num_edit>`, `delete:<mid>`; batched asynchronous processing;
    bodies cleared once applied.
12. **Processing** (`processing.ts`), every lookup org-first and limited to the event's account
    and to the thread with the same customer: customer messages open or refresh the 24-hour
    window; echoes are outbound `sent` messages with origin `instagram` and do not open it;
    "seen" marks the message and up to 100 earlier outbound ones `read`; edits replace a known
    message's text (never an older edit over a newer one, never a deleted message); deletions
    clear it. **An edit or deletion of an unknown message never creates content:** the edit is
    ignored and its text dropped; the deletion (ids only) waits `unmatched`, so a message that
    arrives later is stored without its text. A "seen" that comes before its echo waits the
    same way.
13. **Recovery and retention** (`recovery.ts`, `retention.ts`, crons): the WhatsApp rules for
    stuck and expired events, on the Instagram events table. No requeue function yet.
14. **Read API** `v1/instagramMessaging:listAccounts|listConversations|getConversation|
listMessages` (viewer and up, org from the JWT, another org's ids NOT_FOUND). The DTOs carry
    no IGSID, Meta message id or token; the reply window is `replyWindowExpiresAt` only.

### IM3: consent, turning messaging on and off

15. **Consent reuses the Instagram connection and its reconnect flow.**
    `v1/connections:beginConnect` takes `instagramMessaging: true` (Instagram only) to ask for
    `instagram_business_manage_messages` on top of the two analytics scopes; a reconnect of a
    connection already granted it asks for it anyway, so a reconnect never drops it silently.
    The Instagram OAuthSpec accepts no other extra scope. Cancelled consent changes nothing
    (the existing `access_denied` path). Granted scopes come from the token exchange's
    `permissions`; analytics never depend on the messaging permission.
16. **Gate** `INSTAGRAM_MESSAGING_ENABLED=true` (exactly): on cloud deployments, asking for the
    permission, `enable` and `retrySetup` stay closed until it is set (local deployments and
    tests are open, as for WhatsApp). Turning messaging off, disconnecting and the webhook are
    never closed by it. It is not set anywhere.
17. **Transitions** (enforced by every writer in `accounts.ts`): `enable` moves (none) or
    `disabled` to `active` with every ownership check of decision 3 (linked through the
    account's own active connection, permission granted, no other org holding it, no purge
    running); `active` -> `action_required` when the webhook subscription fails;
    `action_required` -> `active` when a retry succeeds; `active` / `action_required` ->
    `disabled` when turned off, disconnected, unlinked, the permission removed or on a
    data-deletion request. Nothing else; a late subscription result never revives a turned-off
    account. A connection that only needs reauthorization keeps its hold (decision 10).
18. **Webhook subscription** (`lifecycle.ts`): after the database step, ONE request
    `POST graph.instagram.com/v25.0/{account}/subscribed_apps?subscribed_fields=messages,
messaging_seen,message_edit` with the account's own token in `Authorization: Bearer`
    (transport caller `messaging`; Meta's sample puts the token in the query, which the
    transport refuses: [assume] Bearer is accepted). `{"success": true}` [doc] -> subscribed;
    anything else -> `action_required` with a sanitized reason; a refused token (`auth`) also
    moves the connection to `needs_reauth`. `message_echoes` is not requested ([assume] echoes
    come with `messages`). Unsubscribing is not documented and never attempted. **Delayed
    answers:** every call is one attempt (`beginSetupAttempt` increments `setupAttempt` before
    Meta is called); its outcome is applied only while the row still holds, on the same
    `activatedAt` and the same `setupAttempt`. A later answer to an earlier attempt, an answer
    after a turn-off, or one from before a turn-off and re-enable is `stale` and changes
    nothing. A refused token marks the connection `needs_reauth` only if it still has the
    credential version that was refused (a reconnect since then wins).
19. **No stale holds:** disconnect stops every messaging account of the connection, unlink
    stops the account's, and a reconnect whose grant lacks the permission stops them in the
    same transaction as the claim. Each frees the account for any org at once.
20. **Admin API** `v1/instagramMessaging:enable|retrySetup|disable` (admin) and
    `getAvailability` (viewer and up): refusals are CONFLICT with a `reason` (`not_linked`,
    `connection_inactive`, `scope_missing`, `in_use`, `purge_in_progress`) or NOT_FOUND for
    another org's ids.
21. **D14 retention (an engineering policy choice, not a legal conclusion).** When messaging
    stops (turned off, disconnected, unlinked or the permission removed) the account's stored
    data is kept for a 30-day grace period (`purgeAfter`), then its webhook events, messages
    and conversations are hard-deleted (`purge.ts`: an hourly sweep through the approved
    global index `instagramMessagingAccounts.by_status_purge_after`, bounded steps that re-read
    the account and touch only that account's rows in its own org; events first, so nothing
    pending is processed back). A verified data-deletion request (Meta's callback, decision 35,
    calls `requestAccountDataDeletion`) purges at once. Turning messaging on again before the
    deadline (`purgeAfter`), with every ownership check, keeps the history. From the deadline
    on it is refused (`purge_in_progress`) until the purge is done, whether or not the hourly
    sweep has started it yet; the deadline is never cleared by a refused turn-on, so expired
    history can never be kept. Afterwards it starts empty. The account row stays as the record
    of the hold. Audited: `instagram.messaging_purge_started`, `instagram.messaging_purged`
    (counts only).

### IM4: outbound text replies

22. **API** `v1/instagramMessaging:sendText` (`accountId`, `conversationId`, `text`,
    `clientMessageId`): editors and admins (as WhatsApp's sendText), org from the JWT, another
    org's conversation NOT_FOUND, and `accountId` must be the conversation's own messaging
    account. Closed on cloud deployments until `INSTAGRAM_MESSAGING_ENABLED`.
23. **Checks before anything is stored** (`convex/instagram/messaging/outbound.ts`): the
    account is `active`, still the one holder of its Instagram account, on an active
    connection with the messaging permission (else CONFLICT `messaging_unavailable`,
    `setup_incomplete`, `reconnect_required`, `scope_missing`); the customer's 24-hour window is
    open (`window_closed`; no HUMAN_AGENT tag); the text is 1-1000 UTF-8 bytes [doc], counted in
    bytes, not characters; a repeated `clientMessageId` returns the same message. The claim
    checks the sender and the window again before the call.
24. **One call, never repeated**: the WhatsApp pattern (claim `sendAttemptedAt`, one scheduled
    delivery, a 5-minute watchdog). `POST graph.instagram.com/v25.0/{account}/messages` with
    the account's own token in `Authorization: Bearer` and `{recipient:{id}, message:{text}}`
    [doc, v26.0 sample; v25.0 assumed]; the transport accepts a JSON body on that route only.
    Accepted with `message_id` -> `submitted` (the mid); a 4xx -> `failed` with Meta's code; a
    refused token -> also `needs_reauth`, if the connection still has the refused credential;
    timeout, network, 5xx, unreadable or no `message_id` -> `unknown`, never retried (no
    idempotency key is documented). Watchdog: claimed without a result -> `unknown`
    (`no_result`, a late result still replaces it); never claimed -> `failed` (`not_sent`).
25. **A refused send changes only that message** (decided for IM4, replacing D18's
    `action_required` on 10/200): Meta's code 10 does not reliably tell a lost permission from a
    closed window, so a refusal never flags the account.
26. **Echoes by mid only, never by text.** An echo after the send result confirms the reply
    (`submitted` -> `sent`) without a new row; Meta repeating it is deduplicated. An echo that
    came first (stored as origin `instagram` in the same thread) is merged into the reply when
    the result is recorded, with a "seen" or deletion that also came first.

### IM5: dashboard

27. **Pages** under `/instagram/messages`: the conversations, newest first; each
    conversation's history, oldest first, with the reply box (`conversations/[id]`); and
    `settings`, every linked Instagram account with its messaging state. The nav item is always
    shown, like WhatsApp's; with the gate off the settings page says messaging is not available.
28. **Admin controls on the settings page only:** turn on, retry setup, and turn off (after an
    inline confirmation that explains the 30-day retention). The dashboard does not reconnect
    or grant the messaging permission; it says a reconnect is needed, and the connection flow
    (decision 15) stays with the integration.
29. **`replyBlocker`** on `listConversations` / `getConversation`: the reason `sendText` would
    refuse whatever the window (`messaging_unavailable`, `setup_incomplete`,
    `reconnect_required`, `scope_missing`), computed by the same `senderOf` check. The reply box
    is shown only to editors and admins, only without a blocker and while the window is open
    (from `replyWindowExpiresAt`); viewers read only.
30. **Fixed words only:** statuses, refusals and failures are shown from the sanitized reason,
    never the server's or Meta's text or code; the byte counter counts UTF-8 bytes as the
    backend does. An `unknown` reply is never offered for resending. Attachments show a
    placeholder, never a URL.

### IM6: Meta's deauthorize and data-deletion callbacks

Meta [doc, data-deletion callback]: a POST with a `signed_request` (base64url HMAC-SHA256 of
the payload segment, keyed with "your app secret"; payload `algorithm`, `expires`,
`issued_at`, `user_id`), answered with JSON `{url, confirmation_code}`; the URL must give the
user a human-readable status; the callback must "initiate the deletion of any data your app has
from Facebook about the user"; ids not in the database may be disregarded. Instagram Login only
names its two settings (Deauthorize callback URL, Data deletion request URL, in Business login
settings) [doc]; the format for it is [assume] the same.

31. **Routes** (`convex/instagram/dataDeletion/`): `POST /instagram/deauthorize`,
    `POST /instagram/data-deletion`, `GET /instagram/data-deletion/status?code=…`. Never gated by
    `INSTAGRAM_MESSAGING_ENABLED` (they cover the analytics connection too).
32. **Verification, fail closed:** only `INSTAGRAM_CALLBACK_APP_SECRET` (no default, no
    fallback; decided for IM6: which secret signs is RI14, so the operator sets the one real
    requests verify with). Unset: 503 and nothing read. Then Content-Length and an 8 KB body
    (400/413), the `signed_request` form field (urlencoded or multipart; [assume] a form) (400),
    the HMAC over the payload segment as sent, constant time, before decoding (401), then
    `algorithm` HMAC-SHA256 and a decimal string `user_id` (400). A deletion also needs a
    public https status origin (`CONVEX_SITE_URL`; loopback http locally), else 503. Nothing is
    logged; responses carry only the status line, or the code and URL.
33. **Which connections:** Meta names an Instagram user, not a tenant. `user_id` is matched
    against the code exchange's Instagram-scoped user id, now recorded on every Instagram
    connect (`connections.scopedUserId`; IR2 still holds: it is not assumed equal to `/me`),
    and against the professional account id (`externalUserId`), through two approved global
    indexes ([assume] RI14: which one Meta sends). Connections made before IM6 have no scoped
    id; they are found only if Meta sends the professional account id. Each match is then
    handled under its own orgId as a system actor of that org.
34. **Deauthorize** (decided for IM6): every active connection of the user -> `needs_reauth`
    (`instagram_deauthorized`), and its direct messages stop with the 30-day grace (D14). Data
    is kept until a disconnect or a deletion request. Idempotent.
35. **Data deletion** (decided for IM6: all Instagram data of the user, in every org connected
    to it): at once the connection is disconnected (credential deleted by the existing flow;
    Instagram has no revoke call), the Instagram account unlinked and marked (status
    `disconnected`: `linkSocialAccounts` refuses it with `purge_pending` until done) and its
    direct messages purged now (`requestAccountDataDeletion`). Then bounded, self-continuing
    steps delete each messaging account row once its purge is done, the account's stored
    analytics (posts, snapshots, daily metrics, sync runs, tasks, state: YouTube's
    platform-neutral `deleteChannelRows`) and the account row, and finally erase the
    connection's identity (`externalUserId` -> `erased:<id>`, no display name, no scoped id;
    the row stays because other rows point at its id). A credential the disconnect's action
    has not deleted 15 minutes after the request is deleted by the step. A connection
    reconnected since the request is a new authorization and is left as it is. Audited per org
    (`instagram.data_deletion_requested` / `_completed`, `socialAccount.purged`,
    `credential.deleted`): ids and counts only.
36. **Request record and idempotency:** `instagramDataDeletionRequests` is a GLOBAL table (a
    request may span orgs; approved in `schema.test.ts`) holding the confirmation code (20
    characters, random, unbiased alphabet), a keyed hash of the payload segment (a repeated
    delivery gets the same code; decision 38), the Convex ids per org and the state; no
    Instagram data. Waiting steps re-check every 30 s for about an hour; the hourly sweep
    resumes the rest (decision 38). The status page shows the code, the dates and a fixed
    explanation of what is deleted; an unknown or malformed code is a 404 that never echoes the
    input. (IM7.0 replaced "an unknown user is answered at once as completed" with decision 39.)

### IM7.0: credential cleanup and deletion hardening

37. **A disconnect's credential cleanup touches only its own authorization.** `revokeAtPlatform`
    carries the `credentialVersion` it disconnected; it revokes at the platform and deletes the
    credential only while the connection is still `revoked` on that version, and
    `deleteForConnection` re-checks both in its own transaction. Every credential write
    increments the version, so disconnect -> reconnect -> disconnect never lets the first job
    reach the second authorization (it audits `not_attempted` / `superseded`). A job scheduled
    before versions existed is a no-op (`legacy_job`): no revoke, no delete. The hourly health
    sweep's backstop deletes what is left, visiting EVERY revoked connection page by page from a
    persisted, resumable cursor (`maintenanceCursors`, a global table; one page and its cursor
    per transaction; one run at a time under a lease; a run pauses after 5,000 pages and the next
    run resumes; reset only at the end of the index or for an unreadable cursor;
    `docs/connections.md`).
38. **Deletion hardening.** A callback issued (`issued_at`) more than 5 minutes before a
    connection's current authorization (`connections.authorizedAt`, set on every claim) does not
    apply to it; a connection authorized again after a request is left as it is. The request key
    is HMAC-SHA256 of `data_deletion:<payload segment>` under the callback secret (the Instagram
    id cannot be recovered from it by trying ids). Each org's part runs in its own mutations
    (start, then bounded steps), deletes the org's unclaimed grants of the identity, and acts
    only on the messaging accounts recorded when it started. More than 50 matches per lookup
    answers 500 (Meta retries). Every resume moves `nextAttemptAt` ahead, and the hourly sweep
    takes the oldest first. The body is read with a byte cap.
39. **Completed means verified.** A request is `completed` only when every part is done AND a
    full scan (200 Instagram connections per step) finds no older (pre-IM6) Instagram connection
    anywhere: no recorded scoped id, identity not erased. Such a connection cannot be matched to
    a callback and may hold the requester's data, so ONE unresolved older connection anywhere
    keeps EVERY request from completing (`review`). The set only shrinks (every connect since
    IM6, mock included, records the id), so a clean scan stays true. Resolved means reconnected
    (the id is recorded) or erased; an operator erases one with `eraseLegacyInstagramConnection`
    (reason `org_consented` / `connection_abandoned`, the same deletion steps, audited, no public
    status page) and lists them with `listLegacyInstagramConnections`.
40. **Closing is not completing.** `closeDeletionReview` (reason `org_confirmed_unrelated` /
    `connection_unrecoverable` / `requester_unreachable`, only from `review`) sets
    `closed_unverified`: the page says the deletion was closed without full verification and
    never says "Completed". Only a later successful verification completes it. App-scoped id
    recovery for older connections (reading `/me.id` with their stored token) is deferred: it
    could not cover revoked connections anyway (no token), and the review status keeps the page
    honest meanwhile.
41. **Status page states:** `pending` and `review` say "In progress" (review adds that older
    connections are still checked), `closed_unverified` says "Closed without full verification",
    `completed` says "Completed on". Neither `review` nor `closed_unverified` contains the word
    "Completed".

## Consequences

- New Convex env vars: `INSTAGRAM_WEBHOOK_APP_SECRET` (secret), `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`,
  `INSTAGRAM_MESSAGING_ENABLED`, `INSTAGRAM_CALLBACK_APP_SECRET` (secret, IM6). None is set
  anywhere; no Meta app is configured to call the endpoints, and the messaging permission has
  no App Review.
- Schema (IM6, additive): `connections.scopedUserId`, `oauthGrants.scopedUserId`, the approved
  global indexes `connections.by_provider_identity` / `by_provider_scoped_user`, and the global
  table `instagramDataDeletionRequests`.
- Schema (IM3, additive): `instagramMessagingAccounts.purgeAfter` / `purgeStartedAt` /
  `setupAttempt`, the approved global index `by_status_purge_after`, and the org-first index
  `instagramWebhookEvents.by_org_account`.
- Between the deadline and the end of the purge (the next hourly sweep, then its bounded
  steps), turning messaging on is refused; an admin waits up to about an hour plus the purge.
- A plain connect (without `reconnectConnectionId` or `instagramMessaging`) of an account that
  has messaging grants without the permission and so stops messaging (decision 19); the
  dashboard must reconnect through the connection.
- Unverified until real traffic: whether re-consent keeps earlier permissions and what happens
  to the old token, whether `subscribed_apps` accepts the Bearer token, and which fields echoes
  need; for sending (IM4): the v25.0 send, that the send's `message_id` equals its echo's
  `mid`, Meta's error codes for a closed window, a lost permission and a rate limit, and how
  long Meta takes to answer.
- Messages sent while messaging is off are lost, even when Meta delivers them later; a message
  sent within about a second of enabling may be dropped by clock skew.
- An edit that arrives before its message is lost (the message keeps its first text).
- A send left `unknown` has no mid: if Meta did deliver it, its echo stays a separate
  `instagram` row (it cannot be matched reliably; matching by text is never done).
- A "seen" for a later message that arrives before an earlier reply's send result does not mark
  that reply read (only a seen for the reply's own mid is replayed).
- Unverified until a real delivery: the signing secret, the timestamp unit, the IGSID format,
  the echo, seen, edit and deletion shapes, and the attachment types.
- Unverified until a real callback (RI14): the signed-request format for Instagram Login, the
  secret that signs it, which id `user_id` is, and whether Meta retries. If Meta sends the
  scoped id, connections made before IM6 are not found until they reconnect.
- A deletion request also deletes the account's organic analytics; reconnecting and linking
  the account afterwards starts it afresh (backfill).
- Fixed in IM7.0 (decision 37): the generic disconnect's scheduled cleanup used to delete (and,
  for YouTube, revoke) the credential of a reconnect that landed before it ran (all providers).
  Remaining: a revoke request already sent with the old token when a reconnect commits within
  milliseconds; and a disconnect job pending at the deploy of IM7.0 leaves its credential to the
  sweep without a platform revoke (check that no `revokeAtPlatform` job is pending before
  deploying).
- Schema (IM7.0, additive): `connections.authorizedAt`; the global table `maintenanceCursors`;
  `instagramDataDeletionRequests` gains `origin`, `operatorReason`, `nextAttemptAt`, `attempts`,
  per-target `begun` / `messagingAccountIds`, the statuses `review` / `closed_unverified` with
  `closedAt` / `closeReason` / `closedBy`, and the index `by_status_next_attempt` (replacing
  `by_status_updated`). No deployed data exists for it (IM6 was never deployed).
- ONE unresolved older (pre-IM6) Instagram connection anywhere blocks the automatic completion of
  ALL deletion requests (decision 39). Before deploying, list them on every deployment.
- The Facebook Login (Meta Ads) callbacks are still deferred (docs/providers/meta.md, "Data
  deletion").
