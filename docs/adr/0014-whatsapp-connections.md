# ADR 0014 — WhatsApp connections (Embedded Signup)

- Status: in progress. B1 (data model, internal state changes, guards on the generic connection
  paths) is implemented and tested in-process. B2 (Embedded Signup action, Meta calls, public
  API) and the connect UI are not built; nothing in this flow has run against Meta.
- Date: 2026-10-24

## Context

Customers connect their own WhatsApp Business numbers through Meta Embedded Signup, with this
app as a Tech Provider ([ADR 0013](0013-whatsapp-inbox.md) covers the inbox and webhook). Facts
from Meta's documentation as read on 2026-10-23 (to be confirmed in B2): the browser receives a
signup `code` valid for 30 seconds plus the WABA, phone-number and business ids; the server
exchanges the code for a business integration system user token, which does not expire by
default; new numbers are registered with a 6-digit PIN; the app is subscribed to each WABA's
webhooks. The existing connection layer ([ADR 0005](0005-connections-and-credentials.md)) stores
encrypted credentials per connection and connects OAuth providers only through single-use,
claim-protected grants (S2).

## Decisions

1. **A stored connection with provider `whatsapp`, keyed by the Meta business id** (D1). The
   business token is that connection's credential (AES-256-GCM, AAD
   `orgId|whatsapp|businessId|v1`). `CONNECTION_PROVIDERS`, the OAuth set, is unchanged;
   `STORED_CONNECTION_PROVIDERS` adds `whatsapp` for stored connections, their credential binding
   and the connection DTO only. So OAuth states, grants, `beginConnect` and claims can never
   carry `whatsapp`, the Meta Ads, Google Ads and Instagram code paths are untouched, and every
   place that reads a stored provider handles `whatsapp` explicitly (TypeScript-enforced).
2. **The generic OAuth lifecycle refuses WhatsApp connections.** A WhatsApp connection also owns a
   WABA webhook subscription and number routing, which the generic disconnect would leave live:
   `v1/connections:disconnect` and `refreshAssets` refuse it (`INVALID_ARGUMENT`, reason
   `whatsapp_connection`), and `revokeAtPlatform` never calls an OAuth revoke for it. Its own
   offboarding comes later (B4).
3. **One account row per (org, WABA)** (`whatsappBusinessAccounts`, onboarding type `cloud_api` or
   `coexistence`), linked to the connection. Numbers record their `source` (`operator` or
   `embedded_signup`; absent = operator) and, for Embedded Signup, their `accountId`.
4. **A WABA is active in at most one org** (D10), checked before anything is written through a
   ninth approved global index, `whatsappBusinessAccounts.by_waba_status`; the row found is only
   compared. The same business may connect in several orgs with different WABAs. A reconnect in
   the same org replaces the credential and increments `credentialVersion`.
5. **Internal, plaintext-free state changes.** `whatsapp/accounts:recordConnection` stores an
   already encrypted token and creates or re-activates the connection, credential and account in
   one transaction; `whatsapp/phoneNumbers:registerForConnection` registers a number of an active
   account of the same org, with the WABA id taken from the account. Both take the org and actor
   from the caller's verified JWT (passed on by the action) and refuse `operator:` and `system:`
   labels (D13); connects are audited as `connection.connected` / `connection.reconnected`.
6. **Gate** (D9): new WhatsApp connections stay closed on cloud deployments until
   `WHATSAPP_CONNECTIONS_ENABLED=true` (exactly), independently of `OAUTH_CONNECTIONS_ENABLED`.
7. **Operator path kept** (D12): the operator `register` / `disconnect` remain for support; an
   operator update of an Embedded Signup number keeps its account link.

Decided for B2 and later, not built yet:

8. **Signup code transport** (D2): one admin-only action, `v1/whatsapp:completeSignup`, with a
   documented contract-test exception for its `code` argument; the code is exchanged at once and
   never stored or logged.
9. **Server-side verification** (D3): the WABA must belong to the token's business and the number
   to the WABA, checked with Meta using the exchanged token, before anything is stored.
10. **Token** (D4): the default non-expiring business token; revoked on disconnect; a periodic
    check marks the connection `needs_reauth`. **PIN** (D7): generated, stored encrypted with
    the token.
11. **Embedded Signup v4** (D5); coexistence numbers not in the first release (D6); the existing
    WhatsApp Meta app (D8); connecting is admin-only (D11).

## Consequences

- `v1/connections:list` can return connections with provider `whatsapp` (additive enum value).
- Nine approved global indexes (convex/schema.test.ts).
- New Convex env var: `WHATSAPP_CONNECTIONS_ENABLED` (not a secret).
- Remaining work: B2 (Embedded Signup action and Meta client, public API, contract-test
  exception), B3 (connect UI), B4 (WhatsApp disconnect, `account_update` webhooks, token health),
  B5 (Meta data-deletion callback).
