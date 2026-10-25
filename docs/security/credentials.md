# Credential security model

## Rules

1. **Tenant.** The org comes from the verified JWT, or from a stored row created by that tenant
   (oauth state → org; connection → org). Public functions never accept an `orgId`. `OAuthSpec` and
   `AdsProvider` never see one either.
2. **Encryption at rest.**
   - AES-256-GCM with a random 96-bit IV per write.
   - **AAD = `orgId|provider|externalUserId|v1`**, so a ciphertext copied to another connection or
     org fails to decrypt.
   - One encrypted bundle per connection (`credentials`), stored as `bytes`. A consented but
     unclaimed credential waits in `oauthGrants` (S2) under the same AAD.
3. **Keys.**
   - `TOKEN_ENCRYPTION_KEYS` lives in the Convex env as a versioned JSON map. The highest version
     encrypts, and every listed version can decrypt, so keys can be rotated.
   - Never in `.env.local`, the repo, tables or logs.
   - A missing or malformed key **fails closed**: nothing is stored.
4. **Plaintext only inside actions.** Queries and mutations only ever handle ciphertext. The state
   nonce and PKCE verifier are generated in actions, because query and mutation randomness in
   Convex is a deterministic, seeded PRNG.
5. **A single decryption path.** `withConnectionCredential(ctx, connectionId, handle)` in
   `convex/connections/credentialStore.ts`. It refuses inactive connections and never returns the
   credential. ESLint enforces two things:
   - only `credentialStore.ts` may name the `credentials` and `oauthGrants` tables
   - only `credentialStore.ts` may import `decryptJson`
6. **OAuth state.**
   - A 256-bit nonce, stored **only as its SHA-256 hash**.
   - Single-use, with a 10-minute TTL and PKCE S256.
   - The app and org are re-validated at the callback.
   - At most 10 pending states per org.
7. **Redirects.**
   - Only to URLs in the calling app's allowlist (exact origin plus path prefix; https, or http on
     loopback).
   - Otherwise a static page with `Content-Security-Policy: default-src 'none'`.
   - Every callback response carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
   - Redirect parameters are a fixed set of codes, never tokens, authorization codes or messages.
     The one exception is the S2 claim code (`status=pending&claim=…`), a single-use capability
     that is useless to anyone but the initiating user (below).
8. **Exposure.**
   - DTOs have no secret fields. The contract test bans secret-like names in every v1 argument and
     return type.
   - Stored errors are sanitized to a kind plus a generic message. Google Ads discovery failures
     additionally carry an allowlisted public `reason` (never the platform code, which is not
     stored on the connection).
   - The dashboard follows `beginConnect`'s authorization URL in the same tab and never renders,
     logs or stores it (it carries the state nonce and the PKCE challenge); callback result
     parameters are shown only as fixed text and removed from the URL.
   - Audit entries hold only IDs, statuses and counts.
   - `console` is banned in `convex/connections/`.
9. **Deletion.** Disconnect schedules a best-effort platform revoke and then **always** deletes the
   credential. The hourly sweep deletes any credential left on a revoked connection, and any
   unclaimed grant (with its ciphertext) past its 10-minute expiry.

## OAuth callback ownership (S2)

**The problem.** `beginConnect` binds the OAuth state to the org, app and user (`sub`) that called
it, but the callback is unauthenticated: nothing ties the consent to the **person who completes
it**. Before S2 the callback created the connection for the initiating org, so anyone who opened
a valid authorization URL (single-use, 10 minutes) and consented attached **their** platform
account to that org (for example, an admin forwards the link to someone else). Nonce, PKCE, the
return-URL allowlist and encryption protect the exchange, not the ownership.

**The fix (implemented).**

1. **Consent connects nothing.** After the exchange, the callback encrypts the credential (same
   AAD as the final credential) and stores it in `oauthGrants` with the initiating org, issuer and
   `sub`, the platform identity, the scopes, a 10-minute expiry and the **SHA-256 hash** of a
   256-bit one-time claim code (`crypto.getRandomValues`, in the action). It redirects to the
   allowlisted return URL with `status=pending&claim=<code>`. `beginConnect` now requires a
   return URL, and a state without one (created before S2) is refused before any exchange.
