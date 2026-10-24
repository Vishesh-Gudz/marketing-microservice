# WhatsApp inbox

Multi-tenant WhatsApp inbox on the WhatsApp Cloud API. Decisions: [ADR 0013](adr/0013-whatsapp-inbox.md).

**Status:** Stage 1, the inbound webhook slice, is implemented and tested in-process with signed
fake deliveries. It was checked once against real Meta on 2026-10-23 (a Meta test app in
Development mode): webhook verification and one inbound text message, stored end to end. The
inbound hardening that followed (activation cutoff, stuck-event recovery, retention, parser and
contact-name fixes) is tested in-process only. The server side of Embedded Signup (connecting a
number, [ADR 0014](adr/0014-whatsapp-connections.md)) is implemented and tested in-process
against a fake Graph only, and its connect page (`/whatsapp/settings`, B3) against a fake Meta
SDK only; neither has run against Meta. Sending (text replies and approved templates,
[ADR 0015](adr/0015-whatsapp-messaging.md)) and the dashboard inbox are implemented and tested
in-process against the fake Graph and the dashboard harness only; nothing has been sent through
Meta. Media messages, quoted replies, read receipts and messages to new contacts are not
implemented.

## Webhook

URL: `<CONVEX_SITE_URL>/whatsapp/webhook`.

| Request                  | Result                                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| GET, valid handshake     | 200, body = `hub.challenge`                                            |
| GET, anything else       | 403 (also when `WHATSAPP_WEBHOOK_VERIFY_TOKEN` is unset)               |
| POST, secret not set     | 503 (Meta retries later)                                               |
| POST, bad Content-Length | 400 (not digits only, or repeated)                                     |
| POST, body > 3 MiB       | 413 (declared in Content-Length or actual)                             |
| POST, bad signature      | 401                                                                    |
| POST, malformed envelope | 400                                                                    |
| POST, ingestion failure  | 500 (Meta retries; ingestion is idempotent)                            |
| POST, valid              | 200 `EVENT_RECEIVED`, also for numbers no org has registered (dropped) |

Processing is asynchronous: the POST stores events and schedules their processing.

Only `messages` changes are read, plus `account_update` `PARTNER_REMOVED` (see "Partner removal"
below). Changes for other subscribed fields (template, quality, other account updates, …), and
malformed `account_update` changes, are acknowledged and ignored whatever their `value` holds,
so they never reject the messages delivered beside them; a malformed `messages` change still
rejects the whole delivery (400). The Content-Length check is tested in-process only: whether
Convex's HTTP front end passes a malformed header through to the action at all is unverified.
The inbox needs only the `messages` field; connected accounts also need `account_update`. Meta's
dashboard has been seen to subscribe others automatically, and they are ignored.

## Configuration (Convex environment variables)

| Name                            | Purpose                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `WHATSAPP_APP_SECRET`           | Meta app secret; verifies `X-Hub-Signature-256`. Embedded Signup also uses it (code exchange, `appsecret_proof`).                   |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Operator-chosen verify token entered in the Meta app.                                                                               |
| `WHATSAPP_CONNECTIONS_ENABLED`  | `true` (exactly) opens new WhatsApp connections on a cloud deployment ([ADR 0014](adr/0014-whatsapp-connections.md)); not a secret. |
| `WHATSAPP_APP_ID`               | Numeric id of the WhatsApp Meta app (Embedded Signup); not a secret.                                                                |
| `WHATSAPP_ES_CONFIG_ID`         | Numeric id of its Facebook Login for Business configuration (Embedded Signup v4); not a secret.                                     |

The first two are secrets (8–512 characters, no whitespace) and are never logged or returned. Set
them per deployment with `npx convex env set` or the Convex dashboard; never in source files or
`.env.local`. Embedded Signup needs `WHATSAPP_APP_ID`, `WHATSAPP_ES_CONFIG_ID` and
`WHATSAPP_APP_SECRET`; if any is missing or malformed, it is unavailable (fails closed). None of
the Meta Ads variables (`META_*`) is read by the WhatsApp code.

- The verify token is used only for Meta's GET handshake, which carries it in the URL query
  string. This application never logs it, but whether Convex's request logs keep query strings
  is unverified: assume anyone who can read the deployment's logs may see it, and change it (in
  Convex and in the Meta app's webhook settings together) if those logs are exposed.
- Removing `WHATSAPP_APP_SECRET` stops ingestion: every POST gets 503 and nothing is stored.
  Meta retries non-200 deliveries for a while (about 7 days, unverified), so deliveries during a
  short stop are expected to arrive once the secret is back.

## Setup (per deployment)

