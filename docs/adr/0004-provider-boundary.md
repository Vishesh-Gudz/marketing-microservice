# ADR 0004 — Provider boundary: pure adapters, two-stage normalization, branded scopes

- Status: accepted
- Date: 2026-09-24

## Context

Meta Ads and Google Ads (Phases 8–9) must plug into the canonical model (ADR 0003) without touching
sync, analytics or tenancy. There is no platform API access yet, so development needs a
deterministic stand-in that exercises the same boundaries a real provider will. The Phase 1 rule
still holds: the tenant only ever comes from the verified JWT and is never a caller argument.

## Decisions

1. **Two-stage boundary.**
   - Stage one: raw platform payloads become **provider records** (canonical vocabulary, external-id
     references). This is owned by each provider.
   - Stage two: provider records become **canonical rows**. This is shared, in `convex/mapping`.
   - Raw payloads never leave a provider module.
2. **Providers are pure and tenant-free.**
   - `ProviderContext = { credential, attempt }`.
   - Records carry no `orgId`, no Convex ids and no lifecycle fields. Validation rejects unknown
     fields.
   - Providers never import database, function-builder or tenancy runtime modules (ESLint enforced).
3. **Tenant identity enters only through branded scopes.**
   - `OrgScope` comes from `ctx.tenant`.
   - `AccountScope` comes from a stored `adAccounts` document.
   - Mapping takes `orgId`, `adAccountId`, platform and currency from the scope, and rejects records
     that disagree.
4. **Typed `ProviderError` exceptions.** Retryability is derived from the kind. Unknown errors are
   not retried. Retry behavior may depend only on `ctx.attempt`.
5. **Record types derived from Phase 2 `Doc` types (type-only),** and records are validated at
   runtime against the **real table validators** (convex-helpers `validate`). They cannot drift from
   the schema.
6. **Registry built from a list**, keyed by each provider's own platform. There is no switch, and
   duplicate registrations are rejected.
7. **The mock impersonates real platforms.** There is no `"mock"` schema value. It uses Meta-like
   and Google-like raw payloads, deterministic seeded data, and failure scenarios keyed by request
   and attempt.
8. **Paid ads only.** Social providers (Phase 10) and messaging providers (Phase 11) are later
   registry families.

## Alternatives rejected

- **Result types instead of exceptions:** noisier call sites. Convex actions and Workpool retries
  already work with throws.
- **Providers writing canonical rows directly:** providers would need `orgId` and Convex ids, which
  breaks tenant-freedom and testability.
- **A `"mock"` platform:** needs a schema change, and the mock would not exercise real platform id,
  money and date shapes.
- **Zod now:** the only inputs are internal fixtures. Zod arrives with untrusted real API responses
  in Phase 8.

## Consequences

- Phase 5 must build `EntityRefResolver` from org-scoped index lookups, preserve `createdAt` on
  upsert, enforce natural-key uniqueness and cap `attributes`/`extras`.
- The contract suite (`convex/providers/contract.suite.ts`) is the acceptance gate for real
  providers.
- Mock code ships in the Convex bundle. It is pure and only registered by `createDefaultRegistry()`
  (live selection arrives in Phase 8).
