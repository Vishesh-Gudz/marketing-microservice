# convex/connections

Platform connections and encrypted credentials (Phase 4). See [docs/connections.md](../../docs/connections.md) and [docs/security/credentials.md](../../docs/security/credentials.md).

- `credentialStore.ts`: THE only access to the `credentials` table and the only decryption path (`withConnectionCredential`)
- `oauthState.ts`: single-use, hashed OAuth states
- `oauthFlow.ts`: callback, discovery and revoke (actions; the only place plaintext exists)
- `assets.ts`: discovered assets and linking to `adAccounts`
- `lifecycle.ts`: disconnect and `markNeedsReauth`
- `maintenance.ts`: hourly health sweep
- `config.ts`, `returnUrls.ts`
