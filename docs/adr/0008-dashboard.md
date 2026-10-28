# ADR 0008 — Dashboard

- Status: accepted
- Date: 2026-09-25
- Amended by [ADR 0012](0012-standalone-saas-clerk.md): users sign in with Clerk; the Phase 15
  parent-app token handoff and embedding no longer apply.

## Context

Phase 6 exposes analytics as five public queries (`v1/analytics:*`). Phase 7 builds the internal
dashboard on them. The parent application owns authentication and hands the browser a signed JWT;
the tenant is derived from that token. The dashboard must not bypass the public API, must not add a
backend, and must present the API's explicit missing-data, currency and comparison semantics
faithfully.

## Decisions

1. **D1** Client-rendered dashboard; data only through `useQuery(api.v1.*)`. Pages are thin Server
   Components; no server-side data fetching, no route handlers.
2. **D2** No TanStack Query or state libraries: Convex `useQuery` is the cache.
3. **D3** URL search parameters are the source of truth for filters (`replace` for changes, `Link`
   for drill-downs, `useSearchParams` inside `<Suspense>`).
4. **D4** Routes under `app/(dashboard)/`; `useAnalyticsQuery` keeps previous data; per-region error
   boundaries (Next.js `catchError`).
5. **D5** `v1/analytics:overview` gains an optional `entity: {level, id}` (not combinable with
   `filters`) and returns an optional `entity` summary (the existing `EntitySummaryDto`). Foreign or
   unknown ids are `NOT_FOUND` via `getOwned`; calls without `entity` are unchanged; no new public
   function (the v1 surface stays at 18).
6. **D6** Recharts through the shadcn `chart` component; gaps for unsynced buckets, 0 for
   no-delivery buckets, dashed partial buckets; single-currency money charts only.
7. **D7** Exact money text (`Intl.NumberFormat` on decimal strings); `Number` for plotting only;
   browser locale.
8. **D8** Ten fixed KPI cards.
9. **D9** Comparison defaults to the previous period; direction semantics per metric; reason texts.
10. **D10** Data-state and reason texts; never 0 for unknown or unavailable values.
11. **D11** Reporting currency preferred, native fallback, FX notice; the client never converts.
12. **D12** Presets resolved on the client from the org time zone's today; native date inputs.
13. **D13** Automatic granularity: ≤ 62 days day, 63–182 week, > 182 month; manual override in the
    URL.
