# Frontend revamp safety net

Playwright specs that record how the dashboard looks and who can do what before the Gudz Marketing frontend revamp changes anything. Plan: `.claude/plans/marketing-app-frontend-revamp-plan.md` (local).

**Local only**, like `tests/e2e/dashboard-data.spec.ts`:

```bash
npm run dev:backend        # local Convex backend (keep it running; first start can take minutes)
npm run dev:auth setup     # dev issuer + dashboard token for "dev-org" (admin), once
npm run test:revamp        # starts `next dev` on :3200 unless one is running there
npm run test:revamp:update # re-record after an intended change, then review the diff
```

The suite reads whatever `dev-org` holds on your local backend. The committed baselines were recorded on 4 Nov 2026 with:

- **Ad accounts:** Google Ads USD and JPY active, EUR closed; Meta USD and IDR active.
- **Instagram:** two mock accounts.

All of these came from earlier `npm run dev:seed` runs.

`dev:seed` itself needs the mock providers (`PROVIDER_MODE=mock` on the local deployment). It fails with "Connecting meta failed" while the deployment is in `live` mode for real OAuth testing. A different local database gives different screenshots, so record your own baseline first on unchanged `main`.

Next.js allows one `next dev` per project folder. Stop your own dev server first, or start it on port 3200 so the suite reuses it.

| Spec                | What it pins down                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visual.spec.ts`    | Every route (and the sign-in, sign-up and choose-organization frames) at 1440/1024/768/375 px, plus the accounts popover, saved-reply form, Instagram template builder and phone menu |
| `roles.spec.ts`     | Viewer, editor and admin of the same organization: role badge, connect, saved replies, templates, WhatsApp settings                                                                   |
| `a11y.spec.ts`      | axe (WCAG 2.2 A/AA) violations per route, kept as text snapshots                                                                                                                      |
| `shell.spec.ts`     | The app shell: no sideways scroll at 5 widths, ⌘K page search, sidebar rail kept after reload, phone dock and menu, the organization loader (Convex held back)                        |
| `overview.spec.ts`  | The Overview briefing: Needs attention between the filters and the key metrics; one connect prompt when the organization has no ad accounts (the reply rewritten on the socket)       |
| `analytics.spec.ts` | The analytics workspaces: the phone Filters sheet (a change applies at once) and the chart y axis in the metric format                                                                |
| `organic.spec.ts`   | The organic pages: Instagram and YouTube read top to bottom, post rows carry a type glyph (never an image), and no organic page scrolls sideways on a phone                           |

How it stays deterministic:

- **Fixed browser clock.** It is frozen at 4 Nov 2026 12:00 UTC (`support.ts`), so date presets resolve to the same window of already-synced seed data.
- **Masked sync text.** Text that moves with background syncs ("last synced", freshness notes) is masked.
- **Role tokens.** `global-setup.ts` mints viewer and editor tokens with the local dev issuer and writes them to `test-results/` (git-ignored). The fixture swaps them into the Convex client's `Authenticate` message, so no app code changes for tests.

Known limits:

- **Dev auth, not Clerk.** The dashboard runs in dev-token mode, so the shell has no Clerk switcher (sidebar) or user menu (top bar), and `/organization`, `/sign-in`, `/sign-up` and `/session-tasks/choose-organization` show their dev-mode states inside the real frame. The Clerk screens are checked on a preview deploy in the final QA phase.
- **No messaging data.** The seed has no WhatsApp or Instagram DM conversations, and the WhatsApp deployment flag is off locally. The inbox and conversation screens are recorded in their empty and settings states only, and the WhatsApp role check is skipped.
- **Data can move.** If the local backend re-syncs or changes a connection's state (for example to `needs_reauth`), screenshots change too. Re-record on `main` before comparing a branch.
- **Per-platform screenshots.** Font rendering differs between operating systems; the committed baseline is `win32`.
- **Subtle colours.** Playwright treats pixels within its colour threshold as equal, so a change between near-whites (canvas `#f6f7f9` vs white) can pass without a diff. After such a change, re-record with `npx playwright test -c playwright.revamp.config.mts --update-snapshots=all` and review the images (then restore any shot outside the change that was only re-encoded).
