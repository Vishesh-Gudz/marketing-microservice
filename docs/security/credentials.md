# Credential security model

## Rules

1. **Tenant.** The org comes from the verified JWT, or from a stored row created by that tenant
   (oauth state → org; connection → org). Public functions never accept an `orgId`. `OAuthSpec` and
   `AdsProvider` never see one either.
2. **Encryption at rest.**
   - AES-256-GCM with a random 96-bit IV per write.
   - **AAD = `orgId|provider|externalUserId|v1`**, so a ciphertext copied to another connection or
     org fails to decrypt.
   - One encrypted bundle per connection (`credentials`), stored as `bytes`.
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
   - only `credentialStore.ts` may name the `credentials` table
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
   - Redirect parameters are a fixed set of codes, never tokens, codes or messages.
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
   credential. The hourly sweep deletes any credential left on a revoked connection.

## Known gap: OAuth callback ownership

> **Required fix before any public or multi-tenant launch. The current connect flow is not safe
> for public access.** It is acceptable only on local and validation deployments with known test
> users.

**The gap.** `beginConnect` binds the pending OAuth state to the org, app and user (`sub`) that
called it, and the callback stores the resulting connection for that org. Nothing binds the state
to the **browser session or person that completes the platform consent**. Whoever opens a valid
authorization URL (single-use, 10-minute TTL) and consents attaches **their** platform account to
the **initiating** org. Example: an admin of org A starts a connection and gets someone else to open
the link; that person's Google Ads account becomes a connection of org A, which can then link and
sync its data. The state nonce, PKCE, the return-URL allowlist and credential encryption do not
prevent this: they protect the exchange, not the ownership.

**Today's mitigations (partial).** The dashboard follows the authorization URL in the same tab and
never displays, logs or stores it; the tester CLI redacts it and serves it through a one-time
loopback redirect. Neither stops an initiator who deliberately forwards the URL.

**Required fix (design to be approved).** The callback must not activate a connection on its own.
It stores the grant as a **pending** connection and returns a short-lived, single-use claim to the
return URL; the connection becomes active only when the **same authenticated user** (same issuer,
org and `sub` as the initiator), in the same app, confirms it through an authenticated v1 call
within a short window. Unclaimed or mismatched grants are deleted. Binding the state to the
initiating browser (a first-party cookie on the callback origin) is a complementary measure.
Tests must show that a consent completed by someone else can never become another org's active
connection.

## Global indexes (approved exceptions to "orgId first")

| Index                           | Reason                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `oauthStates.by_nonce_hash`     | The OAuth callback is unauthenticated                                                                               |
| `oauthStates.by_expires`        | The system sweep expires states across orgs                                                                         |
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

## Operational notes

- **Key rotation:** add version N+1 to `TOKEN_ENCRYPTION_KEYS`. New writes use it and old rows still
  decrypt. A re-encrypt job to retire old versions is Phase 16.
- **Production:** never configure the dev issuer or dev keys. Production must set
  `PROVIDER_MODE=live` before its first deploy; `PROVIDER_MODE` fails closed (unset on a cloud
  deployment or invalid = no provider calls, no OAuth), so production can never silently run the
  mocks ([providers/meta.md](../providers/meta.md)).