14. **D14** Server-side sort only; cursor-stack pagination; page sizes 25/50/100.
15. **D15** Error mapping; too-much-data errors offer to narrow the range.
16. **D16** Org gate: `ensure` → `me`, org context, "Not signed in" screen.
17. **D17** Connection management UI deferred; read-only freshness and a reconnect banner.
    _Amended 2026-10-20 for Google Ads and 2026-10-21 for Meta Ads (Instagram unchanged); see
    [Amendment: Google Ads connections](#amendment-2026-10-20-google-ads-connections-d17) and
    [Amendment: Meta Ads connections](#amendment-2026-10-21-meta-ads-connections-d17)._
18. **D18** `npm run dev:seed` for local demo data.
19. **D19** Playwright CI-safe specs plus local-only data specs; axe checks.
20. **D20** WCAG 2.1 AA target. **D21** Responsive layout. **D22** `/` is the Overview.
21. **D23** Frontend import guard (ESLint + lint test), an exact allowlist for `app/`,
    `components/`, `lib/`: runtime `@/convex/_generated/api`, `convex/react`,
    `convex/lib/{errors,money,dates}`, `convex/analytics/periods`; type-only `convex/server`,
    `convex/values`, `@/convex/_generated/dataModel`. Everything else is forbidden, even as a type.
22. **D24** Dark mode and internationalisation out of scope. **D25** No provider, sync or schema
    changes; D5 is the only API change.

## Alternatives rejected

- **Server-side rendering of data** (Server Components calling Convex): the user's token lives in
  the browser (parent handoff); server fetching would need a server-held credential and a second
  auth path.
- **TanStack Query / a client store:** duplicates Convex's reactive cache and invalidation.
- **Summing time-series buckets for entity headers (no D5):** breaks paired-sum KPIs and currency
  rules; a list lookup cannot guarantee the entity is on the first page.
- **Client-side sorting or re-aggregation:** would contradict the server's budgets and semantics.
- **A calendar/date library:** native date inputs and the shared pure `periods.ts` suffice.

## Consequences

- Entity pages cost one extra overview query; org-wide views over long ranges can hit
  `too_many_rows` until rollups exist (the UI offers to narrow the range).
- Data-dependent end-to-end tests need a local backend and seed data and run locally only; jsdom
  component tests cover the same states in CI.
- The parent-app token handoff and embedding remain Phase 15; the dev token source is unchanged.

## Amendment 2026-10-20: Google Ads connections (D17)

- Status: accepted (implementation on branch `feat/google-ads-connect-ui`; mock mode only)

**Context.** Testers must be able to connect their own Google Ads account in the standalone
dashboard, choose one customer account and see its analytics, without the tester CLI and without
a second Google integration.

**Decision.** D17 is revised **for Google Ads only**:

- The dashboard gets a `/connections` page ([dashboard.md](../dashboard.md#connections-google-ads-meta-ads-and-youtube)).
  Admins can connect, reconnect or disconnect Google Ads (`v1/connections:beginConnect`;
  `disconnect` after an explicit confirmation), see the discovered customer accounts
  (`listDiscoveredAssets`), link exactly one confirmed client account (`linkAdAccounts`) and
  retry discovery (`refreshAssets`). Every role sees the connection status,
  the linked accounts' read-only sync status and a link to their analytics.
- **Meta Ads and Instagram connection management stay out of the dashboard** (D17 unchanged for
  them): their reconnect banner stays read-only and the parent app drives their connections.
- No per-account unlink UI. Disconnecting the whole Google Ads connection was added on
  2026-10-21: Reconnect refuses a different Google account (`identity_mismatch`), so without it
  an org could never switch Google accounts from the dashboard.
- D1 and D23 still hold: only public v1 functions through `convex/react` (the dashboard's first
  `useAction` is `beginConnect`), no route handlers, no new import exceptions. The OAuth callback
  stays the Convex HTTP route; the dashboard only reads its fixed result parameters.
- D25 is relaxed by one additive API change: a connection's `lastError` carries an optional,
  allowlisted `reason` for Google Ads discovery failures ([connections.md](../connections.md)).

**Constraints (not solved by this amendment).**

- **Identity is local development only.** The dashboard's only token source is the dev token
  (`npm run dev:auth setup`; org `dev-org`, role `admin`), and production builds drop it. A hosted
  dashboard therefore shows "Not signed in": hosted users cannot sign in or connect real accounts
  until the Phase 15 parent-token handoff. No general application login is added.
- **Mock mode.** The work is verified against the local backend in mock mode (instant mock
  consent, mock accounts). No real Google account has been connected from the dashboard.
- **Security requirement before any public or multi-tenant launch:** the OAuth callback
  ownership gap had to be fixed first. Fixed by S2 (pending grant claimed by the initiator,
  [security/credentials.md](../security/credentials.md#oauth-callback-ownership-s2)); cloud deployments stay
  closed until `OAUTH_CONNECTIONS_ENABLED=true` is set after S2 is deployed and verified.

**Consequences.**

- The same `/connections` UI works unchanged once the parent supplies the token (Phase 15). In an
  embedded (iframe) dashboard, Google's consent page needs a top-level navigation or a popup;
  this is to be decided with Phase 15.
- Pure connection helpers live in `lib/connections/` (React-free; reusable by the Phase 14 SDK).

## Amendment 2026-10-21: Meta Ads connections (D17)

**Context.** Users must also connect their own Meta account, choose one of their Meta ad accounts
and see its data, through the same service. The Meta Ads provider, its OAuth flow, discovery,
linking and sync exist since Phase 8 (ADR 0009); only the dashboard UI was missing.

**Decision.** D17 is revised **for Meta Ads too** (Instagram unchanged):

- `/connections` has one section per ad platform, Google Ads and Meta Ads, rendered by one
  provider-aware card (`components/dashboard/connections/ad-connection.tsx`); no second card, no
  new endpoint, no new OAuth or sync code. The Meta section uses the same v1 functions with
  `provider: "meta"` and the same roles (admins act; every role sees status and linked accounts).
- Every text is the provider's own (`lib/connections/providers.ts`, `messages.ts`): a Meta
  connection never shows Google wording. Meta errors use the server's Meta reasons
  ([meta.md](../providers/meta.md#public-reasons)). Meta discovery shows the business an account
  belongs to; it has no account type or test status.
- The callback result names no provider, so the dashboard's return URL carries a display-only
  `connect=<provider>` hint that only picks the notice's wording (neutral without it).
- The reconnect banner and "Manage in Connections" on `/accounts` cover Meta Ads.
- **Instagram (organic) connection management stays out of the dashboard.**

**Constraints.** As above: local development identity only (amended by ADR 0012), and the
callback ownership gap had to be fixed before any public or multi-tenant launch (fixed by S2). No real Meta account has been connected; a live
Meta connection needs the Meta app settings, and every Meta mapping stays provisional (R1–R20).