1. Set `WHATSAPP_APP_SECRET` and `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
2. Deploy. An unsigned POST to the webhook then returns 401 if the app secret is set and well
   formed (503: missing or invalid).
3. Register the number to its org before Meta sends anything: deliveries for a number that is
   not registered, and events from before its registration, are acknowledged and dropped. Run
   the internal function `whatsapp/phoneNumbers:register` from the Convex dashboard with
   `{ "orgId": "…", "wabaId": "…", "phoneNumberId": "…", "actorSubject": "operator:<name>" }`
   (`displayPhoneNumber` optional). It refuses non-numeric ids (`invalid_id`), an unknown org
   (`no_org`) and a number that another org has active (`in_use`).
   `whatsapp/phoneNumbers:disconnect` (`{ "numberId": "…", "actorSubject": "operator:<name>" }`)
   undoes it: history is kept, and later deliveries for the number are acknowledged and dropped.
4. In the Meta app's WhatsApp webhook settings, enter the callback URL
   `<CONVEX_SITE_URL>/whatsapp/webhook` and the verify token, verify and save, and subscribe the
   `messages` field.
5. Send one test message and check the event (`processed`), the conversation and the message in
   the org's data.

`actorSubject` for register and disconnect follows the same rule as requeue's (risk 3): it must
be `operator:<name>` (letters, digits, `.`, `_`, `@`, `-`; at most 64), otherwise the call fails
with `INVALID_ARGUMENT` and changes nothing. It is recorded as the audit subject (and as
`registeredBySubject`) but is a label typed by the operator, **not verified by this
application**: the check only keeps it apart from authenticated users and system jobs.

## Data

| Table                      | Holds                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsappBusinessAccounts` | A WABA an org connected through Embedded Signup (connection, onboarding type, status, setup progress). One org per active WABA (global ownership index). |
| `whatsappPhoneNumbers`     | phone_number_id → org routing (WABA id, status, activation time, source, connected WABA, Meta registration). Global lookup index.                        |
| `whatsappWebhookEvents`    | One row per received event (dedupe key; body cleared once applied; recovery state). Global recovery index. Deleted 30 days after receipt unless pending. |
| `whatsappConversations`    | One thread per (business number, customer wa_id); last inbound time; contact name from the newest message that carried one.                              |
| `whatsappMessages`         | Inbound and outbound messages; delivery status, timestamps. Outbound: sender, `clientMessageId` (org-first index), template, failure reason.             |

Phone numbers are routed only by internal functions: an operator runs them (see Setup), or the
Embedded Signup action does, for a number it verified with Meta. No public function accepts an
org id.

## Connecting a number (Embedded Signup, ADR 0014)

Tested against a fake Graph and (the page) a fake Meta SDK only, never against Meta. Admins start
it on `/whatsapp/settings` ([dashboard.md](dashboard.md#whatsapp-embedded-signup)). A WhatsApp connection is provider `whatsapp`, keyed by the WABA id, with the
business token and the registration PIN stored encrypted (connection credential, AAD
`orgId|whatsapp|wabaId|v1`). The generic connection endpoints refuse WhatsApp connections
(`whatsapp_connection`).

1. The dashboard (an org admin) reads `v1/whatsapp:getSignupConfig`. With `available: true` it
   gets the app id, the login configuration id and the Graph version for Meta's JavaScript SDK,
   runs `FB.login`, and receives the `code` and the `WA_EMBEDDED_SIGNUP` `FINISH` message.
2. Within 30 seconds it calls `v1/whatsapp:completeSignup` with `{ code, wabaId, phoneNumberId }`
   (the browser's `business_id` is not used). The org and the admin come from the JWT.
3. The action exchanges the code, inspects the token (valid, our app, both WhatsApp
   permissions, the WABA among those granted), reads the WABA and lists its numbers. Any
   mismatch is refused before anything is stored (`INVALID_ARGUMENT` with a `reason`, see
   below). Another org's active WABA or number is `CONFLICT` (`waba_in_use`,
   `phone_number_in_use`), and so is a number this org has from the operator path
   (`phone_number_operator_managed`, see Limits).
4. It stores the credential, the connection, the account and the number's routing (inbound
   messages for the number reach the org from then on) in ONE transaction: if another org or
   the operator path took the number meanwhile, nothing is written. Then it subscribes the app
   to the WABA and registers the number, in that order.
5. The result is `connected`, `action_required` with the missing `nextStep` (`subscribe` or
   `register`) and a sanitized `reason` (`meta_<code>`, `http_<status>`, `network`, `timeout`,
   `unexpected_response`, `registration_attempts_exhausted`, `registration_rate_limited`,
   `registration_in_progress`), or `reauthorization_required` (see Token expiry). After
   `action_required` an admin calls `v1/whatsapp:retrySetup` (`{ accountId }`), which resumes
   only the missing steps with the stored token and PIN. Nothing retries on its own.

Concurrent calls: a number's registration call needs a claim (one transaction, at most one
caller wins; it counts the attempt and holds for 30 seconds, released by the result or expiring
on its own). A retry that finds a live claim calls nothing and reports
`registration_in_progress`. Two signups for the same WABA at the same time: the one that stores
its credential first wins; the other writes nothing and is refused (`CONFLICT`,
`signup_in_progress`), so a stored PIN is never replaced by a concurrent one. An account without
an active number (its number was disconnected) is never subscribed and reports
`no_active_number`; a new signup adds a number.

