# Dashboard (Phase 7)

The internal dashboard is a thin, client-rendered Next.js App Router UI over the **public v1 API**.
It has no server-side data fetching, no route handlers and no backend of its own. Decision record:
[ADR 0008](adr/0008-dashboard.md).

## Architecture

- **Data (D1, D2):** every value comes from `useQuery(api.v1.*)` (`convex/react`) in the browser,
  authenticated with the parent-issued JWT. Convex `useQuery` is the only cache (reactive, deduplicated);
  there is no TanStack Query, Redux or Zustand. The only writes are on `/connections` (Google Ads:
  `useAction(beginConnect)`, `useMutation(linkAdAccounts | refreshAssets)`) and the org gate's
  `ensure`.
- **Identity (today: local development only):** the token comes from a token source
  (`lib/auth/token-source.ts`). The only implemented source is the dev token
  (`NEXT_PUBLIC_DEV_AUTH_TOKEN`, minted by `npm run dev:auth setup` for org `dev-org`, role
  `admin`); production builds drop it, so a hosted dashboard shows "Not signed in". The parent
  token handoff is Phase 15. There is no application login of its own.
- **Routes (D4, D22):** thin Server Components in `app/(dashboard)/` read `params` and render a
  client view from `components/dashboard/views/`.
- **Org gate (D16):** the shell calls `v1/orgs:ensure` once per session, then subscribes to
  `v1/orgs:me`. The org (display name, role, reporting currency, time zone) is provided through
  React context (`lib/analytics/org-context.tsx`). Pages render only once it resolves; without a
  token the gate shows "Not signed in". The org id is never sent as an argument.
- **Previous data (D4):** `useAnalyticsQuery` wraps `useQuery` and keeps the last result while new
  arguments load (dimmed, with an "Updating…" indicator) instead of flashing skeletons.
- **Error boundaries (D4, D15):** each data region is wrapped in `QueryBoundary` (Next.js
  `catchError`). Failed queries show the mapped contract error; the boundary resets when the query
  arguments change.
- **Import guard (D23):** see below.

```
app/(dashboard)/layout.tsx        Suspense + AppShell (OrgGate, nav, header)
  page.tsx                        Overview
  campaigns/page.tsx              Campaign table
  campaigns/[campaignId]/…        Campaign detail (+ ad-groups/[adGroupId])
  breakdowns/ conversions/ accounts/
  social/page.tsx                 Organic Instagram (Phase 10 Stage B)
  social/posts/[postId]/page.tsx  One Instagram post
  connections/page.tsx            Google Ads connection management (ADR 0008 amendment)
  loading.tsx error.tsx not-found.tsx
components/dashboard/             shell, filters, KPI cards, charts, tables, notices, views/
components/dashboard/organic/     organic-only KPI grid, series chart, posts table, account
                                  picker, coverage notes, Instagram link
components/dashboard/connections/ Google Ads connection status, Connect/Reconnect/Disconnect,
                                  discovered accounts + link, linked accounts' sync status
lib/connections/                  pure, React-free connection helpers: callback result, link
                                  rules, labels, messages, customer ids, return URL / navigation
lib/analytics/                    pure logic: types, format, filters, deltas, states, values,
                                  errors, chart-data, labels; hooks: use-analytics-query,
                                  use-dashboard-filters; org-context
                                  organic-*: organic types, labels/reasons, values, chart rows,
                                  URL params; permalink: the defensive Instagram link check
```

## Routes

