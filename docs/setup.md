# Developer setup

## Requirements

- Node.js **22.12+** (required by Convex tooling and, later, social-sdk)
- npm 10+
- Playwright browsers for E2E: `npx playwright install chromium`

## First run

```bash
npm install
npm run dev:backend        # first run creates the Convex deployment (see below); leave it running
npm run dev:auth setup     # second terminal: dev JWT issuer (see "Authentication" below)
npm run dev:frontend       # or stop dev:backend and use `npm run dev` for both
```

`npm run dev` starts two processes:

- `dev:backend` → `convex dev`: pushes `convex/` functions, regenerates `convex/_generated`, watches
  for changes.
- `dev:frontend` → `next dev` on http://localhost:3000.

On the very first `convex dev` you choose a deployment:

- **Local, no account** (default for this repo so far): runs a Convex backend on
  `127.0.0.1:3210`, with data stored in `.convex/` (git-ignored). Non-interactive shells can use
  `CONVEX_AGENT_MODE=anonymous npx convex dev --once`.
- **Cloud dev deployment:** `npx convex login`, then `npx convex dev` and create or select a
  project. Needed later for OAuth callbacks and webhooks that must be reachable from Meta and Google.

Either way, `convex dev` writes `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL` and
`NEXT_PUBLIC_CONVEX_SITE_URL` into `.env.local`.

**Windows note:** if Convex warns that the temp directory and the project are on different drives,
set `CONVEX_TMPDIR` to a folder on the repo's drive.

## Authentication (development)

Users sign in with Clerk (see [api/auth.md](api/auth.md), section 4). Locally you do not need
Clerk: `scripts/dev-auth.mjs` stands in for an identity provider:

```bash
npm run dev:auth setup                              # all of the below in one go
npm run dev:auth keys                               # RSA key pair -> .dev-keys/ (git-ignored)
npm run dev:auth apply                              # add/replace the dev issuer in AUTH_ISSUERS (keeps others)
npm run dev:auth seed                               # register the dev issuer in integrationApps
npm run dev:auth -- token --org acme --role viewer  # mint a token for any org/role
```

`setup` also generates `TOKEN_ENCRYPTION_KEYS` in the dev deployment's Convex env (Phase 4
connections; never written to disk) and allowlists `http://localhost:3000/` as an OAuth return URL
for the dev app. It writes a 30-day `NEXT_PUBLIC_DEV_AUTH_TOKEN` (org `dev-org`, role `admin`) to
`.env.local`. Restart `dev:frontend` afterwards. The dashboard header then shows the resolved
organization, role and reporting currency. Production builds ignore this variable.

**Local only.** `dev:auth`'s deployment commands (`apply`, `seed`, `encryption-key`, `setup`) and
`dev:seed` refuse to run unless the Convex CLI targets your local (or an anonymous local)
deployment; deploy keys and `CONVEX_DEPLOYMENT` exported in the shell are ignored. `dev:seed` and the
live tests also require `NEXT_PUBLIC_CONVEX_URL` to be the local backend
(`http://127.0.0.1:3210`). Keep `.env.local` pointed at the local backend for local work; never
at a cloud or production deployment.

**Clerk locally (optional).** Remove `NEXT_PUBLIC_DEV_AUTH_TOKEN`, set the Clerk development
instance's `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in `.env.local`, add the Clerk
development issuer to the local `AUTH_ISSUERS` (`npm run dev:auth apply` keeps it) and register it
([api/auth.md](api/auth.md), section 4).

`AUTH_ISSUERS` must be set before Convex will deploy (`[]` = trust no issuer). A brand-new
deployment reports `Environment variable AUTH_ISSUERS is used in auth config file but its value was
not set`; run `npm run dev:auth setup` while `dev:backend` is running and it redeploys on the next
file change.

## Environment variables

Two separate places. Never mix them.

| Where                  | What                                                               | How                                         |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| `.env.local` (Next.js) | Public values only (`NEXT_PUBLIC_*`)                               | Written by `convex dev`; see `.env.example` |
| Convex deployment env  | All secrets (platform app secrets, encryption key, webhook tokens) | `npx convex env set NAME value`             |

Secrets never live in `.env.local`, in the repo, or in Convex tables. `.env.example` lists the
secrets introduced by each later phase.

**Provider mode (Phase 8).** The local backend runs the mock providers with `PROVIDER_MODE` unset,
exactly as before (`dev`, `dev:auth setup`, `dev:seed` are mock-only). **Every cloud deployment
must set `PROVIDER_MODE`** to `mock` or `live`; unset on a cloud deployment, or any other value, is
a configuration error (no provider calls, no OAuth). Live Meta setup:
[providers/meta.md](providers/meta.md). Live Google Ads setup (OAuth client, the Google Cloud
project's API access level, no developer token):
[providers/google-ads.md](providers/google-ads.md#setup-runbook-operator). `PROVIDER_MODE=live`
applies to every platform of a deployment, so keep the local backend in mock mode and validate live
providers on a separate deployment.

## Syncing (Phase 5)

Linking an ad account schedules its initial sync; the planner cron runs every 15 minutes. To run it
now against the mock providers:

```bash
npx convex run sync/planner:tick
npx convex run sync/admin:requestSync '{"adAccountId":"<id>"}'
npx convex run sync/admin:runStatus '{"runId":"<id>"}'
```

Details: [sync.md](sync.md).

## Dashboard demo data (Phase 7)

```bash
npm run dev:seed             # connects the mock providers, links 4 accounts, runs initial syncs
npm run dev:seed -- --resync # re-run a lookback sync for the seeded accounts
```

Local only (dev issuer, mock providers, `convex run` for the internal `sync/admin:*` functions).
Idempotent: existing connections and synced accounts are reused. It prints no tokens or codes.
The dashboard itself is described in [dashboard.md](dashboard.md).

## Tests

| Command               | Runs                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm run test:unit`   | Vitest + jsdom: `lib/`, `components/`, `app/`, `tests/unit/`                                                |
| `npm run test:convex` | Vitest + edge-runtime + `convex-test` in-memory backend: `convex/**/*.test.ts`                              |
| `npm test`            | `unit` + `convex` + `tooling` (ESLint guard tests); not `live`                                              |
| `npm run test:live`   | Real JWT + isolation over HTTP, complete syncs on the real runtime (needs `dev:backend` + `dev:auth setup`) |
| `npm run test:e2e`    | Playwright (`tests/e2e`); starts `next dev` on port 3100 itself                                             |

Convex tests don't need a running backend. The CI-safe E2E specs (`smoke`, `dashboard`) work with
or without one. The data specs are local-only: after `dev:auth setup` and `dev:seed`, run
`E2E_DASHBOARD_DATA=1 npx playwright test`.

## Conventions

- `convex/_generated/` is committed so CI can typecheck without a deployment. Run `npm run codegen`
  (or keep `convex dev` running) after changing Convex functions.
- Files with more than one dot in `convex/` (for example `*.test.ts` or `test.setup.ts`) aren't
  deployed by Convex.
- `components/ui/` is owned by the shadcn CLI (`npx shadcn@latest add <component>`) and excluded
  from Prettier to keep diffs clean.
- Architecture decisions go in `docs/adr/NNNN-title.md`.
