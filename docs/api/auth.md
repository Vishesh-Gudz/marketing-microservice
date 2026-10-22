# Authentication and tenancy

The Marketing SaaS has no password or user store of its own. An **identity provider** authenticates
users and issues a **signed JWT**: **Clerk** for the dashboard (section 4), and, for
server-to-server callers, any other trusted issuer. The tenant (organization) is always derived
from that verified token. It is never taken from function arguments. (The developer SDK will use
organization-scoped API keys instead, never dashboard session tokens; a later phase.)

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

| Claim      | Required | Verified by | Rules                                                                                                                                                                        |
| ---------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iss`      | yes      | Convex      | Must exactly match a configured issuer                                                                                                                                       |
| `aud`      | yes      | Convex      | Must equal that issuer's `applicationID`                                                                                                                                     |
| signature  | yes      | Convex      | Verified against the issuer's JWKS (`kid` must match)                                                                                                                        |
| `exp`      | yes      | Convex      | Expired tokens are rejected                                                                                                                                                  |
| `sub`      | yes      | us          | User id, or `service:<name>` for server-to-server calls                                                                                                                      |
| `org_id`   | yes      | us          | The issuer's organization id (Clerk: `org_…`); 1–128 chars of `[A-Za-z0-9._:-]`                                                                                              |
| `org_role` | yes      | us          | `viewer` \| `editor` \| `admin`, or Clerk's `org:viewer` \| `org:editor` \| `org:admin`. Anything else (including Clerk's default `org:member`) is rejected, with no default |
| `org_name` | no       | us          | Display name: set when the org is provisioned and kept in sync afterwards (see below)                                                                                        |

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

The role is read from every token, so a role change takes effect with the next token (Clerk
tokens live 60 seconds by default). **Organization name:** when a verified token carries a valid
`org_name` (1–120 characters) that differs from the stored name, the stored name follows it on the
next mutation (`v1/orgs:ensure` runs on every dashboard load), audited as `org.renamed`. Without
the claim nothing changes. With Clerk the name is therefore managed in Clerk: a name set through
`v1/orgs:updateSettings` is replaced on the next request that carries `org_name`.

## 2. Tenant key: `(iss, org_id)`

An organization is identified by the issuer plus `org_id`. The ERP's org `42` and the CRM's org `42`
are two unrelated tenants, and so are a Clerk development instance's and production instance's
organizations (different issuers). Internally every tenant-owned row references our own `organizations` id;
the external id appears only in the `organizations` table.

## 3. Trusting an issuer

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

**The local dev issuer is never trusted by a cloud deployment.** `https://dev-issuer.marketing.local`
(section 8) is refused at deploy time when `AUTH_ISSUERS` contains it on a cloud deployment, and
its tokens are refused at runtime (`UNAUTHENTICATED`) on any deployment whose `CONVEX_CLOUD_URL`
is not loopback, even if it were configured by mistake.

## 4. Clerk: dashboard sign-in (standalone SaaS)

Users sign up, sign in, create organizations and invite members with **Clerk**; Convex stays the
backend. Clerk is simply one trusted issuer (sections 1–3), so nothing about tenancy changes.

