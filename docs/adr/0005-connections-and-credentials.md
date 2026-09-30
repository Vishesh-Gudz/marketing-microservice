# ADR 0005 — Connections and credentials

- Status: accepted
- Date: 2026-09-24

## Context

Organizations must connect platform identities (a Meta user or a Google account) through OAuth.
The resulting tokens must stay secret, tenant-bound and usable only by server code. The parent
application owns user auth (ADR 0002). Providers must stay tenant-free (ADR 0004). There is no
platform app access yet.

## Decisions

1. **Generic connection layer with mock OAuth specs.** A tenant-free `OAuthSpec` interface. The real
   Meta and Google specs are deferred to Phases 8 and 9.
2. **`beginConnect` is a public action** built with the new `orgAdminAction`. The OAuth nonce and PKCE
   verifier need cryptographically secure randomness, and query/mutation randomness in Convex is
   deterministic. Actions resolve the tenant through the internal `tenancy:resolve` query, which runs
   with the caller's verified identity.
3. **State.** Only the SHA-256 hash of the 256-bit nonce is stored. States are single-use, have a
   10-minute TTL and use PKCE S256. App and org are re-validated at the callback. The callback is an
   unauthenticated HTTP action, and the org always comes from the stored state.
4. **Credentials.**
   - One AES-256-GCM encrypted bundle per connection.
   - AAD = `orgId|provider|externalUserId|v1`.
   - Versioned keys in the Convex env; a missing key fails closed.
   - Plaintext exists only inside actions.
   - `credentialStore.ts` is the single table-access and decryption path (lint-enforced).
5. **Natural keys.** `connections` is keyed by (org, provider, `externalUserId`). Reconnect updates
   that row and increments `credentialVersion`. An explicit reconnect by a different identity is
   rejected.
6. **Linking.** Only accounts the connection discovered can be linked, never manager accounts. Linking
   is a narrow, transactional `adAccounts` upsert by natural key with `connectionId`/`linkedAt`.
   Relinking across connections is allowed and audited. Unlink keeps the row and its metrics.
7. **Three approved global indexes** (the callback lookup and the system sweep). Everything else stays
   `orgId`-first, and the schema test enforces the exact list.
8. **Admin-only connection changes.** Viewers can list connections and ad accounts.
9. **An hourly health sweep** expires states, flags expired tokens and deletes credentials of revoked
   connections.

## Alternatives rejected

- **Generating the nonce in a mutation:** not cryptographically random in Convex.
- **Storing the raw nonce:** a database leak would allow completing in-flight flows.
- **Tokens as columns on `connections`:** too easy to leak through a public query. A separate
  internal table behind a single lint-guarded module is safer.
- **Encrypting in mutations:** plaintext would pass through transactional function arguments. It stays
  in actions.
- **`orgId` in the OAuth state parameter:** exposes internal IDs to platforms and browser history.

## Consequences

- Phase 5 sync uses `withConnectionCredential` and calls `markNeedsReauth` on provider `auth` errors.
- Phases 8 and 9 add real specs, app configuration and `PROVIDER_MODE=live`. Phase 11 adds Meta's
  deauthorize and data-deletion callbacks.
- Key rotation needs a re-encrypt job to retire old versions (Phase 16).
