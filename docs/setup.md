# Developer setup

## Requirements

- Node.js **22.12+** (required by Convex tooling and, later, social-sdk)
- npm 10+
- Playwright browsers for E2E: `npx playwright install chromium`

## First run

```bash
npm install
npm run dev
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

## Environment variables

Two separate places. Never mix them.

| Where                  | What                                                               | How                                         |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| `.env.local` (Next.js) | Public values only (`NEXT_PUBLIC_*`)                               | Written by `convex dev`; see `.env.example` |
| Convex deployment env  | All secrets (platform app secrets, encryption key, webhook tokens) | `npx convex env set NAME value`             |

Secrets never live in `.env.local`, in the repo, or in Convex tables. `.env.example` lists the
secrets introduced by each later phase.

## Tests

| Command               | Runs                                                                           |
| --------------------- | ------------------------------------------------------------------------------ |
| `npm run test:unit`   | Vitest + jsdom: `lib/`, `components/`, `app/`, `tests/unit/`                   |
| `npm run test:convex` | Vitest + edge-runtime + `convex-test` in-memory backend: `convex/**/*.test.ts` |
| `npm test`            | Both projects                                                                  |
| `npm run test:e2e`    | Playwright (`tests/e2e`); starts `next dev` on port 3100 itself                |

Convex tests don't need a running backend. The E2E smoke test works with or without one.

## Conventions

- `convex/_generated/` is committed so CI can typecheck without a deployment. Run `npm run codegen`
  (or keep `convex dev` running) after changing Convex functions.
- Files with more than one dot in `convex/` (for example `*.test.ts` or `test.setup.ts`) aren't
  deployed by Convex.
- `components/ui/` is owned by the shadcn CLI (`npx shadcn@latest add <component>`) and excluded
  from Prettier to keep diffs clean.
- Architecture decisions go in `docs/adr/NNNN-title.md`.
