# ADR 0014 — WhatsApp connections (Embedded Signup)

- Status: in progress. B1 (data model, internal state changes, guards on the generic connection
  paths) and B2 (Embedded Signup action, WhatsApp Graph client, public API) are implemented and
  tested in-process against a fake Graph; B3 (the connect page, now `/whatsapp/settings`, Meta's
  JavaScript SDK and the signup hand-off) is implemented and tested against a fake SDK; B4
  (disconnect and its Meta cleanup) and B4b (Meta's `PARTNER_REMOVED` webhook) are implemented
  and tested against the fake Graph and signed fake deliveries. Nothing in this flow has run
  against Meta.
- Date: 2026-10-24

## Context

Customers connect their own WhatsApp Business numbers through Meta Embedded Signup, with this
app as a Tech Provider ([ADR 0013](0013-whatsapp-inbox.md) covers the inbox and webhook). The
existing connection layer ([ADR 0005](0005-connections-and-credentials.md)) stores encrypted
credentials per connection and connects OAuth providers only through single-use,
claim-protected grants (S2).

Facts from Meta's documentation, read on 2026-10-24 (Embedded Signup overview, implementation,
versions and "Onboarding customers as a Tech Provider"; "Manage accounts"; "Phone numbers";
registration):

- The browser calls `FB.login` with our login configuration: `config_id`,
  `response_type: "code"`, `override_default_response_type: true` and
  `extras: { setup: {} }`. It receives a `code` valid for 30 seconds. A `WA_EMBEDDED_SIGNUP` message event reports `FINISH` with the
  `phone_number_id`, `waba_id` and `business_id`, or `CANCEL` / an error.
- The server (never the browser) exchanges the code: `GET /oauth/access_token` with
  `client_id`, `client_secret` and `code`. The result is a business integration system user
  token.
- Then: `POST /{waba_id}/subscribed_apps` subscribes our app to the WABA's webhooks;
  `POST /{phone_number_id}/register` with `{ messaging_product: "whatsapp", pin }` registers the
  number for Cloud API, and the 6-digit PIN becomes its two-step verification PIN. Both answer
  `{ "success": true }`. The customer adds a payment method in Meta's tools.
- `debug_token` (authorized with the app token) lists, in `granular_scopes`, the WABA ids the
  customer granted for `whatsapp_business_management`. No documented field names the WABA's
  owning business.
- A number allows 10 register / deregister calls per 72 hours (error 133016). A number that
  already has a two-step PIN must be registered with that PIN.
- Embedded Signup v5 is the latest version (since 2026-10-20); v4 is selected through the login
  configuration.
- Not documented: whether `subscribed_apps` is idempotent.

## Decisions

1. **A stored connection with provider `whatsapp`, keyed by the WABA id** (D1, revised in B2).
   The WABA is the asset Meta lets us verify; the browser's `business_id` is not used at all.
   One connection, credential and account row per (org, WABA). The credential (AES-256-GCM, AAD
   `orgId|whatsapp|wabaId|v1`) holds `{ kind: "whatsapp", v: 1, accessToken, pin }`.
   `CONNECTION_PROVIDERS`, the OAuth set, is unchanged; `STORED_CONNECTION_PROVIDERS` adds
   `whatsapp` for stored connections, their credential binding and the connection DTO only. So
   OAuth states, grants, `beginConnect` and claims can never carry `whatsapp`, the Meta Ads,
   Google Ads and Instagram code paths and env vars are untouched, and every place that reads a
   stored provider handles `whatsapp` explicitly (TypeScript-enforced).
2. **The generic OAuth lifecycle refuses WhatsApp connections.** A WhatsApp connection also owns a
   WABA webhook subscription and number routing, which the generic disconnect would leave live:
   `v1/connections:disconnect` and `refreshAssets` refuse it (`INVALID_ARGUMENT`, reason
   `whatsapp_connection`), and `revokeAtPlatform` never calls an OAuth revoke for it. Its own
   offboarding is `v1/whatsapp:disconnectAccount` (decision 14).
3. **Accounts and numbers.** `whatsappBusinessAccounts` (onboarding type `cloud_api` or
   `coexistence`) is linked to the connection and records `subscribedAt` and the latest failed
   setup step (`setupError`: step and sanitized reason code). Numbers record their `source`
   (`operator` or `embedded_signup`; absent = operator), their `accountId`, when Meta accepted
   their registration (`platformRegisteredAt`) and the registration calls made
   (`registrationAttempts`).
4. **A WABA is active in at most one org** (D10), checked before anything is written through a
   ninth approved global index, `whatsappBusinessAccounts.by_waba_status`; the row found is only
   compared. A number is active in at most one org (existing global index). A reconnect in the
   same org replaces the credential and increments `credentialVersion`.
