# convex/v1 — public integration contract

Only versioned, integration-facing Convex functions live here (`api.v1.*`). The dashboard, the
`@<company>/marketing-client` SDK and parent applications all use them.

Rules, enforced by ESLint and `contract.test.ts`:

- tenancy wrappers only (`convex/lib/tenancy.ts`)
- no tenant-identifying arguments
- explicit `args` and `returns` validators
- DTOs (in `dto/`), never raw documents
- cursor pagination for lists

Breaking changes go to `convex/v2/`. Full rules: [docs/api/conventions.md](../../docs/api/conventions.md).