| Route                                           | Content                                                                                  | Public functions                                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/` Overview                                    | 10 KPI cards with comparison, freshness, trend chart, spend by platform, top 5 campaigns | `overview`, `timeSeries`, `breakdown(platform)`, `performance(campaign, 5)`, `connections:list`                           |
| `/campaigns`                                    | Campaign table: server sort, cursor pages of 25/50/100, spend/conversion deltas          | `performance(campaign)`                                                                                                   |
| `/campaigns/[campaignId]`                       | Entity header + KPIs, chart, tabs: ad groups, ads, conversions                           | `overview(entity)` (D5), `timeSeries(entity)`, `performance(ad_group\|ad, parent)`, `actions(entity)`                     |
| `/campaigns/[campaignId]/ad-groups/[adGroupId]` | Same for one ad group; tabs: ads, conversions                                            | as above; the ad group's `campaignId` must match the URL                                                                  |
| `/breakdowns`                                   | Tabs by platform, account, placement (with level); spend-share bars + table              | `breakdown`, `adAccounts:list`                                                                                            |
| `/conversions`                                  | Action groups by action type, one row per attribution window; level account/campaign     | `actions`                                                                                                                 |
| `/accounts`                                     | Accounts with KPIs, currency, time zone, link/connection health, coverage, last sync     | `breakdown(account)`, `adAccounts:list`, `connections:list`                                                               |
| `/social` (nav "Organic")                       | One Instagram account: 6 headline + 7 detail KPIs, UTC series, posts (lifetime totals)   | `socialAccounts:list`/`get`, `organicAnalytics:overview`/`accountSeries`, `socialPosts:list`, `connections:list`          |
| `/social/posts/[postId]`                        | One post: caption, latest lifetime totals, lifetime totals at each capture               | `socialPosts:get`                                                                                                         |
| `/connections`                                  | Google Ads: status, Connect/Reconnect/Disconnect, discovered accounts, link, sync status | `connections:list`/`listDiscoveredAssets`/`beginConnect`/`linkAdAccounts`/`refreshAssets`/`disconnect`, `adAccounts:list` |

There is no org-wide ads page: the API requires a campaign or ad-group parent for ads (read budget).
Connection management is on `/connections` for **Google Ads only** (ADR 0008, D17 amendment).
Meta Ads and Instagram connections stay out of the dashboard. An admin can disconnect the Google
Ads connection (after a confirmation); single accounts cannot be unlinked here. The "reconnect required" banner (Overview, Accounts, Organic) links to
`/connections` only for a Google Ads connection; for Meta and Instagram it stays read-only. On
`/accounts`, unlinked or reconnect-required Google Ads accounts link to "Manage in Connections".

A foreign, unknown or malformed entity id (API `NOT_FOUND`), or an ad group opened under the wrong
campaign, renders `app/(dashboard)/not-found.tsx` inside the shell. Unmatched URLs use
`app/not-found.tsx`.

## URL state (D3)

Filters live in the URL so views are shareable and reload-safe. Filter changes use
`router.replace(…, { scroll: false })`; drill-down links carry the global filters but not page
parameters. Invalid values fall back to defaults (`lib/analytics/filters.ts`, unit-tested).

| Parameter                             | Meaning                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `preset`                              | one of the 8 `periods.ts` presets or `custom` (default `last_30_days`)   |
| `from`, `to`                          | custom range (validated like the API: real days, from ≤ to, ≤ 400 days)  |
| `compare`, `cfrom`, `cto`             | `previous` (default), `off`, or `custom` with its range                  |
| `platforms`, `accounts`               | comma-separated filters (accounts capped at 50, as the API requires)     |
| `granularity`                         | `auto` (default), `day`, `week`, `month`                                 |
| `sort`, `dir`                         | performance table sort (server-side only)                                |
| `tab`, `level`                        | breakdown/detail tab, placement or conversion level                      |
| `primaryOnly`, `window`, `actionType` | conversion filters                                                       |
| `account`                             | `/social`: the selected Instagram account id (default: the first listed) |
| `pdir`                                | `/social`: post order by publish time, `asc` (default: newest first)     |
| `status`, `warning`, `error`          | `/connections`: the OAuth callback result; read once, then removed       |
| `connection`                          | `/connections`: the callback's connection id; read once, then removed    |

Page size, pagination position and the chart metric are UI state (D2). Presets resolve against the
**org time zone's today** (`todayIn(org.timezone)`, re-checked every minute) with the shared pure
`resolvePreset`; queries never read the clock (D12). Ranges are each ad account's local days.
On `/social` the filter bar is rendered with `dayBasis="utc"`: presets resolve against **today in
UTC** (`useUtcToday`), because Instagram account metrics are keyed by UTC day; the same range
filters posts by publish day in the **org time zone** (the B2 API semantics). The paid pages keep
the default `dayBasis="org"`, unchanged.

### Automatic granularity (D13)

With `granularity=auto` the chart picks the bucket size from the inclusive range length:

| Range length  | Granularity                    |
| ------------- | ------------------------------ |
| up to 62 days | day                            |
| 63–182 days   | week (ISO weeks, Monday start) |
| over 182 days | month                          |

A manual `day`/`week`/`month` always wins. This is a presentation rule in
`lib/analytics/filters.ts` (`autoGranularity`, `effectiveGranularity`); the API accepts any
granularity for any valid range.

## Presentation rules

- **Money (D7, D11):** micros strings are formatted exactly with `Intl.NumberFormat` on decimal
  strings (bigint conversion, no floating point; exact above 2^53). The reporting-currency value is
  shown when present, else the single native value, else "Multiple currencies" with a popover of
  each native amount. The client never converts currencies. `Number` is used only for chart
  geometry and share bars. Formatting uses the browser locale (English UI copy).
  `Intl.NumberFormat.format(string)` needs a modern browser (Chrome 106+, Safari 15.4+).
- **Ratios:** API fractions shown as percents (CTR 1.23%), ROAS and value per spend as multiples
  (4.05×).
- **KPI cards (D8):** Spend, Impressions, Clicks, CTR, CPC, CPM, Conversions, Conversion value,
  Cost per conversion, ROAS.
- **Missing data (D10):** an omitted value shows "—" with the API reason (tooltip + screen-reader
  text), never 0. A `no_delivery` card says "No delivery"; table rows carry a data-state badge.
  Values from partially synced ranges carry a `*` marker and a coverage notice ("Partial: n days
  not yet synced").
- **Comparison (D9):** previous period by default. Delta chips show an arrow, the absolute change
  and the percent; cost metrics going down and volume/ROAS going up are green, spend is neutral;
  direction is always spelled out for screen readers. Reasons: `previous_zero` → "New (no previous
  value)", `previous_unavailable` → "No comparison data", `mixed_currency` → "Currencies differ".
- **Charts (D6):** Recharts via the shadcn `chart` component. Unsynced buckets are gaps, buckets
  without delivery plot 0, partial buckets are dashed with hollow points. Money is charted in one
  currency only (reporting, else a single native currency); otherwise the chart explains why it is
  unavailable. Every chart has a "View as table" alternative; animations are off.
- **Tables (D14):** only server-sortable columns sort (`aria-sort`); the client never re-sorts.
  Pagination is a cursor stack that restarts when the arguments change.
- **Conversions:** grouped by action type with one row per attribution window; windows and action
  types are never added up. Primary-only is an API filter; window and action type only choose
  which (independent) groups are shown.
- **Errors (D15):** `too_many_rows` → "This view covers too much data…" with buttons to narrow the
  range; other `INVALID_ARGUMENT` names the field; `NOT_FOUND` on entity pages → not-found page;
  auth/org errors → the org gate; unexpected errors → retry, never the raw message.

### Organic Instagram (Phase 10 Stage B)

- **Separate from paid:** `/social` uses only the organic v1 functions and organic-only
  components (`components/dashboard/organic/`); no paid KPI, chart or table is reused for organic
  values, and paid pages call no organic function. One account at a time (picker labelled
  "Instagram account"); no platform filter, no ad-account filter.
- **Values:** exactly what the API returns (`lib/analytics/organic-values.ts`); the dashboard does
  no metric arithmetic (enforced by `tests/lint/organic-dashboard-boundary.test.ts`). A missing
  value is "—" with the API reason (not reported, deprecated, non-additive, under 100 followers),
  never 0; partial values carry `*`. Unknown/unsupported states are explained, never zero-filled.
- **Headline KPIs:** Followers (latest capture, "as of …"), Follower change, Reach, Views, Total
  interactions, Engagement rate. **Engagement details:** Accounts engaged, Likes, Comments,
  Shares, Saves, Replies, Profile link taps. Reach and accounts engaged exist for one UTC day
  only; engagement rate only for one account × one UTC day ("choose Today or Yesterday"
  otherwise). Comparison chips show only the deltas the API returns.
- **Series:** UTC day/week/month buckets, gaps for missing days, dashed partial buckets; metrics
  that exist per day only explain themselves at week/month granularity. Table alternative
  labelled "Period (UTC)".
- **Posts:** lifetime totals at the latest capture ("not daily performance"); no post deltas. Each
  row links to its post page and to Instagram ("View on Instagram", new tab,
  `rel="noopener noreferrer"`) only when the stored permalink passes `safeInstagramPermalink`
  (https, `instagram.com`/`www.instagram.com`, no credentials). No media, thumbnail or profile
  image is shown. Captions render as plain text.
- **Post page:** lifetime totals at each capture day (UTC), charted and tabled as cumulative
  values, never differenced into daily performance.

## Connections (Google Ads)

`/connections` (ADR 0008, D17 amendment) is the only dashboard page that changes data. It uses
the existing public v1 functions only ([connections.md](connections.md)); the **server** decides
who may act and which accounts may be linked. The UI mirrors those rules
(`lib/connections/linkability.ts`) only to decide what to offer.

| Part                                           | Admin | Editor, viewer                                                   |
| ---------------------------------------------- | ----- | ---------------------------------------------------------------- |
| Connection status                              | yes   | yes                                                              |
| Connect / Reconnect / Disconnect               | yes   | no ("Only organization admins can …")                            |
| Discovered accounts, Link, Retry discovery     | yes   | no (`listDiscoveredAssets` is admin-only and is not even called) |
| Linked accounts, sync status, "View analytics" | yes   | yes                                                              |

1. **Status.** The page shows one Google Ads connection: the one the callback just reported, else
   the newest active one, else the newest (revoked connections are hidden; several connections
   get a "Google connection" selector). States: connected, Google Ads access missing (a required
   scope was not granted), access expires soon, reconnect required. For an active connection a
   discovery failure is explained from its allowlisted `reason`, never the server message.
2. **Connect / Reconnect.** `beginConnect` with `provider: "google_ads"`, a `returnUrl` and, for
   Reconnect, `reconnectConnectionId`. The return URL is `<origin>/connections` plus the global
   filters only; the server accepts it only if the app's allowlist covers that origin and path (local
   development: `http://localhost:3000/` and `http://127.0.0.1:3000/`). Reconnect passes the
   shown connection's id, so a different Google account is refused (`identity_mismatch`). The
   returned authorization URL is followed in the same tab (http(s) only) and is **never rendered,
   logged or stored**: it carries the single-use state and the PKCE challenge. In mock mode it is
   the callback URL itself (instant consent).
