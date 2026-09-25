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

The service has no login. Parent applications send signed JWTs (see [api/auth.md](api/auth.md)).
Locally, `scripts/dev-auth.mjs` stands in for the parent app:

```bash
npm run dev:auth setup                              # all of the below in one go
npm run dev:auth keys                               # RSA key pair -> .dev-keys/ (git-ignored)
npm run dev:auth apply                              # convex env set AUTH_ISSUERS (JWKS as data: URI)
npm run dev:auth seed                               # register the dev issuer in integrationApps
npm run dev:auth -- token --org acme --role viewer  # mint a token for any org/role
```

`setup` also generates `TOKEN_ENCRYPTION_KEYS` in the dev deployment's Convex env (Phase 4
connections; never written to disk) and allowlists `http://localhost:3000/` as an OAuth return URL
for the dev app. It writes a 30-day `NEXT_PUBLIC_DEV_AUTH_TOKEN` (org `dev-org`, role `admin`) to
`.env.local`. Restart `dev:frontend` afterwards. The home page then shows the resolved organization
and role. Production builds ignore this variable.

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

## Syncing (Phase 5)

Linking an ad account schedules its initial sync; the planner cron runs every 15 minutes. To run it
now against the mock providers:

```bash
npx convex run sync/planner:tick
npx convex run sync/admin:requestSync '{"adAccountId":"<id>"}'
npx convex run sync/admin:runStatus '{"runId":"<id>"}'
```

Details: [sync.md](sync.md).

## Tests

| Command               | Runs                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm run test:unit`   | Vitest + jsdom: `lib/`, `components/`, `app/`, `tests/unit/`                                                |
| `npm run test:convex` | Vitest + edge-runtime + `convex-test` in-memory backend: `convex/**/*.test.ts`                              |
| `npm test`            | `unit` + `convex` + `tooling` (ESLint guard tests); not `live`                                              |
| `npm run test:live`   | Real JWT + isolation over HTTP, complete syncs on the real runtime (needs `dev:backend` + `dev:auth setup`) |
| `npm run test:e2e`    | Playwright (`tests/e2e`); starts `next dev` on port 3100 itself                                             |

Convex tests don't need a running backend. The E2E smoke test works with or without one.

## Conventions

- `convex/_generated/` is committed so CI can typecheck without a deployment. Run `npm run codegen`
  (or keep `convex dev` running) after changing Convex functions.
- Files with more than one dot in `convex/` (for example `*.test.ts` or `test.setup.ts`) aren't
  deployed by Convex.
- `components/ui/` is owned by the shadcn CLI (`npx shadcn@latest add <component>`) and excluded
  from Prettier to keep diffs clean.
- Architecture decisions go in `docs/adr/NNNN-title.md`.
