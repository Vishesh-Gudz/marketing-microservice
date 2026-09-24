# convex/lib

Shared backend helpers.

- `tenancy.ts`: `orgQuery`, `orgMutation`, `orgAdminMutation`, `authedMutation`, `getOwned`
- `auth.ts`: JWT claim validation; `authIssuers.ts`: `AUTH_ISSUERS` parser
- `errors.ts`: standard `MarketingError`; `audit.ts`, `dto.ts`, `validation.ts`

- `crypto.ts`: AES-256-GCM credential encryption, key ring, secure random tokens, PKCE (actions only)
- `money.ts`: int64 micros parsing, formatting, sums, Money DTO
- `dates.ts`: DateKey (`YYYY-MM-DD`), time-zone days, ranges, buckets

KPI helpers arrive in Phase 6.
