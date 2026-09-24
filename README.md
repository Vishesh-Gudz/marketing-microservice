# Marketing Microservice

Standalone, multi-tenant service that connects Meta Ads, Google Ads and Instagram, normalizes their
data into one model, and exposes spend, campaign, engagement and messaging analytics.

- **Backend + database + API:** [Convex](https://convex.dev). Versioned public Convex functions
  (`convex/v1`) are the service API. No separate REST server.
- **Dashboard:** Next.js (App Router), React, Tailwind CSS, shadcn/ui.
- **Auth:** none of its own. Parent applications sign JWTs; the tenant is derived from the verified
  token (Phase 1).

## Quick start

```bash
npm install
npm run dev          # Next.js on :3000 + local Convex backend on :3210
```

Full setup, environment variables and scripts: [docs/setup.md](docs/setup.md).

## Project layout

```
app/                 Next.js routes (dashboard arrives in Phase 7)
components/          React components (components/ui = shadcn/ui primitives)
lib/                 Client-side utilities
convex/              Convex backend
  v1/                Public, versioned integration contract (Phase 1+)
  lib/               Shared backend helpers (tenancy, errors, money, dates)
  domain/            Canonical domain model (Phase 2)
  providers/         Platform adapters: mock, meta, google, instagram, metaMessaging
  connections/       OAuth + encrypted credentials (Phase 4)
  sync/              Background sync engine (Phase 5)
  analytics/         Rollups + aggregation (Phase 6)
  engagement/        Paid + organic engagement (Phases 6, 10)
  inbox/             Unified inbox / messaging (Phase 11)
  monitoring/        Alerts (Phase 12)
packages/
  marketing-client/  Developer SDK (Phase 14)
tests/               Unit setup + Playwright E2E
docs/                Setup guide and architecture decision records
```

## Scripts

| Script              | Purpose                                          |
| ------------------- | ------------------------------------------------ |
| `npm run dev`       | Next.js + Convex dev backend together            |
| `npm run typecheck` | TypeScript for app and Convex projects           |
| `npm run lint`      | ESLint                                           |
| `npm run format`    | Prettier write (`format:check` in CI)            |
| `npm test`          | All Vitest projects (`test:unit`, `test:convex`) |
| `npm run test:e2e`  | Playwright smoke tests                           |
| `npm run check`     | typecheck + lint + format check + tests          |
