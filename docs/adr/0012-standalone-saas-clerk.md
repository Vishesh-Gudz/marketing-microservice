# ADR 0012 — Standalone SaaS authentication with Clerk

- Status: S1 (Clerk sign-in, organizations, role mapping, guards) implemented and tested; S2 (OAuth
  callback ownership fix) required before real users connect platform accounts.
- Date: 2026-10-22
- Amends: [ADR 0002](0002-tenancy-from-jwt.md) (who issues the JWT) and
  [ADR 0008](0008-dashboard.md) (dashboard identity; no parent-app embedding).

## Context

The product is now a standalone, multi-tenant marketing SaaS, not a microservice embedded in parent
applications. The dashboard needs sign-up, sign-in, organizations and invitations. ADR 0002 already
derives the tenant from a verified JWT (`iss` + `org_id`) and keeps the service free of its own
password store; the dashboard only had a local development token, and the planned "parent token
handoff" (Phase 15) no longer applies.

## Decision

1. **Clerk is the identity provider** for the dashboard (D1: a Clerk development instance on the
   current Vercel domain for staging; a production instance on a custom domain later). Convex stays
   the backend and database.
2. **Keep `AUTH_ISSUERS` and `integrationApps`.** Clerk is one trusted issuer
   (`customJwt`: issuer = Frontend API URL, JWKS, `applicationID` = `convex` (D3), RS256). The dev
   and production Clerk instances are separate issuers, and the local dev issuer must stay for local
   development and tests, so the multi-issuer configuration, the per-issuer kill switch and the
   return-URL allowlist all remain useful. Nothing is removed.
3. **Token:** the Clerk JWT template `convex` carrying `org_id`, `org_role` and `org_name`. The
   dashboard always requests it (`getToken({ template: "convex" })`), never the plain session token:
   with Clerk's "Convex integration" (session token `aud: "convex"`) Convex's
   `ConvexProviderWithClerk` would send the session token, which lacks the organization claims.
4. **Roles (D2):** accept exactly `org:admin`, `org:editor`, `org:viewer` (and the unprefixed forms
   other issuers use). Clerk's default `org:member`, custom roles and anything else are refused; no
   unknown role maps to a permission. Clerk's default role for new members is `org:viewer`.
5. **Organizations required (D5):** personal accounts off; a signed-in user without an active
   organization gets no token and is sent to Clerk's "choose organization" task.
6. **Organization name (D6):** the stored display name follows a valid `org_name` claim (audited
   `org.renamed`); without the claim nothing changes.
7. **Organization switching:** a new token per (session, organization, role); the dashboard
   re-provisions (`v1/orgs:ensure`) and accepts the result only for the newly active organization.
8. **Membership management (D9):** Clerk's embedded organization profile at `/organization`.
9. **Dev/production separation (D4):** development builds with a dev token use it and never load
   Clerk; every production build uses Clerk and fails closed (signed out) without a key. The dev
   issuer is refused by cloud deployments, at deploy time and at runtime.
10. **Guards:** `dev:auth`, `dev:seed` and the live tests only touch the local deployment;
    `dev:auth apply` merges `AUTH_ISSUERS` instead of replacing it.
11. **Connections closed on cloud until S2 (D8):** `beginConnect` and `completeConnect` refuse on
    cloud deployments unless `OAUTH_CONNECTIONS_ENABLED=true`, set only after the callback
    ownership fix ([security/credentials.md](../security/credentials.md#oauth-callback-ownership-s2)) is
    deployed and verified.
12. **S2, callback ownership (D7, implemented):** the callback stores an encrypted pending grant
    and returns a one-time claim code to the return URL; only the same issuer, user and org can
    claim it (`v1/connections:completeConnect`), once, within 10 minutes. Mismatched claims
    delete the grant; the sweep deletes expired ones. Browser binding was evaluated and deferred
    ([trade-offs](../security/credentials.md#oauth-callback-ownership-s2)).
13. **Developer SDK (later):** organization-scoped API keys (hashed, revocable, scoped); dashboard
    session tokens are never accepted by the SDK API.

## Alternatives rejected

- **Replace `AUTH_ISSUERS` with Clerk's `CLERK_JWT_ISSUER_DOMAIN` setup:** same verification, but
  loses the dev issuer for local tests, the separation of Clerk instances and the issuer kill
  switch, and would rewrite tested tenancy code for no security gain.
- **Clerk's default session token (`o.id`, `o.rol`):** no `aud` unless Clerk's Convex integration
  is enabled, and no organization name; would change the claim contract.
- **Map `org:member` to viewer:** rejected in favour of explicit roles only (D2).

## Consequences

- No database change: a Clerk organization id is stored as `organizations.externalOrgId` under the
  Clerk issuer; every tenant-owned row keeps referencing the internal organization id.
- The production Clerk instance needs a domain the project owns.
- Role and membership changes take effect within one token lifetime (60 s by default).
- Hosted connections stay closed until S2.