5. **Internal, plaintext-free state changes.** `whatsapp/accounts:recordConnection` stores an
   already encrypted token and creates or re-activates the connection, credential and account in
   one transaction; `whatsapp/phoneNumbers:registerForConnection` routes a number of an active
   account of the same org, with the WABA id taken from the account. Both take the org and actor
   from the caller's verified JWT (passed on by the action) and refuse `operator:` and `system:`
   labels (D13); connects are audited as `connection.connected` / `connection.reconnected`.
6. **Gate** (D9): new WhatsApp connections and setup retries stay closed on cloud deployments
   until `WHATSAPP_CONNECTIONS_ENABLED=true` (exactly), independently of
   `OAUTH_CONNECTIONS_ENABLED`. Missing or malformed Meta app configuration fails closed.
7. **Operator path kept** (D12): the operator `register` / `disconnect` remain for support; an
   operator update of an Embedded Signup number keeps its account link. Embedded Signup never
   takes over a number the org has from the operator path (any status): its two-step PIN at
   Meta is not ours. The signup is refused (`phone_number_operator_managed`) before any write,
   here or at Meta. A migration path for such numbers is not part of B2.
8. **Public API** (B2): `v1/whatsapp:getSignupConfig` (admin; the public app id, configuration
   id and versions, or `available: false`), `completeSignup` (admin action), `retrySetup`
   (admin action) and `listAccounts` (viewer). `completeSignup` takes `code`, `wabaId` and
   `phoneNumberId`; the contract test has exactly one documented exception, the argument `code`
   of this function. The code is exchanged at once and never stored, returned or logged.
9. **Server-side verification before anything is stored** (D3, revised in B2). In this order:
   the code exchange; `debug_token` must report a valid token issued to our app, with both
   WhatsApp permissions, and the WABA among the `whatsapp_business_management` grants; the WABA
   must be readable with the token (same id); the number must be one of the WABA's numbers;
   another org's active WABA or number is refused. Only then are the credential, connection,
   account and number routing written, in one transaction that checks the number again (no
   connection or account is ever left without its number). A malformed code or id never
   reaches Meta.
10. **Setup order and partial failures.** After the local writes: subscribe, then register
    (registration only after a successful subscription; never for an account without an
    active number). Each outcome is recorded; a failure leaves the account `action_required`
    with a sanitized reason (`meta_<code>`, `http_<status>`, `network`, `timeout`,
    `unexpected_response`). Inbound routing works as soon as the number is routed.
    `retrySetup` (admin-triggered only, no cron) resumes only the missing steps with the stored
    token and PIN. Each registration call needs a per-number claim (one transaction: one call
    at a time, the attempt counted before the call, 30-second expiry): at most 5 registration
    calls per number, and none for 72 hours after Meta's rate-limit error 133016 (Meta allows
    10 per 72 hours). A reconnect subscribes again and never re-registers a registered number.
    Concurrent signups for one WABA: the credential is written only if it is still the one the
    signup read its PIN from (`credentialVersion`); the later one is refused
    (`signup_in_progress`).
