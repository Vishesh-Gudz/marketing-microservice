# ADR 0002 — Tenant identity from the verified JWT (issuer + org_id)

- Status: accepted
- Date: 2026-09-24

## Context

The service is multi-tenant and is embedded by several parent applications (ERP, CRM, …), each with
its own users and organization ids. The service must not run its own authentication, and must never
trust a client-supplied organization id.

## Decision

- **Verification:** Convex `customJwt` providers, configured from the `AUTH_ISSUERS` env var. Convex
  verifies the signature (JWKS), `iss`, `aud` (`applicationID`, mandatory) and `exp` before any
  function runs.
- **Claims:** `sub`, `org_id` and `org_role` are required; `org_name` is optional.
- **Tenant key:** the issuer plus `org_id`, stored on `organizations` (`by_issuer_external`). All
  tenant-owned rows reference `organizations._id`.
- **App registry:** `integrationApps` must hold an active row for the issuer (kill switch without a
  redeploy).
- **Enforcement:** every public function lives in `convex/v1` and is built with a tenancy wrapper
  (`orgQuery`, `orgMutation`, `orgAdminMutation`, `authedMutation`) that injects `ctx.tenant`. The
  guards:
  - an ESLint rule forbids raw builders in `convex/v1`
  - a contract test forbids tenant-like arguments and requires validators and DTO returns
  - `getOwned()` returns `NOT_FOUND` for other tenants' rows
- **Provisioning:** idempotent `v1/orgs:ensure`. Mutations auto-provision; queries on an unknown org
  return `ORG_NOT_PROVISIONED`. Convex's serializable transactions guarantee one row per tenant key.
- **Audit:** successful state changes are written in the same transaction.

## Alternatives rejected

- **`org_id` as a function argument, checked against the token:** redundant, and easy to get wrong.
- **Tenant = `org_id` only:** collides across parent apps.
- **An auth provider inside the service (Clerk, Auth.js):** duplicates the parent's identity system.
- **API keys:** Convex has no native API-key auth, and keys would force tenant ids into arguments.

## Consequences

- `AUTH_ISSUERS` must be set on every deployment (`[]` = trust nobody). Adding a parent app takes an
  env change, a redeploy and `admin/integrationApps:register`.
- Failed mutations leave no audit row. That is correct, because nothing changed.
- `ctx.db` inside wrappers is not row-level filtered. Isolation relies on the owned-lookup helper,
  index-scoped queries and cross-tenant tests. Row-level-security wrappers are a candidate for
  Phase 16 hardening.