2. **Only the initiator can claim.** `v1/connections:completeConnect` (admin; claimant from the
   verified JWT, never from arguments) looks the grant up by hash and requires the **same issuer,
   `sub` and org**, an unexpired grant and, for a reconnect, the same platform identity as the
   target connection (also checked at the callback). Then, in one transaction, it creates or
   reconnects the connection, moves the ciphertext unchanged into `credentials` and deletes the
   grant; discovery follows.
3. **Everything else is refused and cleaned up.**
   - Unknown, replayed (already claimed) or invalidated codes: `invalid_claim`, indistinguishable.
   - Another user, org or app presenting the code: `invalid_claim`, and the grant is **deleted**
     (audited `connection.claim_rejected`, reason `owner_mismatch`, recorded in the initiator's
     org as the initiator; the presenting party's identity is not copied into that audit log).
   - Expired: `expired_claim`, grant deleted (`connection.grant_expired`).
   - Reconnect identity mismatch at claim time: `identity_mismatch`, grant deleted.
   - Viewers/editors: `FORBIDDEN` from the admin-only wrapper (the grant stays for the admin).
   - The hourly sweep deletes expired grants with their ciphertext.
   - Failures are returned (not thrown) from the claim mutation so the deletion and its audit
     entry commit.
4. **Why it closes the gap.** The claim code is sent only to the browser that completed the
   consent. If that is someone other than the initiator, their session (another `sub` or org)
   cannot claim it, and their dashboard's automatic claim attempt deletes the grant. The
   initiator never receives the code. Tests: `convex/connections/ownership.test.ts` (cross-user,
   cross-org, cross-issuer, replay, expiry, roles, malformed codes, reconnect identity, sweep,
   leak scan) and the opt-in HTTP test in `tests/live/connections.live.test.ts`.

**Residual risks (accepted).**

- **Return pages must not leak the query.** The initiator chooses the return URL within the app's
  allowlist (origin + path prefix). A page under an allowlisted prefix with an open redirect, or
  one that sends the full URL to a third party before removing the code, would hand the claim to
  someone else (who still needs the initiator's session to use it). Allowlist only the
  dashboard's connections page.
- **The claim code is in the return URL** for one navigation: it can appear in that browser's
  history and, if the return page loaded third-party resources before removing it, in a
  `Referer` header (browsers default to `strict-origin-when-cross-origin`, which drops the
  query). The dashboard removes it from the URL immediately; the code is single-use, expires in
  10 minutes and is useless without the initiator's session.
- **Session switch.** If the initiator switches org (or signs in as someone else) before the
  dashboard claims, the claim is refused and the grant is deleted; they start again.

**Browser binding (evaluated, not implemented).** A complementary defence would bind the state to
the initiating browser: `beginConnect` returns a URL on the callback origin (`/oauth/start`) that
sets a `__Host-` cookie (HttpOnly, Secure, SameSite=Lax) holding a second secret, then redirects
to the platform; the callback refuses a state whose cookie is missing or different.

- Benefit: a forwarded authorization link fails at the callback, before any token exchange, so
  the platform account's token is never fetched for the wrong person.
- Costs:
  - another public HTTP route and redirect hop to secure;
  - local development: the callback origin is `127.0.0.1:3211` but Meta requires
    `http://localhost:3211`, two different cookie hosts;
  - `Secure` cookies need https (local is http);
  - third-party SDK clients would have to follow the extra hop;
  - SameSite and ITP behaviour across platform redirects must be verified per browser.
- Decision: the claim step already guarantees that only the initiator can obtain a connection, so
  browser binding is deferred. Revisit if a platform's consent screen ever lets an attacker learn
  anything from a forwarded link, or before third-party SDK clients ship.

## Global indexes (approved exceptions to "orgId first")

| Index                           | Reason                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `oauthStates.by_nonce_hash`     | The OAuth callback is unauthenticated                                                                               |
| `oauthStates.by_expires`        | The system sweep expires states across orgs                                                                         |
| `oauthGrants.by_claim_hash`     | S2: a claim may be presented from another org; it must be found to be refused **and** invalidated                   |
| `oauthGrants.by_expires`        | S2: the system sweep deletes expired grants across orgs                                                             |
| `connections.by_status_expires` | The system sweep flags expired tokens and cleans revoked credentials                                                |
| `syncAccounts.by_next_plan`     | The sync planner (Phase 5) finds due accounts across orgs; every row it returns is re-verified for tenant ownership |

`convex/schema.test.ts` fails on any other non-`orgId`-first index.

## Sync engine (Phase 5)

- The worker action uses only `withConnectionCredential`; plaintext exists only inside one provider
  call, never in mutation arguments, scheduled-function arguments, tables or logs.
- The decrypted binding's org and platform are checked against the sync run.
- `console` is banned in `convex/sync/`; stored sync errors are kind + optional platform code +
  generic message.

## Meta provider (Phase 8)

- The long-lived Meta user token lives only in the encrypted `MetaCredential` blob and is bound to
  the app id; a credential for another app is an `auth` failure.
- Graph calls send the token in the `Authorization` header with `appsecret_proof`; OAuth secrets go
  in form bodies. The only token-in-URL exception is `debug_token`'s `input_token` (pending V2).
- `console` is banned in all of `convex/providers/`. Provider errors carry only a kind, a
  numeric/internal code and a generic message.
- OAuth-failure audits carry only the D28b allowlist (`failureKind`, `failureStage`,
  `providerCode`); tokens, codes, state, secrets, URLs, messages, bodies and `fbtrace_id` are never
  stored.
- Test fixtures are synthetic; a scrub guard rejects token- and secret-shaped strings.

## Instagram provider (Phase 10)

- **Stored credential:** the long-lived Instagram token only, encrypted, in the existing store.
  Codes and short-lived tokens are never stored.
- **Refresh:** the refresh job decrypts the credential only inside its action and writes the
  new ciphertext through `credentialStore.replaceRefreshedCredential`. That write is atomic, is
  guarded by the credential version, and is audited as `connection.token_refreshed`.
- **Secret-in-URL exception:** the one approved exception covers exactly the documented GET
  forms of `graph.instagram.com/access_token` and `/refresh_access_token`, for the OAuth
  caller only. Every other Instagram request carries the token in `Authorization: Bearer`, and
  any secret-like query parameter is refused before the network
  (`providers/instagram/transport.ts`).
- **social-sdk:** it sees the token only inside the `"use node"` adapter's closure. All its
  requests go through our allowlisted fetch.

## YouTube provider (ADR 0016)

- **Stored credential:** `{kind:"youtube", v:1, refreshToken, clientId, channelId, issuedAt,
scopes}`, encrypted, in the existing store. Authorization codes, access tokens and the
  exchange response never are.
- **No refresh job:** access tokens are minted per provider call from the refresh token and live
  only in that call's memory (as for Google Ads).
- **No secret in any URL:** tokens travel in `Authorization: Bearer` or a form body (code
  exchange, refresh, revocation); the allowlisted client (`providers/youtube/client.ts`) refuses
  any token or key parameter before the network.
- **Own OAuth client:** the credential's client must be `YOUTUBE_CLIENT_ID`, and a client shared
  with Google Ads is refused, so a disconnect never revokes a Google Ads grant.
- **Revocation:** disconnect revokes the refresh token at Google, best effort, then always
  deletes the local credential.

## Operational notes

- **Key rotation:** add version N+1 to `TOKEN_ENCRYPTION_KEYS`. New writes use it and old rows still
  decrypt. A re-encrypt job to retire old versions is Phase 16.
- **Production:** never configure the dev issuer or dev keys. Production must set
  `PROVIDER_MODE=live` before its first deploy; `PROVIDER_MODE` fails closed (unset on a cloud
  deployment or invalid = no provider calls, no OAuth), so production can never silently run the
  mocks ([providers/meta.md](../providers/meta.md)).