11. **Token and PIN** (D4, D7): the business token as Meta issues it; no WhatsApp token is
    refreshed (the token refresh job is Instagram-only). Its `expires_at`, if any, becomes
    `tokenExpiresAt`, and the generic hourly sweep moves an expired connection to
    `needs_reauth`. A token Meta refuses during setup (Graph 190 or 102, or HTTP 401: the Meta
    Ads provider's classification) moves it there too (audited, reason
    `whatsapp_token_invalid`). Then the setup status is `reauthorization_required`, nothing is
    retried with the token, and a new signup reconnects. The PIN is random (6 digits), stored
    encrypted with the token, and kept on every reconnect (also from `needs_reauth`, through
    the credential store's `allowNeedsReauth` option); a stored credential that cannot be read
    is never replaced (`stored_pin_unavailable`). Numbers that already have a two-step PIN are
    not supported in B2: their registration fails and the reason is recorded.
12. **Versions** (D5): Graph API `v26.0`, pinned separately from Meta Ads
    (`WHATSAPP_GRAPH_API_VERSION`); Embedded Signup v4 through the login configuration (no
    `extras.version`); v5 is not adopted. A separate WhatsApp Graph client
    (`convex/whatsapp/graph.ts`) reuses only `appsecret_proof` and the Graph origin from the
    Meta provider. Coexistence numbers are not in the first release (D6); the existing WhatsApp
    Meta app (D8); connecting is admin-only (D11).
13. **No simulated signup in mock mode.** Automated tests stub `fetch` with a fake Graph that
    serves the documented calls (`convex/whatsapp/fakeGraph.fixtures.ts`); it is not evidence of
    real Meta behavior.
14. **Disconnect** (B4, D1–D9): `v1/whatsapp:disconnectAccount`, admin-only, org and actor from
    the JWT (another org's account is `NOT_FOUND`), idempotent, independent of the connection
    gate. In one transaction every active number of the account stops routing (audited), the
    connection is revoked (audited) and the account is `disconnected` with its Meta cleanup
    `pending`; the credential stays for that cleanup. Conversations and messages are kept and
    stay visible (D8). The cleanup (`convex/whatsapp/offboarding.ts`) runs one attempt at a time
    (a claim, like registration): unless another org's active account or any active number in
    any org still uses the WABA (then skipped, D1; that check needs the approved global index
    `whatsappPhoneNumbers.by_waba_status`, D2), our app is unsubscribed with
    `DELETE /{waba}/subscribed_apps`. Failures are retried after 1 min, 5 min, 30 min, 2 h and
    6 h; a refused token ends it (nothing can unsubscribe with it). When it ends, done or given
    up after the last retry (D9), the credential is deleted in the same transaction. The token is
    not revoked at Meta (D3: `oauth/revoke` is documented for system users, not for business
    tokens) and numbers are not deregistered (D4). While a cleanup is pending no org can connect
    the WABA (`disconnect_in_progress`, D5); a setup call that subscribes after the disconnect
    undoes its subscription. The generic connection sweep leaves a revoked WhatsApp connection's
    credential alone for 24 hours (D6); every other provider is unchanged. Automatic disconnect
    on Meta's `account_update` `PARTNER_REMOVED` was deferred (D7) to B4b, decision 15.
15. **Partner removal** (B4b, P1–P9): Meta documents `PARTNER_REMOVED` as a WABA being
    unshared with a Solution Partner, not necessarily us, and not which apps receive it, so the
    signed event alone changes nothing (P1). The parser reads only `value.waba_info.waba_id`
    (`entry[].id` is a business id in Meta's example; the coexistence shape without `waba_info`
    is ignored, P2) and never rejects a delivery for an `account_update` change. For the one
    active account holding that WABA (approved global index
    `whatsappBusinessAccounts.by_waba_status`, now also read by the webhook, P6; none, or more
    than one, means nothing to do), the webhook reads the WABA with that org's stored token
    (`convex/whatsapp/partnerRemoval.ts`). A refused token (190 / 102 / 401) or refused WABA
    access (10 / 200 / 803 / 100 with subcode 33, assumed) disconnects the account in one
    transaction: numbers stop routing, the connection is revoked, the credential is deleted at
    once, no Meta write call, no `offboarding` record, audited as `system:whatsapp-webhook` with
    `whatsapp.partner_removed` (P3, P4). Meta still answering means another partner's removal or
    an event older than a reconnect: nothing changes. Anything else is answered 500 so that
    Meta's retry (up to 7 days) is the retry; at most 10 WABAs are checked per delivery (P9).
    The write re-checks the account, connection and credential version the check used, so a
    reconnect or an admin disconnect made meanwhile wins; a pending admin cleanup is left alone
    (P5). Only `PARTNER_REMOVED` is handled (P7); the page and DTO are unchanged (P8).

## Consequences

- `v1/connections:list` can return connections with provider `whatsapp` (additive enum value);
  five new `v1/whatsapp` functions (additive).
- Ten approved global indexes (convex/schema.test.ts); B4 added
  `whatsappPhoneNumbers.by_waba_status`; B4b reads `whatsappBusinessAccounts.by_waba_status`
  from the webhook too (no new index, no schema change).
- Meta's JavaScript SDK is loaded from `/whatsapp/settings` only (admins, signup available) but,
  like any script, stays in the page until a full reload, with the page's privileges; the app has
  no Content Security Policy yet.
- New Convex env vars (none secret): `WHATSAPP_CONNECTIONS_ENABLED`, `WHATSAPP_APP_ID`,
  `WHATSAPP_ES_CONFIG_ID`. The signup reuses `WHATSAPP_APP_SECRET`.
- Unverified until a real signup: the exact `debug_token` shape for business integration
  tokens, Meta's error codes for a PIN mismatch and for a refused business token on these
  endpoints (190 / 102 / 401 are assumed, as for Meta Ads), whether 133016 clears exactly 72
  hours after the limit was reached, whether re-subscribing is harmless, and the
  `granular_scopes` grants for a WABA shared with several apps. For B4: whether
  `DELETE subscribed_apps` is harmless to repeat, whether it removes only our app's
  subscription, what Meta does with deliveries afterwards, and whether `oauth/revoke` applies to
  Embedded Signup business tokens. For B4b: which apps receive `PARTNER_REMOVED`, whether
  `waba_info` is present for Embedded Signup customers, what `GET /{waba}` answers with the
  customer's token after a removal (the access codes are assumed) and whether access ends at
  once (a read that still succeeds right after a removal leaves the account connected), whether
  Meta removes our subscription itself, and whether re-adding the partner works at once.
- B4b needs the `account_update` field subscribed in the Meta app (Meta requires it for Embedded
  Signup); until then no partner removal is seen.
- Remaining work: B5 (Meta data-deletion callback); other `account_update` events
  (`PARTNER_APP_UNINSTALLED`, `ACCOUNT_OFFBOARDED`, `ACCOUNT_DELETED`). Outbound messages and
  templates: [ADR 0015](0015-whatsapp-messaging.md). A first real signup needs the Meta
  configuration in docs/whatsapp.md ("Connect UI: Meta configuration").
