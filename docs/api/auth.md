# Authentication and tenancy for parent applications

The Marketing Microservice has no login or user store of its own. A **parent application** (ERP,
CRM, ecommerce, …) authenticates its users and sends us a **signed JWT**. The tenant (organization)
is always derived from that verified token. It is never taken from function arguments.

## 1. Token contract

RS256 (or ES256) JWT, lifetime of 15 minutes or less recommended.

```json
{
  "iss": "https://erp.acme.com",
  "aud": "marketing-service",
  "sub": "user_123",
  "org_id": "42",
  "org_role": "admin",
  "org_name": "Acme Retail",
  "iat": 1790240000,
  "exp": 1790240900
}
```

| Claim      | Required | Verified by | Rules                                                                                   |
| ---------- | -------- | ----------- | --------------------------------------------------------------------------------------- |
| `iss`      | yes      | Convex      | Must exactly match a configured issuer                                                  |
| `aud`      | yes      | Convex      | Must equal that issuer's `applicationID`                                                |
| signature  | yes      | Convex      | Verified against the issuer's JWKS (`kid` must match)                                   |
| `exp`      | yes      | Convex      | Expired tokens are rejected                                                             |
| `sub`      | yes      | us          | User id, or `service:<name>` for server-to-server calls                                 |
| `org_id`   | yes      | us          | The parent app's organization id; 1–128 chars of `[A-Za-z0-9._:-]`                      |
| `org_role` | yes      | us          | `viewer` \| `editor` \| `admin`. A missing or unknown role is rejected, with no default |
| `org_name` | no       | us          | Initial display name when the org is first provisioned                                  |

**Roles** (hierarchical: viewer < editor < admin):

- viewer: read everything in the org, including connection status (`v1/connections:list` / `get`)
  and ad accounts with their sync status (`v1/adAccounts:list`)
- editor: normal writes
- admin: org settings, the audit log, and **platform connections** (all `v1/connections:*`
  functions except `list` / `get`): `beginConnect` (start or reconnect OAuth),
  `listDiscoveredAssets` / `listDiscoveredSocialAccounts`, `linkAdAccounts` /
  `linkSocialAccounts`, `unlinkAdAccount` / `unlinkSocialAccount`, `refreshAssets` and
  `disconnect` ([../connections.md](../connections.md), including the callback-ownership fix
  required before a public launch). Alert rules come later.

The role is read from every token, so a role change takes effect with the next token.

## 2. Tenant key: `(iss, org_id)`

An organization is identified by the issuer plus `org_id`. The ERP's org `42` and the CRM's org `42`
are two unrelated tenants. Internally every tenant-owned row references our own `organizations` id;
the external id appears only in the `organizations` table.

## 3. Registering a parent application

Two steps, both required.

**a) Trust the issuer.** Add it to the `AUTH_ISSUERS` Convex environment variable (JSON array), then
redeploy:

```json
[
  {
    "issuer": "https://erp.acme.com",
    "jwks": "https://erp.acme.com/.well-known/jwks.json",
    "applicationID": "marketing-service",
    "algorithm": "RS256"
  }
]
```

- `applicationID` is mandatory. It pins `aud`, so tokens minted for other services are rejected.
- `jwks` may be an `https://` URL or a `data:` URI with the JWKS inlined.
- `AUTH_ISSUERS` must always be set (Convex refuses to deploy an auth config that reads an unset
  variable). `[]` means "trust no one": every authenticated call fails.
- Malformed values fail the deploy instead of silently trusting a bad config.

**b) Register the app.** This is internal operator tooling, never exposed to clients:

```bash
npx convex run admin/integrationApps:register '{"issuer":"https://erp.acme.com","slug":"erp","name":"Acme ERP"}'
```

**Kill switch** (takes effect immediately, no redeploy):

```bash
npx convex run admin/integrationApps:setStatus '{"issuer":"https://erp.acme.com","status":"disabled"}'
```

## 4. Calling the service

Browser (React), live queries:

```ts
const convex = new ConvexReactClient(MARKETING_CONVEX_URL);
// <ConvexProviderWithAuth client={convex} useAuth={useParentAuth}>
// useParentAuth().fetchAccessToken returns the parent's JWT for this service.
```

This is the intended parent-app integration. The standalone dashboard does not implement it yet:
its parent token source (the token handoff into an embedded dashboard) is Phase 15. Until then the
dashboard authenticates only with the local development token (section 7).

Server-to-server:

```ts
const client = new ConvexHttpClient(MARKETING_CONVEX_URL);
client.setAuth(await signServiceJwt({ sub: "service:erp-sync", org_id: "42", org_role: "viewer" }));
const org = await client.mutation(api.v1.orgs.ensure, {});
```

Any language can use the Convex HTTP API:

```bash
curl -X POST "$MARKETING_CONVEX_URL/api/mutation" -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{"path":"v1/orgs:ensure","args":{},"format":"json"}'
```

## 5. Onboarding flow

1. Call `v1/orgs:ensure` once per org (any role; idempotent). It provisions the organization on first
   use.
2. Org-scoped queries before provisioning return `ORG_NOT_PROVISIONED`. Org-scoped mutations
   provision automatically.

## 6. Failure modes

| Situation                                   | Result                                                            |
| ------------------------------------------- | ----------------------------------------------------------------- |
| Bad signature / unknown `kid`               | Rejected by Convex (`InvalidAuthHeader`) before any function runs |
| Expired token                               | Rejected by Convex (`InvalidAuthHeader`)                          |
| Unknown `iss` or wrong `aud`                | Rejected by Convex (`NoAuthProvider`)                             |
| No token                                    | `UNAUTHENTICATED`                                                 |
| Missing/invalid `org_id`, `org_role`, `sub` | `INVALID_TOKEN_CLAIMS`                                            |
| Issuer trusted but not registered           | `APP_NOT_REGISTERED`                                              |
| App disabled                                | `APP_DISABLED`                                                    |
| Insufficient role                           | `FORBIDDEN`                                                       |

## 7. Local development

`scripts/dev-auth.mjs` plays the parent application:

```bash
npm run dev:auth setup                                  # keys + AUTH_ISSUERS + register app + dashboard token
npm run dev:auth -- token --org acme --role viewer      # mint any token
```

The dev issuer is `https://dev-issuer.marketing.local`. Its keys live in `.dev-keys/` (git-ignored)
and its JWKS is inlined as a `data:` URI, so no HTTP endpoint is needed. **Never configure the dev
issuer on a production deployment.**

**Today's identity vs. the parent integration.**

|                   | Local development (today)                                                                             | Parent-app integration (target)                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Who signs the JWT | `scripts/dev-auth.mjs`, standing in for a parent app                                                  | The parent app, with its own registered issuer                           |
| Dashboard token   | `NEXT_PUBLIC_DEV_AUTH_TOKEN` in `.env.local`: org `dev-org`, role `admin`, 30 days (`dev:auth setup`) | Short-lived tokens handed over by the parent (Phase 15, not implemented) |
| Where it works    | The local deployment, or an isolated dev/validation deployment that trusts the dev issuer             | Any deployment that trusts the parent's issuer                           |

The dev token is not a login: anyone using the local dashboard acts as that one admin of
`dev-org`. Production builds of the dashboard drop it, so a hosted dashboard shows "Not signed in"
and nobody can sign in or connect accounts there until the parent token handoff exists. The
dashboard's Google Ads `/connections` page therefore runs locally only today
([../dashboard.md](../dashboard.md#connections-google-ads-and-meta-ads)).