Refusal reasons before anything is stored: `invalid_code`, `invalid_id`, `connections_disabled`,
`signup_code_invalid` (expired, used or unknown code), `token_invalid`, `token_wrong_app`,
`scopes_missing`, `waba_not_granted`, `waba_not_accessible`, `phone_number_not_in_waba`
(`INVALID_ARGUMENT`); `waba_in_use`, `phone_number_in_use`, `phone_number_operator_managed`,
`stored_pin_unavailable`, `signup_in_progress` (`CONFLICT`). A Meta outage at that stage is `PROVIDER_ERROR` (`stage`,
`reason`, `retryable`); the user starts the signup again. Missing app configuration is
`INTERNAL` (`not_configured`).

**Token expiry and reauthorization.** No WhatsApp token is refreshed: the token refresh job
handles Instagram only (its provider list is typed to OAuth providers, and it skips anything
else). A connection moves to `needs_reauth` in two ways:

- its `tokenExpiresAt` (from Meta's `expires_at`, if any) has passed: the hourly connection sweep
  marks it, like every provider's (`Access token expired`, audited `connection.needs_reauth`,
  reason `token_expired`);
- Meta refuses the token during setup (Graph code 190 or 102, or HTTP 401, the Meta Ads
  provider's classification): `Re-authorization required`, audited with reason
  `whatsapp_token_invalid` and the admin's subject; the account records `token_invalid`.

Then the setup status is `reauthorization_required`, `retrySetup` refuses (`reconnect_required`)
without calling Meta, and the admin signs up again. That reconnect keeps the stored PIN.
Inbound routing is unaffected.

Limits (B2):

- Numbers that already have a two-step verification PIN are not supported: their registration
  fails and the reason is recorded. Coexistence numbers (already in the WhatsApp Business app)
  are not supported.
- A number this org has from the operator path (active or disconnected, including rows without
  `source`) is refused (`phone_number_operator_managed`) before any write here or at Meta: its
  two-step PIN at Meta is not ours, so registering it would overwrite that PIN or fail on it.
  Its row and routing are unchanged. Moving such a number into Embedded Signup is not
  supported.
- At most 5 registration calls per number. After Meta's rate-limit error (133016; Meta allows
  10 register / deregister calls per 72 hours), no registration call for that number for 72
  hours (`registration_rate_limited`; `listAccounts` shows `registrationRetryAfter`).
- One number per signup call; another number of the same WABA needs another signup.
- A reconnect (a new signup for the same WABA in the same org, also after `needs_reauth`)
  replaces the token, keeps the stored PIN, subscribes again and never re-registers a
  registered number. A stored credential that cannot be read is never replaced: the signup is
  refused (`stored_pin_unavailable`). Whether re-subscribing is harmless at Meta is not
  documented.
- Disconnecting deletes the stored token and PIN once Meta's cleanup ends (see "Disconnecting
  an account"); a later signup uses a new PIN. The token is not revoked at Meta.
- Two calls carry secrets in their query string, as Meta documents them (server to server,
  HTTPS): the code exchange (`client_secret`, `code`) and `debug_token` (the business token).
  This application never logs a URL; whether anything between Convex and Meta records query
  strings is unverified.

## Connect UI: Meta configuration