**How a Clerk token is verified.** The dashboard asks Clerk for a token from the JWT template named
`convex` (`getToken({ template: "convex" })`, `lib/auth/use-clerk-convex-auth.ts`) and sends it with every
Convex call. Convex verifies the signature (Clerk's JWKS), `iss`, `aud` and `exp`; our code then
requires `sub`, `org_id` and an accepted `org_role`, an active registered issuer, and the role each
function needs. A signed-in user without an active organization gets no token at all.

**Clerk setup** (per instance: development for local development and staging, production later):

1. Enable **Organizations** and turn **Allow personal accounts** off, so every user must create or
   join an organization (Clerk's "choose organization" session task).
2. Roles: keep `org:admin`, add **`org:editor`** and **`org:viewer`**, and make `org:viewer` the default
   role for new members. `org:member` is refused by the backend.
3. A JWT template named **`convex`**, lifetime 60 s (15 minutes at most):

   ```json
   {
     "aud": "convex",
     "org_id": "{{org.id}}",
     "org_role": "{{org.role}}",
     "org_name": "{{org.name}}"
   }
   ```

   `iss`, `sub`, `exp`, `iat` and `nbf` are added by Clerk. **Confirm the `org.*` shortcodes in the
   template editor before relying on them:** Clerk's public docs list only `user.*` shortcodes;
   `{{org.id}}` and `{{org.role}}` come from Clerk's examples and must render the active
   organization's id and its `org:`-prefixed role key. A missing or invalid `org_name` is ignored.

4. Do **not** rely on Clerk's built-in "Convex integration" session token: when the session token
   itself has `aud: "convex"`, Convex's own `ConvexProviderWithClerk` sends it instead of the
   template, and it lacks `org_id`/`org_role`. The dashboard always requests the template.
5. Issuer = the instance's **Frontend API URL** (Clerk dashboard → API keys); JWKS =
   `<Frontend API URL>/.well-known/jwks.json`. Add it to `AUTH_ISSUERS` (keep any other entries),
   redeploy, then register it and allow the dashboard origin:

   ```json
   {
     "issuer": "<Frontend API URL>",
     "jwks": "<Frontend API URL>/.well-known/jwks.json",
     "applicationID": "convex",
     "algorithm": "RS256"
   }
   ```

   ```bash
   npx convex run admin/integrationApps:register "{issuer: '<Frontend API URL>', slug: 'clerk-dev', name: 'Clerk (development)'}"
   npx convex run admin/integrationApps:setAllowedReturnUrls "{issuer: '<Frontend API URL>', urls: ['https://<dashboard origin>/']}"
   ```

**Dashboard keys** (Vercel / `.env.local`): `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (public) and
`CLERK_SECRET_KEY` (server-only, used by `proxy.ts`). Every production build uses Clerk; without a
valid publishable key it stays signed out. A **production** Clerk instance requires your own domain
(not `*.vercel.app`).

**New platform connections are closed on cloud deployments** until an operator enables them after
the OAuth callback ownership fix (S2) is deployed and verified: `beginConnect` refuses
(`INVALID_ARGUMENT`, `field: "provider"`, `reason: "connections_disabled"`) and so does
`completeConnect` (`field: "claim"`) unless the Convex env var `OAUTH_CONNECTIONS_ENABLED` is
exactly `true`. Local deployments are unaffected. With S2, a connection is created only when the
user who started it claims the consent ([connections.md](../connections.md#callback-ownership-s2)).

## 5. Calling the service

Browser (React), live queries:

```ts
const convex = new ConvexReactClient(MARKETING_CONVEX_URL);
// <ConvexProviderWithAuth client={convex} useAuth={useParentAuth}>
// useParentAuth().fetchAccessToken returns the parent's JWT for this service.
```

The dashboard does exactly this with Clerk (section 4). Locally it can use the development token
instead (section 8).

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

## 6. Onboarding flow

1. Call `v1/orgs:ensure` once per org (any role; idempotent). It provisions the organization on first
   use. The dashboard calls it again after every organization switch.
2. Org-scoped queries before provisioning return `ORG_NOT_PROVISIONED`. Org-scoped mutations
   provision automatically.

## 7. Failure modes

| Situation                                   | Result                                                               |
| ------------------------------------------- | -------------------------------------------------------------------- |
| Bad signature / unknown `kid`               | Rejected by Convex (`InvalidAuthHeader`) before any function runs    |
| Expired token                               | Rejected by Convex (`InvalidAuthHeader`)                             |
| Unknown `iss` or wrong `aud`                | Rejected by Convex (`NoAuthProvider`)                                |
| No token                                    | `UNAUTHENTICATED`                                                    |
| Missing/invalid `org_id`, `org_role`, `sub` | `INVALID_TOKEN_CLAIMS` (also Clerk's `org:member`, or no active org) |
| Dev-issuer token on a cloud deployment      | `UNAUTHENTICATED`                                                    |
| Issuer trusted but not registered           | `APP_NOT_REGISTERED`                                                 |
| App disabled                                | `APP_DISABLED`                                                       |
| Insufficient role                           | `FORBIDDEN`                                                          |

## 8. Local development

`scripts/dev-auth.mjs` stands in for an identity provider (no Clerk needed locally):

```bash
npm run dev:auth setup                                  # keys + AUTH_ISSUERS + register app + dashboard token
npm run dev:auth -- token --org acme --role viewer      # mint any token
```

The dev issuer is `https://dev-issuer.marketing.local`. Its keys live in `.dev-keys/` (git-ignored)
and its JWKS is inlined as a `data:` URI, so no HTTP endpoint is needed. **Never configure the dev
issuer on a production deployment** (section 3: a cloud deployment refuses it anyway).

`dev:auth` and `dev:seed` only ever change the **local** deployment: their deployment-writing commands
(`apply`, `seed`, `encryption-key`, `setup`) refuse unless the Convex CLI targets a local or
anonymous deployment (inherited deploy keys and `CONVEX_DEPLOYMENT` overrides are ignored), and
`dev:seed` also requires a loopback `NEXT_PUBLIC_CONVEX_URL`. `apply` adds or replaces only the dev
issuer's `AUTH_ISSUERS` entry and keeps every other entry (e.g. the Clerk development instance); an
unreadable value is refused, never overwritten. The opt-in live tests (`npm run test:live`) likewise
refuse a non-loopback `NEXT_PUBLIC_CONVEX_URL`.

**Dev token or Clerk.** A development build with `NEXT_PUBLIC_DEV_AUTH_TOKEN` signs in with it and never
loads Clerk. To try Clerk locally, remove that line, set the Clerk development keys, and add the
Clerk development issuer to the local `AUTH_ISSUERS` (section 4).

**Identities.**

|                   | Local development                                                                                     | Dashboard (staging / production)                               |
| ----------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Who signs the JWT | `scripts/dev-auth.mjs`                                                                                | Clerk (JWT template `convex`)                                  |
| Dashboard token   | `NEXT_PUBLIC_DEV_AUTH_TOKEN` in `.env.local`: org `dev-org`, role `admin`, 30 days (`dev:auth setup`) | Short-lived Clerk token for the active organization            |
| Where it works    | The local deployment only                                                                             | Any deployment whose `AUTH_ISSUERS` trusts that Clerk instance |

The dev token is not a login: anyone using the local dashboard acts as that one admin of
`dev-org`. Production builds of the dashboard never contain it.
