# convex/providers

Paid-ads platform adapters (Phase 3). Pure TypeScript: no database, no tenant data, no Convex function builders (ESLint enforced).

- `types.ts`: `AdsProvider` contract, requests, pages, provider records
- `capabilities.ts`, `errors.ts`, `pagination.ts`, `validate.ts`, `registry.ts`, `index.ts` (`createDefaultRegistry`)
- `mock/`: deterministic Meta-like and Google-like mock providers with failure scenarios
- `contract.suite.ts`: reusable contract every provider must pass

Real providers: `meta/` (Phase 8), `google/` (Phase 9). Docs: [docs/providers/architecture.md](../../docs/providers/architecture.md).
