# Public API conventions (`convex/v1`)

`convex/v1` is the service API. The dashboard, the future `@<company>/marketing-client` SDK, and
parent applications all call the same functions.

## Function rules

1. **Tenancy wrappers only.** Define functions with `orgQuery`, `orgMutation`, `orgAdminMutation` or
   `authedMutation` from `convex/lib/tenancy.ts`. Raw `query`/`mutation`/`action` imports in
   `convex/v1` fail lint.
2. **No tenant arguments.** The org comes from `ctx.tenant` (the verified JWT). A contract test fails
   if any argument, at any depth, is named like `orgId`, `org_id`, `organizationId`, `tenantId`,
   `issuer` or `externalOrgId`.
3. **Explicit validators.** Every function declares `args` and `returns` (contract-tested).
4. **DTOs, never documents.** Return validators come from `convex/v1/dto/*`; handlers map documents
   with `toXDto()`. `_id`, `_creationTime` and `orgId` never appear in return types (contract-tested).
5. **Owned lookups.** Load any document by a client-supplied id with
   `getOwned(ctx, table, id)`. Another tenant's row is `NOT_FOUND`, never `FORBIDDEN`.
6. **Audit writes.** Mutations that change state call `writeAudit()` in the same transaction.
7. **Naming.** `v1/<resource>:<verb>`, e.g. `v1/orgs:updateSettings`.
8. **Admin tooling** lives in `convex/admin/` as internal functions (`npx convex run …`), never
   public.

| Wrapper            | Minimum role            | Org not provisioned yet |
| ------------------ | ----------------------- | ----------------------- |
| `orgQuery`         | viewer (`minRole` opt.) | `ORG_NOT_PROVISIONED`   |
| `orgMutation`      | editor (`minRole` opt.) | provisions it           |
| `orgAdminMutation` | admin                   | provisions it           |
| `authedMutation`   | any                     | provisions it           |
| `orgAction`        | viewer (`minRole` opt.) | `ORG_NOT_PROVISIONED`   |
| `orgAdminAction`   | admin                   | `ORG_NOT_PROVISIONED`   |

Actions resolve the tenant through the internal query `tenancy:resolve`, which runs with the caller's
verified identity. Use actions only for external I/O or secure randomness.

**Secrets:** no v1 argument or return type may contain secret-like fields (token, code, iv,
credential, state, …secret…, …cipher…, …verifier…, …nonce…). This is contract-tested. The Phase 4
connection functions (`v1/connections:*`, `v1/adAccounts:list`) are documented in
[../connections.md](../connections.md).

`health:ping` is the only public function outside `v1`. It is unauthenticated on purpose.

## DTOs

- `id` (string) instead of `_id`.
- Instants: ISO-8601 UTC strings (`"2026-09-24T09:11:25.946Z"`). Calendar dates: `"YYYY-MM-DD"`.
- Enums: lowercase string unions.
- Optional fields are omitted, never `null`.
- **Money:** a single amount is `MoneyDto` `{ currency, micros: string }`. Analytics money values
  (metrics and money KPIs such as `cpc`, `cpm`, `costPerConversion`) are always `MoneyAmountsDto`
  `{ native: MoneyDto[]; reporting?: MoneyDto }`.
- **Ratios** (`ctr`, `conversionRate`, `roas`, `valuePerSpend`, percent changes) are fractions
  (`0.0123` = 1.23 %), JSON numbers with at most 6 decimals. Unavailable values are omitted and
  explained in `unavailable*` lists as `{ metric | kpi, reason }`, never `null` or `0`. Every reason
  and state value is a fixed, documented enum ([../analytics.md](../analytics.md) "Public enum
  values"). Per-action KPIs use the scope's same-level spend, not row pairing
  ([../analytics.md](../analytics.md) "Action metrics").
- One module per resource in `convex/v1/dto/`: a validator (`orgDto`), its type
  (`OrgDto = Infer<typeof orgDto>`) and a mapper (`toOrgDto`).

## Pagination

Lists take `paginationOpts: { numItems, cursor }` and return:

```ts
{ page: T[]; isDone: boolean; continueCursor: string }
```

`numItems` is clamped to 1–100.

## Errors

Every expected failure is a `ConvexError` whose `data` is:

```ts
{ code: MarketingErrorCode; message: string; details?: Record<string, string | number | boolean> }
```

| Code                   | Meaning                                              |
| ---------------------- | ---------------------------------------------------- |
| `UNAUTHENTICATED`      | No token                                             |
| `INVALID_TOKEN_CLAIMS` | Verified token lacks valid `org_id`/`org_role`/`sub` |
| `APP_NOT_REGISTERED`   | Issuer trusted but not registered as an app          |
| `APP_DISABLED`         | App kill switch is on                                |
| `ORG_NOT_PROVISIONED`  | Call `v1/orgs:ensure` first                          |
| `FORBIDDEN`            | Role too low                                         |
| `NOT_FOUND`            | Missing, or owned by another tenant                  |
| `INVALID_ARGUMENT`     | Validation failed (`details.field` when applicable)  |
| `CONFLICT`             | State conflict                                       |
| `RATE_LIMITED`         | Too many requests (later phases)                     |
| `PROVIDER_ERROR`       | Meta/Google/social-sdk failure (later phases)        |
| `INTERNAL`             | Unexpected invariant violation                       |

Clients check errors with `isMarketingError(error)` from `convex/lib/errors.ts`. Unexpected
exceptions reach clients as a generic server error, so no internals leak.

## Versioning

Additive changes (new functions, new optional args or fields) are allowed in `v1`. Breaking changes go
to `convex/v2/`. The contract is formally frozen in Phase 13.

## Current surface

| Function                 | Wrapper                         | Args                                              | Returns                    |
| ------------------------ | ------------------------------- | ------------------------------------------------- | -------------------------- |
| `v1/orgs:ensure`         | `authedMutation`                | `{}`                                              | `OrgDto`                   |
| `v1/orgs:me`             | `orgQuery`                      | `{}`                                              | `OrgDto`                   |
| `v1/orgs:updateSettings` | `orgAdminMutation`              | `{ displayName?, reportingCurrency?, timezone? }` | `OrgDto`                   |
| `v1/audit:list`          | `orgQuery` (`minRole: "admin"`) | `{ paginationOpts }`                              | `Paginated<AuditEntryDto>` |

Phase 6 analytics (`v1/analytics:overview`, `timeSeries`, `performance`, `breakdown`, `actions`;
all `orgQuery`, viewer) are documented in [../analytics.md](../analytics.md). Phase 7 added one
optional argument, `entity`, and one optional response field, `entity`, to `v1/analytics:overview`
(additive; no new function). The dashboard ([../dashboard.md](../dashboard.md)) uses only these
public functions.