The connect page ([dashboard.md](dashboard.md#whatsapp-embedded-signup)) uses Meta's JavaScript
SDK as Meta documents it for Embedded Signup ("Embedded Signup implementation", read 2026-10-24).
None of this is configured or tested yet; each step is an operator task with its own approval:

1. In the Meta app, a **Facebook Login for Business** configuration with the **WhatsApp Embedded
   Signup** login variation (Embedded Signup v4 is selected there). Its id goes into
   `WHATSAPP_ES_CONFIG_ID`, the app id into `WHATSAPP_APP_ID` (Convex env, not secrets).
2. Facebook Login for Business → Settings → Client OAuth settings set to **Yes**: Client OAuth
   login, Web OAuth login, Enforce HTTPS, Embedded Browser OAuth Login, use Strict Mode for
   redirect URIs, Login with the JavaScript SDK.
3. The page's HTTPS origin in **Allowed domains** and **Valid OAuth redirect URIs** (for example
   `https://marketing-microservice.vercel.app`). Otherwise Meta does not return the code or the
   ids to the page. Only HTTPS domains are supported: plain `http://localhost` cannot run the real
   flow; a local test needs an HTTPS origin that is listed there.
4. While the app is in Development mode, only people with a role on the Meta app can finish a
   signup. Real customers need the app Live with Advanced Access to `whatsapp_business_management`
   and `whatsapp_business_messaging`, business verification and Tech Provider status.
5. `WHATSAPP_CONNECTIONS_ENABLED=true` on the cloud deployment that serves the page. It opens new
   connections for every organization there; until then the page says WhatsApp is not available.
6. The `account_update` webhook field subscribed (App Dashboard → WhatsApp → Configuration →
   Webhook fields). Meta requires it for Embedded Signup; without it a customer's partner
   removal is never seen ("Partner removal" below). Account-level webhooks always go to the
   app's default callback URL (no override).

Page behaviour worth knowing for a first real test: the browser shows Meta's error code and
session id (never Meta's error text) when the signup fails in the Meta window; "Signup did not
finish" means the code arrived but Meta's `FINISH` message did not follow within 10 seconds,
or the window closed after `FINISH` without a code (the page waits for the window to close
after `FINISH`, since Meta counts its final screen as finished); the signup variants Meta
reports for a WABA without a number, a WhatsApp Business app number (coexistence), a migration or
API-access-only signup are refused in the browser with an explanation.

## Disconnecting an account

`v1/whatsapp:disconnectAccount` (`{ accountId }`, org admins, ADR 0014 B4). Tested against a fake
Graph only; never run against Meta.

1. **At once, in one transaction:** every active number of the account stops routing (from that
   commit on, deliveries for it are acknowledged and dropped as unrouted), the connection is
   revoked and the account becomes `disconnected`. Each change is audited
   (`whatsapp.number_disconnected`, `connection.disconnected`). Events accepted before still
   reach the conversations; conversations and messages are never deleted and stay visible.
2. **Then the Meta cleanup:** our app is unsubscribed from the WABA's webhooks with the stored
   token (`DELETE /{waba}/subscribed_apps`). It is skipped when the WABA is still used: another
   org has it connected, or any org (this one included) has an active number on it, e.g. an
   operator-managed one; unsubscribing would cut their webhooks too. One attempt runs at a time.
   A Meta failure is retried after 1 min, 5 min, 30 min, 2 h and 6 h; a refused token (190 /
   102 / 401) ends it. Repeating the disconnect never repeats a finished cleanup.
3. **When it ends** (done, or given up after the last retry), the stored token and PIN are
   deleted (`credential.deleted`, then `whatsapp.offboarding_completed` or
   `whatsapp.offboarding_failed`; retries are audited as `system:whatsapp-offboarding`). The
   token is not revoked at Meta: the customer can remove the app in their Meta business
   settings. Numbers are not deregistered.

`listAccounts` shows a disconnected account's cleanup as `pending` (with `retryAfter`), `done` or
`failed`; how it finished (unsubscribed, skipped, token refused) is only in the audit log.

While a cleanup is pending, a signup for that WABA is refused for every org
(`disconnect_in_progress`). Afterwards a new signup reconnects it: the numbers are routed again
with a new activation time (messages from the gap are not backfilled), the WABA is subscribed
again, a new PIN is stored, and registered numbers are not registered again. A setup call that
subscribes after a disconnect undoes that subscription with the same token. The generic connection
sweep leaves a revoked WhatsApp connection's credential alone for 24 hours, then deletes what is
left, as for every provider.

Unverified at Meta: whether `DELETE subscribed_apps` is harmless to repeat, whether it removes only
our app's subscription, and what Meta does with the WABA's deliveries afterwards.

## Partner removal (Meta `PARTNER_REMOVED`)

When a customer unshares their WABA in Meta, Meta sends an `account_update` webhook with
`event: "PARTNER_REMOVED"` (ADR 0014 B4b). Tested against signed fake deliveries and a fake Graph
only; never run against Meta.

- **Read:** only `value.waba_info.waba_id`. In Meta's example `entry[].id` is a business id, not
  the WABA, and is never read; the coexistence variant without `waba_info` is ignored.
- **Not trusted alone:** Meta describes the event as the WABA being unshared with a Solution
  Partner, not necessarily us, and does not say which apps receive it. For the one org that has
  the WABA connected (its id was verified with Meta at signup), the webhook reads the WABA once
  with that org's stored token (`GET /{waba}`):
  - Meta answers: our access remains (another partner was removed, or the event is older than a
    reconnect). Acknowledged; nothing changes.
  - Meta refuses the token (190, 102, HTTP 401) or access to the WABA (10, 200, 803, or 100 with
    subcode 33; these four are assumed): the account is disconnected, in one transaction.
  - Anything else (network, timeout, 5xx, rate limit, a token that cannot be decrypted): the
    delivery is answered 500 and Meta retries it (Meta documents up to 7 days). At most 10 WABAs
    are checked per delivery; the rest wait for the retry.
- **Disconnecting:** the account's active numbers stop routing, the connection is revoked and the
  token and PIN are deleted at once; the account shows as disconnected and can be connected again
  with a new signup. Nothing is called at Meta (no unsubscribe, no deregister): our access is
  gone. Audited as `system:whatsapp-webhook`: `whatsapp.number_disconnected`,
  `connection.disconnected`, `credential.deleted` and `whatsapp.partner_removed`.
- **Never touched:** other orgs' rows, older disconnected accounts for the WABA, operator-managed
  numbers, a WABA no org has connected, and an account an admin disconnected meanwhile (its own
  cleanup continues). A reconnect made while the check runs is never undone: the write re-checks
  the credential version the check used. Repeats find nothing active and call nothing.

Unverified at Meta: which apps receive `PARTNER_REMOVED`; that `waba_info` is present for normal
Embedded Signup customers; what reading the WABA answers after a removal (the four access codes
above are assumed), and whether access ends at once (if the read still succeeds just after a
removal, the event is ignored and the account stays connected until its token is next refused);
whether Meta removes our webhook subscription itself; and whether re-adding the partner works at
once. Not handled: `PARTNER_APP_UNINSTALLED`, `ACCOUNT_OFFBOARDED`, `ACCOUNT_DELETED` and the
other `account_update` events.

## Sending messages (ADR 0015)

Tested against the fake Graph only (`convex/whatsapp/fakeGraph.fixtures.ts`); nothing has been
sent through Meta. Editors and admins send from a conversation's page
([dashboard.md](dashboard.md#whatsapp-inbox)), in an existing conversation only: a text reply
(at most 4096 characters) while the customer's 24-hour window is open, an approved template at
any time. Code: `convex/whatsapp/outbound.ts` and `convex/whatsapp/templates.ts`.

**Which numbers send.** Only a number connected through Embedded Signup, with the org's own
token from that number's connection (and `appsecret_proof`). The number is checked before
anything is stored and again when the delivery runs; a send that is no longer possible then is
`failed`, with the refusal as its `failureReason`. Refusals (`CONFLICT`, `details.reason`):

| `reason`                   | When                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| `number_cannot_send`       | The number was registered by an operator: no token is stored for it.     |
| `number_unavailable`       | The number or its account is no longer active (disconnected or removed). |
| `reconnect_required`       | The number's connection is not active (for example, a refused token).    |
| `number_not_ready`         | The number is not registered with Meta yet (setup not finished).         |
| `service_window_closed`    | Text only: the customer last wrote more than 24 hours ago.               |
| `template_unavailable`     | Templates: no APPROVED template with this name and language.             |
| `template_unsupported`     | Templates: one this app cannot send yet (see below).                     |
| `client_message_id_reused` | The `clientMessageId` already belongs to another message.                |

**Sent once, never repeated.** The browser makes a `clientMessageId` for each message (8-64
letters, digits, `-` or `_`); the same id again returns the stored message instead of a second
send. The message is stored `pending` with the sender's subject, and one delivery is scheduled.
The delivery claims it once (`sendAttemptedAt`), makes ONE Meta call (`POST /{phone}/messages`,
`to` = `+` and the customer's `wa_id`) and records the answer. Meta has no idempotency key, so a
send whose answer is lost is never repeated automatically; the page asks to check with the
customer first.

| Status                      | Meaning                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pending`                   | Stored; no answer from Meta recorded yet.                                                                                 |
| `submitted`                 | Meta accepted it; its wamid is stored and status webhooks can reach it.                                                   |
| `sent`, `delivered`, `read` | From status webhooks; a message only moves forward.                                                                       |
| `failed`                    | Meta refused it (`errorCode`, `failureReason` `meta_<code>`), a `failed` status came, or it was never sent.               |
| `unknown`                   | No usable answer (timeout, network, 5xx, unreadable), or none recorded within 5 minutes: it may have been sent. No wamid. |

A refused token (190, 102 or HTTP 401) also moves the connection to `needs_reauth`, through the
same path as the other providers. A status webhook that arrives before the send result is
applied when the result is recorded (Open risks, risk 2).

**Watchdog.** Convex does not retry a failed action, so each queued message also schedules
`settleStuckSend` 5 minutes later (`STUCK_SEND_AFTER_MS`). A message still `pending` then
becomes `unknown` (`no_result`) when its delivery claimed it, since Meta may have it, or
`failed` (`not_sent`) when nothing claimed it; a late delivery then finds it no longer pending.
A real result recorded after the watchdog's `unknown` still replaces it.

**Templates.** `listTemplates` reads the WABA's templates from Meta each time (100 per page, at
most 5 pages; `complete: false` beyond that) and returns the APPROVED ones with their variables.
Supported: a TEXT header or none, the BODY with positional (`{{1}}`, ...) or NAMED placeholders,
a FOOTER, and QUICK_REPLY, PHONE_NUMBER or URL buttons (a URL may end in one variable). Listed
with a reason and not sendable: media and location headers, carousel and limited-time-offer
components, authentication templates, other buttons, and placeholders that break Meta's rules.
`sendTemplate` reads the template again and checks every value before anything is stored
(`INVALID_ARGUMENT` with `details.field` `variables.<component>.<name>` and `details.reason`
`missing_value`, `unexpected_value`, `blank_value`, `too_long`, `header_too_long` or
`body_too_long`): no value may be blank, a filled-in header is at most 60 characters and a body
at most 1024, a URL value at most 2000. The message keeps the template's name, language, the
exact components sent and the text the customer reads (`text`). Then it is sent like a text
reply.

**Logs.** Nothing here logs. A failure keeps only Meta's numeric code and a reason code
(`meta_<code>`, `http_<status>`, `timeout`, ...), never Meta's text; the token travels only in
the `Authorization` header.

## Public API

Inbox: `v1/whatsapp:listConversations` (`{ paginationOpts }`), `v1/whatsapp:getConversation`
(`{ conversationId }`), `v1/whatsapp:listMessages` (`{ conversationId, paginationOpts }`). All
`orgQuery` (viewer). Another org's conversation is `NOT_FOUND`.

Sending (editors and admins, "Sending messages"): `v1/whatsapp:sendText`
(`{ conversationId, text, clientMessageId }`, mutation), `v1/whatsapp:listTemplates`
(`{ conversationId }`, action; returns `{ templates, complete }`) and `v1/whatsapp:sendTemplate`
(action; `{ conversationId, templateName, language, variables, clientMessageId }`, where
`variables` is a list of `{ component, name, value }` and `component` is `header`, `body` or
`button`). Both senders return the stored message. Another org's conversation is `NOT_FOUND`.

Connections: `v1/whatsapp:getSignupConfig` (`{}`, admin), `v1/whatsapp:completeSignup`
(`{ code, wabaId, phoneNumberId }`, admin action), `v1/whatsapp:retrySetup` (`{ accountId }`,
admin action; another org's account is `NOT_FOUND`) and `v1/whatsapp:listAccounts` (`{}`,
viewer; accounts with their numbers, setup status and, once disconnected, the Meta cleanup's
status; never the token or PIN), and `v1/whatsapp:disconnectAccount` (`{ accountId }`, admin
action; see below). `completeSignup`'s `code` is the only secret-like argument the contract test
allows.

## Open risks (Stage 1)

Known gaps in the inbound slice. Entries marked mitigated are addressed and list their remaining
limits; the others must be closed before customers depend on the inbox:

1. **Event retention (mitigated).** The `whatsapp event retention` cron (hourly,
   `convex/whatsapp/retention.ts`) deletes `whatsappWebhookEvents` rows that are no longer
   pending once they are at least 30 days old, counted from receipt (`receivedAt`), reading the
   approved global index `whatsappWebhookEvents.by_status_received`:

   | Event status           | What the row holds                                    | Retention                  |
   | ---------------------- | ----------------------------------------------------- | -------------------------- |
   | `processed`, `ignored` | dedupe key, wamid, number (body cleared)              | deleted after 30 days      |
   | `unmatched`            | status body, including the customer's WhatsApp id     | deleted after 30 days      |
   | `failed`               | full body (message text, contact name), for requeue   | deleted after 30 days      |
   | `pending`              | full body and recovery state (recovery still owns it) | never deleted by retention |

   Messages and conversations are never deleted automatically. 30 days is far longer than
   Meta's retry period for a delivery (about 7 days, unverified), so a deleted dedupe key is
   not expected to be needed again. If an event is redelivered after its row was deleted, it is
   stored again as a new row and changes nothing: a message already stored is `ignored`
   (messages are unique per org and wamid), a status already recorded is `ignored` (statuses
   only move forward), and a status for an unknown message is `unmatched` again.

   **Failed events and requeue.** A `failed` event can be requeued (risk 3) until it is 30
   days old. Requeuing makes it `pending` again, so retention leaves it alone until it is
   processed (or fails again); once processed, an event already older than 30 days is deleted
   by the next run. After retention has deleted a failed event, `requeueFailedEvent` returns
   `false` and writes no audit entry: the event and its body are gone, and its message was
   never stored. There is no hold mechanism; an operator who needs a failed event must requeue
   it before then.

   **Pending events and queued retries.** Retention never reads `pending` rows (the type of its
   status list excludes them) and never deletes a row whose recovery retry (`retryJobId`) is
   still queued. A retry still queued 30 days after receipt would take a scheduler stall of
   weeks, so that check is a guard. A processing job that runs after its event was deleted
   (the original batch's job is not tracked) finds no row and skips it.

   Each run examines at most 200 rows. A run that deletes a full batch schedules a follow-up
   run at once, at most 20 in a chain; the next hourly run continues after that. Every run reads
   and deletes in one transaction: Convex mutations are serializable and a mutation whose reads
   conflict with another's writes is re-run (Convex docs, "OCC and Atomicity"), so a retried or
   overlapping run deletes each row at most once and never a row that no longer qualifies.
   Limits:
   - The requeue window counts from receipt, not from the failure. Recovery normally fails an
     event about 20 minutes after receipt; a scheduler backlog can stretch that to a few days
     (each retry may wait up to 24 hours in the queue). An event requeued late that fails again
     after its 30th day is deleted by the next hourly run.
   - No alert for `failed` events (risk 3): one nobody notices within 30 days is deleted, and
     its message is lost for good.
   - `unmatched` rows are read only when a send result is recorded (risk 2), normally seconds
     after they arrived. Statuses for messages this app did not send, or for a send left
     `unknown`, stay `unmatched` and are deleted after 30 days.
   - At most 4,200 rows are deleted per hour (21 runs of 200), about 100,000 a day. A sustained
     volume above that lets the backlog of expired rows grow until volume drops.
   - Rows kept for a queued retry count against a run's 200 rows; they could only build up if
     the scheduler stalled for weeks.
   - `pending` rows are never deleted, however old; recovery turns every stuck event into
     `processed` or `failed` (normally within minutes, at most a few days under a backlog).
   - Retention and deletion of stored message text and contact names (`whatsappMessages`,
     `whatsappConversations`) are not defined, and there is no per-org data deletion.

2. **Unmatched-status replay (mitigated).** A status for a message the org does not know yet is
   stored as `unmatched`. When a send result is recorded (`recordSendResult`,
   `convex/whatsapp/outbound.ts`), the statuses already stored for its wamid are looked up by
   their dedupe keys (`status:<wamid>:<status>`, through the org-first index `by_org_dedupe`; no
   new index), applied in the same transaction and marked `processed` (`ignored` when they
   change nothing). Limits:
   - A send left `unknown` has no wamid, so no status ever reaches it.
   - Statuses for messages this app did not send stay `unmatched` (risk 1).
   - Whether Meta ever sends a status before the send call returns is unverified; the replay is
     tested in-process only.
3. **Stuck-event recovery (mitigated).** A processing batch (up to 100 events) runs in one
   transaction, so one event that keeps throwing rolls back its whole batch. The
   `whatsapp stuck event recovery` cron (every 5 minutes, `convex/whatsapp/recovery.ts`) finds
   events still `pending` 5 minutes after receipt, through the approved global index
   `whatsappWebhookEvents.by_status_received`, and retries each one on its own, so healthy
   events succeed. Each retry's scheduled job id is stored on the event (`retryJobId`), and the
   sweep reads that job's state:
   - Still queued (`pending` / `inProgress`): the retry is neither counted nor scheduled again,
     so a scheduler backlog cannot use up an event's retries. A retry still queued 24 hours
     after it was scheduled is canceled and the event marked `failed`.
   - Anything else while the event is still `pending` (the job failed, was canceled, or its
     record is gone) means the retry finished without processing the event, and it counts
     (`attempts`). Convex keeps finished scheduled jobs for 7 days only ("Scheduled function
     results are available for 7 days after they have completed", Convex docs, Scheduled
     Functions), so a missing record is treated as finished, never as a reason to retry
     without counting.

   So every stuck event becomes `failed` (body kept) after at most 3 finished retries (4
   attempts including the original batch), or after a day with a retry that never ran. A
   `failed` event can be requeued until retention deletes it, 30 days after receipt (risk 1).

   **Requeue (operators).** Once the cause is fixed, someone with admin access to the Convex
   deployment requeues an event with the internal function
   `whatsapp/recovery:requeueFailedEvent`: from the dashboard (Functions → `whatsapp/recovery`
   → `requeueFailedEvent` → Run, arguments
   `{ "eventId": "<event _id>", "actorSubject": "operator:<name>" }`), or from a terminal with a
   deploy key: `npx convex run whatsapp/recovery:requeueFailedEvent '{"eventId":"…","actorSubject":"operator:<name>"}'`.
   It is audited as `whatsapp.event_requeued` in the event's org. `actorSubject` is typed in by
   the operator and is **not verified by this application**: it is a label, not authenticated
   attribution. It must be `operator:<name>` (letters, digits, `.`, `_`, `@`, `-`; at most 64),
   so audit readers can tell it apart from authenticated users (JWT subjects) and system jobs.
   What is controlled is who may run it at all: only deployment admins (Convex dashboard
   access, or a deploy key). Authenticated attribution would need a staff-facing admin mutation
   behind the org's JWT, which does not exist yet. Remaining limits:
   - No alert yet: `failed` events are only visible in the data (filter `status = "failed"`),
     and retention deletes them 30 days after receipt whether or not anyone looked.
   - Each sweep examines the 100 oldest stuck events. Events waiting on a queued retry keep
     their place, so while 100 or more are waiting, newer stuck events are not retried until
     those retries run or are given up (at most 24 hours).
   - The original batch's job is not tracked, so a retry can be scheduled while that batch is
     still queued. Both then run; processing is idempotent, so the event is applied once.
   - A failing job's error message is kept by Convex (function logs and the scheduled job's
     record). Our errors carry no message content, but that is not enforced for
     platform-generated errors.

4. **Number-transfer timing (mitigated).** Each number records `activatedAt` when it is
   registered or re-activated (updating an already active number keeps it). Ingestion drops
   events whose platform timestamp is before that activation, so Meta's late retries for a
   previous owner (another org, or the same org before a disconnect) are never stored for the
   current owner. Rows registered before this existed use `createdAt`. Remaining limits:
   - Meta timestamps are whole seconds, so the cutoff is the activation's second: an event in
     that same second is accepted. There is no further grace, and no compensation for clock
     skew between Meta and Convex.
   - A status that happens after the move for the previous owner's outbound message (the
     customer reads it later) reaches the new owner as an `unmatched` event: no content, but the
     message id and the customer's WhatsApp id. It never changes the previous owner's data.
   - Messages customers send after the move belong to the new owner, by design.
   - Deliveries for a number that is not registered yet are acknowledged and dropped, so the
     connection flow must register the number before subscribing the app to the WABA's
     webhooks.
5. **Maximum-size delivery.** A delivery at the limits (1000 events, close to 3 MiB) has not
   been tested against Convex transaction and argument limits; tests cover the 413 refusal and
   small batches only. If Convex ever rejects the ingest arguments, its error message (which may
   include argument values, i.e. message text) could reach deployment logs; the HTTP action
   itself logs nothing.

## Real-account validation required

Checked once (2026-10-23, Meta test app in Development mode, one inbound text message, before
the hardening steps): the verification handshake; the signature header and format over the
exact body bytes; and, for a text message, `entry[].id` = the registered WABA id,
`metadata.phone_number_id`, the text body and a timestamp in Unix seconds.

Everything below is still modeled on Meta's documentation and unverified:

- `contacts[].profile.name`, message types other than text, `statuses[]` and `errors[].code`;
- status values (`sent`, `delivered`, `read`, `failed`) and their real ordering;
- batch sizes, the 3 MB payload ceiling and Meta's retry schedule for non-200 responses;
- whether a WABA id ever differs between webhook `entry[].id` and the registered value;
- Embedded Signup end to end (never run): the code exchange, the `debug_token` fields for a
  business integration token (`granular_scopes` WABA ids, `expires_at`), the `subscribed_apps`
  and `register` answers, Meta's error codes for a reused code, a PIN mismatch, a rate limit or a
  refused business token (190 / 102 / 401 assumed), when a 133016 limit clears, and whether
  re-subscribing an already subscribed WABA is harmless;
- partner removal (never seen): who receives `PARTNER_REMOVED`, its real shape, and what
  `GET /{waba}` answers with the customer's token afterwards ("Partner removal");
- sending (never run, below): `to` as `+` and the webhook `wa_id`, the send answer's shape,
  statuses that arrive before the send result, where 131047 is reported (send answer or
  `failed` status), the template listing with the business token, URL button values sent
  without `parameter_name` in NAMED templates, and line breaks in template values.

### Live check: sending (ADR 0015)

Not run yet. A run needs its own approval and test assets only: a number connected through
Embedded Signup on a non-production deployment (an operator-managed number cannot send), a test
recipient's phone, and templates made for the test in WhatsApp Manager. Read message and event
rows in the Convex dashboard's data view, and record each step's outcome here. Wait at least
6 seconds between two sends to the same phone (Meta's pair rate limit, 131056).

Before: from the test phone, write to the business number, so the conversation exists and its
reply window is open. Have APPROVED templates ready: one POSITIONAL with body variables, one
NAMED, one with a TEXT header variable, one with a URL button ending in a variable, and one with
nothing to fill in.

1. **Text reply.** Reply from the conversation page. Expect `pending`, then `submitted` with a
   wamid, then `sent`, `delivered` and `read` as the phone receives and opens it. Checks the
   recipient format, the answer's shape (`messages[0].id`) and the real status order.
2. **Early statuses.** The reply must reach `sent` or later either way. To tell whether the
   status came before the send result (and the replay applied it), compare the
   `status:<wamid>:sent` event's `receivedAt` with the time of the `recordSendResult` run in the
   Convex dashboard's function logs (runs and times only). Note which happened.
3. **Repeated or late statuses.** A status Meta delivers again, or a `delivered` after `read`,
   changes nothing.
4. **Templates.** Open "Choose a template": the approved templates are listed (this checks the
   listing with the business token), unsupported ones with their reason. Send each prepared
   template with distinct values. Expect `submitted` and statuses, and on the phone each value
   in its place: positional in order, named by name, the header, and the URL button opening the
   link with its value (this checks the button value without `parameter_name` in a NAMED
   template).
5. **Line breaks in values (optional).** The page's fields take one line, but `sendTemplate`
   accepts any text and Meta documents no rule for line breaks, tabs or repeated spaces. Send
   one such value through the API once and record whether Meta refuses it (132000 / 132018) or
   delivers it.
6. **Window closed.** More than 24 hours after the customer's last message the page offers only
   templates, and `sendText` is refused (`service_window_closed`) without a Meta call. Meta's
   own 131047 shows only when the window closes between queuing and delivery; record where it
   appears if it ever does.
7. **Failures in fixed words.** For any send that fails, the page shows the fixed text for its
   code, and the row keeps only `errorCode` and `failureReason`.
8. **Isolation and roles.** A member of another org opening the conversation's URL gets the
   not-found page; a viewer of the same org sees the thread without the composer.
9. **Logs.** The deployment's logs for the run show no message text, template value, token,
   phone number or customer id.

Covered in-process only: `unknown` (Meta never answering), the watchdog, a refused token moving
the connection to `needs_reauth`, and a repeated `clientMessageId`.
