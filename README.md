# Marketing Microservice

Standalone, multi-tenant service that connects Meta Ads, Google Ads and Instagram, normalizes their
data into one model, and exposes spend, campaign, engagement and messaging analytics.

- **Backend + database + API:** [Convex](https://convex.dev). Versioned public Convex functions
  (`convex/v1`) are the service API. No separate REST server.
- **Dashboard:** Next.js (App Router), React, Tailwind CSS, shadcn/ui.
- **Auth:** none of its own. Parent applications sign JWTs. The tenant (issuer + `org_id`) is derived
  from the verified token. See [docs/api/auth.md](docs/api/auth.md).

## Quick start

```bash
npm install
npm run dev:backend      # local Convex backend on :3210 (keep running)
npm run dev:auth setup   # dev JWT issuer + dashboard token (second terminal)
npm run dev:frontend     # Next.js on :3000
```

Full setup, environment variables and scripts: [docs/setup.md](docs/setup.md).

## Project layout

```
app/                 Next.js routes (dashboard arrives in Phase 7)
components/          React components (components/ui = shadcn/ui primitives)
lib/                 Client-side utilities
convex/              Convex backend
  v1/                Public, versioned integration contract (orgs, audit)
  admin/             Internal operator functions (integration app registry)
  lib/               Shared backend helpers (tenancy, errors, audit, DTO, money, dates)
  domain/            Canonical domain model: enums, validators, metric catalog, identity
  tables/            Table definitions composed by schema.ts (tenancy, ads, metrics, social)
  providers/         Platform adapters: contract, registry, errors, mock (meta, google later)
  mapping/           Provider records -> canonical rows (branded tenant scopes)
  connections/       OAuth + encrypted credentials (Phase 4)
  sync/              Background sync engine (Phase 5)
  analytics/         Rollups + aggregation (Phase 6)
  engagement/        Paid + organic engagement (Phases 6, 10)
  inbox/             Unified inbox / messaging (Phase 11)
  monitoring/        Alerts (Phase 12)
packages/
  marketing-client/  Developer SDK (Phase 14)
tests/               Unit setup + Playwright E2E
scripts/             dev-auth.mjs (local stand-in for a parent app's JWT issuer)
docs/                Setup, data model, providers, API conventions + auth contract, ADRs
```

## Scripts

| Script              | Purpose                                        |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Next.js + Convex dev backend together          |
| `npm run typecheck` | TypeScript for app and Convex projects         |
| `npm run lint`      | ESLint                                         |
| `npm run format`    | Prettier write (`format:check` in CI)          |
| `npm test`          | Vitest: unit, convex, tooling                  |
| `npm run test:live` | Real JWT + tenancy tests against local backend |
| `npm run dev:auth`  | Dev JWT issuer tooling (`setup`, `token`, …)   |
| `npm run test:e2e`  | Playwright smoke tests                         |
| `npm run check`     | typecheck + lint + format check + tests        |