3. **Disconnect.** Admins see **Disconnect Google Ads** next to Reconnect; it first asks for
   confirmation (Cancel has focus; Escape cancels). Confirming calls `disconnect` for the shown
   connection: the server revokes it, unlinks its accounts (rows and synced data are kept), drops
   its discovered accounts and deletes the credential (no call to Google, G-D6). Meta Ads and
   Instagram connections are not touched. The page then shows "Google Ads disconnected" and
   **Connect Google Ads** starts a fresh connection, which may use any Google account. This is the
   way out of `identity_mismatch`: Reconnect only accepts the Google account that created the
   connection.
4. **Callback result.** Parsed once (`lib/connections/connect-result.ts`): connected (with the
   `discovery_failed` warning), a known error code, an unknown code, or malformed (repeated
   parameters, an invalid connection id). Each has fixed text; parameter values are never shown.
   The result parameters (and any stray `code` / `state`) are then removed with
   `router.replace`, keeping the global filters, so a reload never replays the notice.
5. **Discovered accounts.** Customer id (`123-456-7890`), name, type (manager, client, "not
   reported"), test-account status (test, not a test account, "not reported"), currency, time
   zone, account status, the manager it was discovered through (or "Direct access"), and whether
   it can be linked.
6. **Select and link.** One radio choice: only an unlinked account the platform **confirmed** as a
   client, on an active connection, can be selected. Managers, unreported account types, linked
   accounts and inactive connections are disabled with the reason as the control's description.
   The test-account status is informational and never blocks (the server does not check it;
   Google's access level decides whether a non-test account can be read). "Link selected
   account" sends exactly one id; the server's refusals (e.g. `manager_status_unknown`) appear as
   fixed text.
7. **Retry discovery.** `refreshAssets` (active connections only) runs discovery in the
   background; "Refreshing the account list…" shows until the connection changes again (success
   or a recorded error), without polling. Use it after a discovery failure, or when Google did
   not report an account's type (accounts discovered before the type was recorded read "not
   reported" until discovery runs again).
8. **Linked accounts** (every linked Google Ads account of the org): sync status from the
   read-only `sync` block (first sync scheduled, syncing, up to date, partly completed, failed
   with the failure streak, blocked, cancelled, not syncing), data coverage, last successful sync,
   next sync, and the allowlisted reason's explanation.
9. **View analytics** opens the Overview filtered to the account (`/?accounts=<id>`), keeping the
   period and clearing a platform filter.

Errors of these calls map to fixed text (`lib/connections/messages.ts`): return URL not allowed,
Google Ads not configured, account type not confirmed, not found, connection not active, too many
attempts, admins only, integration disabled, provider failure; sign-in and org errors as in D15.
Disconnect failures (admins only, connection not found, not disconnected) have their own fixed
text. Unexpected errors never show their message.

**Limitations (today):**

- **Local development only.** The only identity is the local dev token (above). Hosted users
  cannot sign in or connect real accounts until the Phase 15 parent-token handoff.
- **Mock mode only.** Verified against the local backend (`PROVIDER_MODE` unset on loopback =
  mock: instant consent, mock accounts and data). No real Google account has been connected from
  the dashboard; real-account testing needs a separate live-mode validation deployment
  ([providers/google-ads.md](providers/google-ads.md#dashboard-connection-flow)).
- **Not safe for public access.** The OAuth callback ownership gap
  ([security/credentials.md](security/credentials.md#known-gap-oauth-callback-ownership)) must be
  fixed before any public or multi-tenant launch.
- A Google account with no Google Ads access fails during the OAuth exchange
  (`exchange_failed`), not during discovery; the notice can only suggest the cause.
- Embedded (iframe) use needs a top-level or popup consent page; to be decided in Phase 15.

## Import guard (D23)

The frontend consumes application data only through the generated public API with
`convex/react`. ESLint (`eslint.config.mjs`) enforces an exact allowlist for every file in
`app/`, `components/` and `lib/`, tests included:

| Kind      | Allowed                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Runtime   | `@/convex/_generated/api`, `convex/react`, `convex/lib/errors`, `convex/lib/money`, `convex/lib/dates`, `convex/analytics/periods` |
| Type-only | `convex/server`, `convex/values`, `@/convex/_generated/dataModel`                                                                  |

Everything else is forbidden, **including type-only imports**: any other module under `convex/`
(`analytics/**` except `periods`, `connections/**`, `sync/**`, `providers/**`, `admin/**`,
`tables/**`, `schema`, `lib/crypto`, `lib/tenancy`, `v1/**`, `_generated/server`, …), and any
other part of the `convex` package (`convex/browser`, `convex/nextjs`, the root import) as well
as `convex-helpers` and `convex-test`. Relative paths (`../convex/…`) are covered too. Dashboard
types are derived from the generated `api` (`lib/analytics/types.ts`).

`tests/lint/frontend-imports.test.ts` proves that runtime and type-only imports of forbidden
modules fail, runtime imports of the type-only modules fail, the allowlist passes, lookalike
module names fail, and the current sources are clean. The dashboard's copies of the API limits
are checked against `convex/analytics/config` in `tests/unit/dashboard-limits.test.ts`, outside
the guarded directories. The organic copies (`ORGANIC_MAX_RANGE_DAYS`, `ORGANIC_MAX_PAGE_SIZE`)
and the UTC preset resolution (equal to the API's `resolveOrganicPreset` for every preset) are
checked in `tests/unit/organic-dashboard-limits.test.ts`.

## Accessibility and responsive layout (D20, D21)

Target WCAG 2.1 AA: skip link, landmarks, one `h1` per page, labelled controls, keyboard
operation, visible focus, real tables with captions and `aria-sort`, text alternatives for charts,
state never conveyed by colour alone. Sidebar from `lg`, sheet menu below; KPI grid 2/3/5 columns;
tables scroll horizontally with a sticky name column. Playwright runs axe (no serious or critical
violations) on every page.

## Local development

```bash
npm run dev:backend      # local Convex backend
npm run dev:auth setup   # dev issuer + dashboard token (org "dev-org")
npm run dev:seed         # mock Meta, Google Ads and Instagram accounts, linked and synced (idempotent)
npm run dev:frontend     # http://localhost:3000
```

`dev:seed` (local only) connects the mock providers and links four accounts (USD, IDR, USD, JPY)
through the public v1 API, then runs each initial sync with the internal `sync/admin:*` operator
functions via the Convex CLI. Re-running skips synced accounts (`--resync` forces a lookback).
Without exchange rates the mixed currencies demonstrate the FX-missing and multi-currency states.
For the organic page (development, tests and Playwright data only) it also connects the mock
Instagram users `1` (business account) and `small` (57 followers, so under-100 reasons show)
through the same public v1 functions, links them, and runs `sync/planner:tick` via the Convex CLI
until each account's first sync has finished. It uses only the mock social provider registered in
`PROVIDER_MODE=mock`; no production code path is special-cased. The mock user's consent code is
mirrored in the script and kept equal to the mock by `tests/unit/dev-seed.test.ts`.

`/connections` works the same way locally: with the admin dev token, "Connect Google Ads" goes
through the mock consent (the authorization URL is the local callback) and returns to
`http://localhost:3000/connections`. Run "Retry discovery" once for Google accounts discovered
before the account type was recorded; until then they read "Account type not reported" and
cannot be linked.

If a dynamic route unexpectedly returns 404 in `next dev` after pulling new routes, delete
`.next/dev` (a stale Turbopack dev cache) and restart.

## Tests

- Unit (Vitest + jsdom): pure logic in `lib/analytics/*.test.ts` and `lib/connections/*.test.ts`;
  components with mocked `convex/react` and `next/navigation` (`tests/unit/dashboard-harness.tsx`:
  query results, plus per-function `mockMutation(name)` / `mockAction(name)`; unregistered
  mutations fall back to the org gate's `ensureMock`). The Connections journey is covered in
  `components/dashboard/views/connections-view.test.tsx`; `tests/unit/connections-parity.test.ts`
  pins the dashboard's copies of the callback error codes and error reasons to the server's.
- Lint guards: `tests/lint/frontend-imports.test.ts`, `tests/lint/organic-dashboard-boundary.test.ts`.
- Playwright: `dashboard.spec.ts`, `social.spec.ts` and `smoke.spec.ts` are CI-safe (shell,
  navigation, gate, mobile menu, not-found, axe on every page including `/connections`).
  `dashboard-data.spec.ts`, `social-data.spec.ts` and `org-status.spec.ts` are local-only:
  `E2E_DASHBOARD_DATA=1 npx playwright test` after `dev:auth setup` and `dev:seed`. The organic
  data is mock data; no real Instagram account has been used.

### Google Ads Connections journey (local, opt-in)

`tests/e2e/connections-journey.spec.mts` drives the real dashboard through the whole Google Ads
flow against the **local** backend in **mock** provider mode: Connect → (mock consent =) OAuth
callback → discovery → select one client account → link → a sync of that one account →
"View analytics". It also replays the callback (refused, no second connection), checks that the
result notice never replays, that viewers and editors are refused every connection change
(`FORBIDDEN`), that another org sees and touches nothing (`NOT_FOUND`), axe on the populated page,
and that disconnecting cleans up.

```bash
E2E_CONNECTIONS_JOURNEY=1 npm run test:e2e:connections
```

- **Own config** (`playwright.connections.config.mts`; the default config ignores this spec): one
  worker, serial, port **3000** (the allowlisted dev return origin) with its **own** Next dev
  server bound to `127.0.0.1` only (`reuseExistingServer: false`), traces, screenshots and videos
  off. Stop your own dashboard dev server first.
- **Fail-closed guards** (before any server starts): opt-in flag, never in CI, loopback backend
  and callback URLs, the Convex CLI targets the local deployment with `PROVIDER_MODE` unset or
  `mock`, the dashboard's `NEXT_PUBLIC_CONVEX_URL` is that same deployment (its public
  `/instance_name` equals the CLI's deployment name), port 3000 free. In the browser every
  non-loopback request and WebSocket is blocked (Google included).
- **Identity:** the dashboard server keeps the developer's dev token; the spec swaps it, in memory,
  for a token of the throwaway org `e2e-google-ads` on the Convex WebSocket, and clicks nothing
  until the org badge shows "E2E Google Ads". Tokens are minted in memory and never printed or
  written. `dev-org` is only read: its connections and ad accounts are compared before and after.
- **Sync:** only `sync/admin:requestSync` for the one linked test account; never the planner.
- **Cleanup:** setup disconnects any leftover connection of the throwaway org; teardown always
  disconnects (connection revoked, credential deleted, discovered accounts deleted, account
  unlinked; further syncs are refused and the planner parks the sync state).
- **Residue (accepted, local only, throwaway orgs `e2e-google-ads` and `e2e-google-ads-other`):**
  the orgs, one revoked connection (reused by later runs), one unlinked ad account and its sync
  state, the synced mock structure and metrics (upserted, so they do not grow), and per run one
  consumed OAuth state (swept hourly), one sync run with its tasks and about seven audit entries.
  No purge function exists; only resetting the local deployment removes them.

**Recovery after a hard kill** (Ctrl+C or a crash skips teardown, so the test account may stay
linked and keep syncing mock data hourly):

```bash
npm run test:e2e:connections:cleanup
```

It runs the same guards and disconnects every non-revoked Google Ads connection of
`e2e-google-ads` (idempotent; it prints only a count). The next journey run also does this first.
If port 3000 stays busy, stop the leftover `next dev` process before running again.
