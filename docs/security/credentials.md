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
   - Stored errors are sanitized to a kind plus a generic message.
   - Audit entries hold only IDs, statuses and counts.
   - `console` is banned in `convex/connections/`.
9. **Deletion.** Disconnect schedules a best-effort platform revoke and then **always** deletes the
   credential. The hourly sweep deletes any credential left on a revoked connection.

## Global indexes (approved exceptions to "orgId first")

| Index                           | Reason                                                               |
| ------------------------------- | -------------------------------------------------------------------- |
| `oauthStates.by_nonce_hash`     | The OAuth callback is unauthenticated                                |
| `oauthStates.by_expires`        | The system sweep expires states across orgs                          |
| `connections.by_status_expires` | The system sweep flags expired tokens and cleans revoked credentials |

`convex/schema.test.ts` fails on any other non-`orgId`-first index.

## Operational notes

- **Key rotation:** add version N+1 to `TOKEN_ENCRYPTION_KEYS`. New writes use it and old rows still
  decrypt. A re-encrypt job to retire old versions is Phase 16.
- **Production:** never configure the dev issuer or dev keys. `PROVIDER_MODE=live` (real OAuth specs)
  arrives in Phase 8. Until then, deployments use mock OAuth only.
