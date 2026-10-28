# Dashboard (Phase 7)

The internal dashboard is a thin, client-rendered Next.js App Router UI over the **public v1 API**.
It has no server-side data fetching, no route handlers and no backend of its own. Decision record:
[ADR 0008](adr/0008-dashboard.md).

## Architecture

- **Data (D1, D2):** every value comes from `useQuery(api.v1.*)` (`convex/react`) in the browser,
  authenticated with the signed-in user's JWT (Clerk, or the local dev token). Convex `useQuery` is the only cache (reactive, deduplicated);
  there is no TanStack Query, Redux or Zustand. The only writes are on `/connections` (Google Ads
  and Meta Ads: `useAction(beginConnect)`, `useMutation(linkAdAccounts | refreshAssets |
disconnect)`) and the org gate's `ensure`.
- **Identity (standalone SaaS, ADR 0012):** decided at build time (`lib/auth/mode.ts`).
  - **Clerk** (every production build, and development builds without a dev token): sign-up and
    sign-in pages (`/sign-in`, `/sign-up`), the "choose an organization" task
    (`/session-tasks/choose-organization`; personal accounts are off, so every user works inside
    an organization), the organization switcher and user menu in the header, and members,
    invitations and roles on `/organization` (Clerk's embedded organization profile). The Convex
    token is Clerk's `convex` JWT template for the active organization
    (`lib/auth/use-clerk-convex-auth.ts`); `proxy.ts` sends visitors to sign-in or to choose an
    organization, as a navigation convenience only: Convex verifies every call. Without a valid
    `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` the dashboard stays signed out ("Not signed in").
  - **Dev token** (a development build with `NEXT_PUBLIC_DEV_AUTH_TOKEN`, minted by
    `npm run dev:auth setup` for org `dev-org`, role `admin`): Clerk is not loaded at all. Local
    development and the Playwright journeys use it; production builds never contain it.
- **Routes (D4, D22):** thin Server Components in `app/(dashboard)/` read `params` and render a
  client view from `components/dashboard/views/`.
- **Org gate (D16):** the shell calls `v1/orgs:ensure` (again after every Clerk organization
  switch, accepting the result only when it is the newly active organization), then subscribes to
  `v1/orgs:me`. It never shows another organization's data while the token catches up. The org (display name, role, reporting currency, time zone) is provided through
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
  social/page.tsx                 Organic: Instagram (Phase 10 Stage B) | YouTube (ADR 0016)
  social/posts/[postId]/page.tsx  One Instagram post
  connections/page.tsx            Google Ads + Meta Ads + YouTube connections
  loading.tsx error.tsx not-found.tsx
components/dashboard/             shell, filters, KPI cards, charts, tables, notices, views/
components/dashboard/organic/     organic-only KPI grid, series chart, posts table, account
                                  picker, coverage notes, Instagram link; platform switch and
                                  YouTube channel days, videos table, YouTube link
components/dashboard/connections/ one provider-aware card per ad platform (Google Ads, Meta Ads):
                                  status, Connect/Reconnect/Disconnect, discovered accounts +
                                  link, linked accounts' sync status; the YouTube card
                                  (youtube-connection.tsx): channel, link, disconnect + deletion
lib/connections/                  pure, React-free connection helpers: per-provider wording and
                                  display rules (providers.ts), callback result, link rules,
                                  labels, messages, customer ids, return URL / navigation
lib/analytics/                    pure logic: types, format, filters, deltas, states, values,
                                  errors, chart-data, labels; hooks: use-analytics-query,
                                  use-dashboard-filters; org-context
                                  organic-*: organic types, labels/reasons, values, chart rows,
                                  URL params; youtube-*: YouTube types and values; permalink:
                                  the defensive Instagram and YouTube link checks
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
| `/social?platform=youtube`                      | One YouTube channel: Pacific Time day table (as reported), videos (lifetime statistics)  | `socialAccounts:list`, `youtubeAnalytics:channelDays`/`videos`                                                            |
| `/social/posts/[postId]`                        | One post: caption, latest lifetime totals, lifetime totals at each capture               | `socialPosts:get`                                                                                                         |
| `/connections`                                  | Google Ads and Meta Ads: status, Connect/Reconnect/Disconnect, accounts, link, sync      | `connections:list`/`listDiscoveredAssets`/`beginConnect`/`linkAdAccounts`/`refreshAssets`/`disconnect`, `adAccounts:list` |
|                                                 | YouTube: status, Connect/Reconnect, link the channel, Disconnect + data deletion         | `connections:list`/`listDiscoveredSocialAccounts`/`beginConnect`/`linkSocialAccounts`/`disconnect`, `socialAccounts:list` |
| `/whatsapp`                                     | WhatsApp inbox: conversations, newest activity first, reply window                       | `whatsapp:listConversations`                                                                                              |
| `/whatsapp/conversations/[conversationId]`      | One conversation: messages and statuses, reply window, reply, templates                  | `whatsapp:getConversation`/`listMessages`/`sendText`/`listTemplates`/`sendTemplate`                                       |
| `/whatsapp/settings`                            | WhatsApp settings: Connect WhatsApp (Embedded Signup), setup, connected accounts         | `whatsapp:getSignupConfig`/`completeSignup`/`retrySetup`/`listAccounts`, `connections:list`                               |

There is no org-wide ads page: the API requires a campaign or ad-group parent for ads (read budget).
Connection management is on `/connections` for the **ad platforms, Google Ads and Meta Ads**
(ADR 0008, D17 amendments), and for **YouTube** (ADR 0016, Checkpoint 5). Instagram (organic)
connections stay out of the dashboard. An admin can
disconnect a connection (after a confirmation); single accounts cannot be unlinked here. The
"reconnect required" banner (Overview, Accounts, Organic) links to `/connections` for a Google
Ads or Meta Ads connection and to `/whatsapp/settings` for a WhatsApp connection; for Instagram it
stays read-only. WhatsApp is connected on its own page, `/whatsapp/settings` (see below). On `/accounts`, unlinked or
reconnect-required Google Ads and Meta Ads accounts link to "Manage in Connections".

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
| `platform`                            | `/social`: `youtube` for the YouTube view (default: Instagram)           |
| `account`                             | `/social`: the selected account / channel id (default: the first listed) |
| `pdir`                                | `/social`: post / video order by publish time, `asc` (default: newest)   |
| `status`, `warning`, `error`          | `/connections`: the OAuth callback result; read once, then removed       |
| `connection`                          | `/connections`: the callback's connection id; read once, then removed    |

Page size, pagination position and the chart metric are UI state (D2). Presets resolve against the
**org time zone's today** (`todayIn(org.timezone)`, re-checked every minute) with the shared pure
`resolvePreset`; queries never read the clock (D12). Ranges are each ad account's local days.
On `/social` the filter bar is rendered with `dayBasis="utc"`: presets resolve against **today in
UTC** (`useUtcToday`), because Instagram account metrics are keyed by UTC day; the same range
filters posts by publish day in the **org time zone** (the B2 API semantics). The YouTube view
uses `dayBasis="pacific"`: presets resolve against **today in Pacific Time** (`usePacificToday`),
because YouTube Analytics reports Pacific Time days; videos are filtered by publish day in the org
time zone. The paid pages keep the default `dayBasis="org"`, unchanged.

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
- **Instagram accounts only:** the picker lists the org's Instagram accounts; YouTube channels
  have their own view (below).

### Organic YouTube (ADR 0016, Checkpoint 5)

`/social?platform=youtube` (the **Instagram | YouTube** switch on `/social`; Instagram stays the
default and is unchanged). Every value comes from `v1/youtubeAnalytics` exactly as YouTube
reported it; the dashboard never adds, averages, compares or combines anything: no totals, no
engagement rate, no percent change, no score, no cross-channel or cross-platform figure
(`lib/analytics/youtube-values.ts`; the no-arithmetic scan of
`tests/lint/organic-dashboard-boundary.test.ts` covers YouTube's metric names too).

- **One channel at a time** (picker "YouTube channel"). The summary shows **Source: YouTube**,
  the handle, the link state and "Channel days synced through … (Pacific Time)".
- **Filter bar:** date range only (no comparison, no account filter); presets use Pacific Time.
- **Daily channel metrics:** one row per Pacific Time day, newest first, with YouTube's names:
  Views, Likes, Comments, Shares, Est. minutes watched, Avg. view duration (YouTube's own per-day
  value, shown as m:ss), Subscribers gained, Subscribers lost. Each row has a status:
  **Reported**; **Not reported** (synced, YouTube reported nothing); **Unknown** (not synced
  yet; YouTube reports days about 3 days late). A metric a reported day lacks is "—" with its
  reason; a reported 0 stays 0; unknown and not-reported days show "—", never 0. There is no
  total row.
- **Notices** (from the API): partial or unsynced ranges ("N Pacific Time days of this range not
  synced yet"); `scope_missing` (YouTube Analytics access not granted: the daily metrics stay unknown,
  while the videos and their statistics keep syncing, ADR 0016 open question 13);
  `reauth_required`; `not_linked`; each links to `/connections` where that helps.
- **Videos:** paginated (25/50/100, cursor stack), by publish time in the org time zone; lifetime
  Views, Likes and Comments at the latest capture (UTC capture day), "not daily performance".
  A hidden like count or disabled comments are "—" with the reason, never 0; a never-captured
  video shows "Not synced". "Watch on YouTube" opens a new tab (`rel="noopener noreferrer"`)
  only for a URL that passes `safeYouTubeWatchUrl` (exactly
  `https://www.youtube.com/watch?v=<11-character id>`). No thumbnail or image.
- **Deletion:** a channel being deleted (status `disconnected`) shows a deletion notice instead
  of data; the page points to the Connections page for disconnecting.

## Connections (Google Ads, Meta Ads and YouTube)

`/connections` (ADR 0008, D17 amendments) is the only dashboard page that changes data. It has one
section per ad platform, **Google Ads** and **Meta Ads**, rendered by the same provider-aware card
(`components/dashboard/connections/ad-connection.tsx`). Each section shows only its own provider's
connections and accounts, in its own words (`lib/connections/providers.ts`, `messages.ts`), so a
Meta connection never shows Google wording. Instagram (organic) connections never appear. The page
uses the existing public v1 functions only ([connections.md](connections.md)); the **server**
decides who may act and which accounts may be linked. The UI mirrors those rules
(`lib/connections/linkability.ts`) only to decide what to offer.

| Part                                           | Admin | Editor, viewer                                                   |
| ---------------------------------------------- | ----- | ---------------------------------------------------------------- |
| Connection status                              | yes   | yes                                                              |
| Connect / Reconnect / Disconnect               | yes   | no ("Only organization admins can …")                            |
| Discovered accounts, Link, Retry discovery     | yes   | no (`listDiscoveredAssets` is admin-only and is not even called) |
| Linked accounts, sync status, "View analytics" | yes   | yes                                                              |

1. **Status.** Each section shows one connection of its provider: the one the callback just
   reported, else the newest active one, else the newest (revoked connections are hidden; several
   connections get a "Google connection" / "Meta connection" selector). States: connected, access
   missing (a required scope was not granted), access expires soon (Meta tokens last about 60
   days), reconnect required. For an active connection a discovery failure is explained from its
   allowlisted `reason` in the provider's words, never the server message.
2. **Connect / Reconnect.** `beginConnect` with `provider: "google_ads"` or `"meta"`, a
   `returnUrl` and, for Reconnect, `reconnectConnectionId`. The return URL is
   `<origin>/connections` plus the global filters and a display-only `connect=<provider>` hint;
   the server accepts it only if the app's allowlist covers that origin and path (local
   development: `http://localhost:3000/` and `http://127.0.0.1:3000/`). Reconnect passes the
   shown connection's id, so a different Google or Facebook account is refused
   (`identity_mismatch`). The button stays disabled until the page is left, so a connection is
   never started twice. The returned authorization URL is followed in the same tab (http(s) only)
   and is **never rendered, logged or stored**: it carries the single-use state (and, for Google,
   the PKCE challenge). In mock mode it is the callback URL itself (instant consent). A deployment
   without the Meta app settings refuses Meta before any OAuth state exists ("Meta Ads is not
   available").
3. **Disconnect.** Admins see **Disconnect Google Ads** / **Disconnect Meta Ads** next to
   Reconnect; it first asks for confirmation (Cancel has focus; Escape cancels). Confirming calls
   `disconnect` for the shown connection: the server revokes it, unlinks its accounts (rows and
   synced data are kept), drops its discovered accounts and deletes the credential. Neither Google
   nor Meta is called: platform access is not revoked at the platform (G-D6, D7). The other
   provider's connections and Instagram connections are not touched. The section then shows
   "… disconnected" and **Connect** starts a fresh connection, which may use any Google or
   Facebook account. This is the way out of `identity_mismatch`: Reconnect only accepts the
   account that created the connection.
4. **Callback result.** Parsed once (`lib/connections/connect-result.ts`): connected (with the
   `discovery_failed` warning), a known error code, an unknown code, or malformed (repeated
   parameters, an invalid connection id). The callback names no provider: the `connect` hint
   picks the wording (Google, Meta, or neutral without a hint) and is trusted for nothing else.
   Each has fixed text; parameter values are never shown. The result parameters, the hint and any
   stray `code` / `state` are then removed with `router.replace`, keeping the global filters, so
   a reload never replays the notice.
5. **Discovered accounts.** Google Ads: customer id (`123-456-7890`), name, type (manager,
   client, "not reported"), test-account status (test, not a test account, "not reported"),
   currency, time zone, account status, the manager it was discovered through (or "Direct
   access"), and whether it can be linked. Meta Ads: ad account id (digits, as Meta shows it),
   name, currency, time zone, account status (a disabled account is shown as such and can still be
   linked), the business it belongs to, and whether it can be linked; Meta reports no account type
   or test status, so those columns are not shown.
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
8. **Linked accounts** (every linked account of the section's provider): sync status from the
   read-only `sync` block (first sync scheduled, syncing, up to date, partly completed, failed
   with the failure streak, blocked, cancelled, not syncing), data coverage, last successful sync,
   next sync, and the allowlisted reason's explanation.
9. **View analytics** opens the Overview filtered to the account (`/?accounts=<id>`), keeping the
   period and clearing a platform filter.

Errors of these calls map to fixed text in the provider's words (`lib/connections/messages.ts`):
return URL not allowed, provider not available, account type not confirmed, not found, connection
not active, too many
attempts, admins only, integration disabled, provider failure; sign-in and org errors as in D15.
Disconnect failures (admins only, connection not found, not disconnected) have their own fixed
text. Unexpected errors never show their message.

**Limitations (today):**

- **Connections are closed on cloud deployments** until an operator sets
  `OAUTH_CONNECTIONS_ENABLED=true` after S2 is deployed and verified: `beginConnect` refuses
  until then (the page shows the platform as not available). Signing in with Clerk,
  organizations and roles work there.
- **Real accounts.** Google Ads: a real Google sign-in and account discovery were completed from
  the dashboard on the local deployment in live mode (2026-10-21); linking and a live sync were
  not ([providers/google-ads.md](providers/google-ads.md#dashboard-connection-flow)). Meta Ads:
  tested with mocks and the fake Graph only; no real Meta account has been connected. A live Meta
  connection needs the Meta app settings (`META_APP_ID`, `META_APP_SECRET`,
  `META_LOGIN_CONFIG_ID`) and the real-account checks in
  [providers/meta.md](providers/meta.md#real-account-validation-required).
- **Callback ownership (S2).** The callback returns `status=pending&claim=<code>`; the page
  removes the code from the URL at once, shows "Finishing the … connection…" and claims it once
  with `v1/connections:completeConnect` as the signed-in user (the page renders only behind the
  org gate, so a claim waits for sign-in). A refused claim shows fixed text (not valid, expired,
  different account, admins only). If the user switched organization or account since starting,
  the claim is refused and they start again
  ([security/credentials.md](security/credentials.md#oauth-callback-ownership-s2)).
- A Google account with no Google Ads access fails during the OAuth exchange
  (`exchange_failed`), not during discovery; the notice can only suggest the cause.
- Embedded (iframe) use is not a goal of the standalone SaaS (ADR 0012).

### YouTube (ADR 0016, Checkpoint 5)

A third section, **YouTube**, rendered by `components/dashboard/connections/youtube-connection.tsx`
with the shared Connect / Reconnect / Disconnect buttons and YouTube's own wording
(`PROVIDERS.youtube`, `lib/connections/youtube.ts`):

- **Status** (every role): connected, YouTube Analytics access missing (`yt-analytics.readonly`
  not granted; the card says that the videos keep syncing and only the daily metrics wait),
  reconnect required. The channel is shown by its name and handle once linked and synced, otherwise by its
  channel id; no credential, token or scope string is shown.
- **Connect / Reconnect** (admins): `beginConnect` with `provider: "youtube"`, the same return
  URL and `connect=youtube` hint, and `reconnectConnectionId` for Reconnect. A deployment without
  the YouTube OAuth client refuses before any OAuth state exists ("YouTube is not available").
- **Channel to sync** (admins): the discovered channel and **Link channel**
  (`linkSocialAccounts`). `CONFLICT` / `purge_pending` (the channel's stored data is still being
  deleted) reads "Stored data is still being deleted. Try again in a few minutes."
- **Linked channel** (every role): last sync, the Pacific Time days covered, and "View analytics"
  (`/social?platform=youtube&account=…`).
- **Disconnect** (admins): the section says, before any click, that disconnecting revokes this
  service's Google access and deletes the channel's stored YouTube data. The confirmation lists
  what is deleted ("This cannot be undone"); the button is **Disconnect and delete data**.
  Afterwards the card shows **Deleting stored YouTube data…** while the channel's row is still in
  `v1/socialAccounts:list` (status `disconnected`), and **Stored YouTube data deleted** only once
  the server has removed it. It never claims that Google confirmed the revocation (best effort,
  server side). Deletions this page did not start (another admin, an unlink, a failed
  authorization check) are shown too. This is the **in-product deletion path** required by the
  YouTube API Services Developer Policies (III.E.4.g, ADR 0016).

## WhatsApp inbox

`/whatsapp` ([ADR 0015](adr/0015-whatsapp-messaging.md)) lists the org's WhatsApp conversations,
newest activity first, 25 at a time (**Show more conversations**): the contact's name (or `+`
and their WhatsApp id), the business number, the time of the latest message and whether the
reply window is open. Each opens `/whatsapp/conversations/[conversationId]`: the messages,
oldest at the top, 30 at a time (**Show older messages**), each outbound one with its status, and
the reply window. The inbox links to **WhatsApp settings** (below). Both pages use the public
`v1/whatsapp` functions only; the server decides the org and the role, and an unknown or another
org's conversation id renders the not-found page. Sending itself is described in
[whatsapp.md](whatsapp.md#sending-messages-adr-0015); nothing has been sent through Meta.

| Part                                                | Admin, editor | Viewer                                    |
| --------------------------------------------------- | ------------- | ----------------------------------------- |
| Conversations, messages, statuses, the reply window | yes           | yes                                       |
| Reply box, template picker                          | yes           | no ("Only editors and admins can reply.") |

1. **Reply window.** "Reply window open", with the time it closes, until 24 hours after the
   customer's last message; otherwise "Templates only". The page re-checks it every 30 seconds,
   and the server checks again when a reply is sent.
2. **Reply box** (window open only). Up to 4096 characters, with a counter; **Send** sends once
   (`sendText`). The draft keeps its `clientMessageId` until it is sent or edited, so pressing
   Send again after an error can never send it twice.
3. **Template picker** (at any time). **Choose a template** reads the approved templates from
   Meta (`listTemplates`); ones this app cannot send yet are listed with the reason and cannot be
   chosen. **Use this template** shows a field per variable (Meta's example as the placeholder),
   a live preview and **Send template** (`sendTemplate`), enabled once every field is filled in.
   The server checks every value again.
4. **Statuses, in words:** Sending, Accepted by WhatsApp, Sent, Delivered, Read, Not delivered
   (with the reason: the reply window had closed, the number may not use WhatsApp, too many
   messages, reconnect in the settings, a refused template, …) and Not confirmed ("It may have
   been sent: check with the customer before sending it again"). Refusals (window closed, a
   number set up by support, reconnect required, a missing or too long value, …) appear above
   the composer. All of these are fixed texts (`lib/whatsapp/messages.ts`); Meta's and the
   server's own texts are never shown.
5. **Messages.** Text keeps its line breaks; other types (photo, audio, …) are named but not
   shown; a template shows the text the customer received.

Limits: list and thread are separate pages, not a split view. A reply typed while the window
closes is lost when the reply box gives way to templates. Sending needs a number connected through
Embedded Signup; it has never run against Meta.

## WhatsApp (Embedded Signup)

`/whatsapp/settings` ([ADR 0014](adr/0014-whatsapp-connections.md), B3; `/whatsapp` until the
inbox took that path) lets an organization admin connect
a WhatsApp Business number through Meta's Embedded Signup and follow its setup; every member sees
the connected accounts. It uses the public `v1/whatsapp` functions only; the **server** verifies
every Meta asset and decides who may act ([whatsapp.md](whatsapp.md#connecting-a-number-embedded-signup-adr-0014)).

| Part                                                     | Admin | Editor, viewer                                                     |
| -------------------------------------------------------- | ----- | ------------------------------------------------------------------ |
| Connected accounts, setup status, numbers                | yes   | yes                                                                |
| Connect WhatsApp, Retry setup, Connect again, Disconnect | yes   | no ("Only organization admins …"; `getSignupConfig` is not called) |

1. **Availability.** The page asks `getSignupConfig`. When the server says WhatsApp is not
   available (the deployment's `WHATSAPP_CONNECTIONS_ENABLED` gate is closed, or the Meta app is
   not configured) it says so, and Meta's SDK is never loaded.
2. **Meta's SDK.** Only then, and only for admins, `https://connect.facebook.net/en_US/sdk.js`
   is loaded with `next/script` (`afterInteractive`, `crossOrigin="anonymous"`) and initialized
   once with the app id and Graph version from `getSignupConfig` (no client environment
   variables), with Meta's documented values (`autoLogAppEvents: true`, `xfbml: true`).
   **Connect WhatsApp** stays disabled ("Preparing Meta sign-in…") until the SDK is ready:
   `FB.login` has to run directly in the click, or pop-up blockers stop it. A blocked SDK shows
   "Meta sign-in could not load".
3. **Signup.** The click calls `FB.login` with `config_id`, `response_type: "code"`,
   `override_default_response_type: true` and `extras: { setup: {} }`. While the Meta window is
   open the page listens for Meta's `WA_EMBEDDED_SIGNUP` messages, but only from an exact https
   origin on `facebook.com` or a subdomain (Meta's sample only checks the end of the origin, which
   also accepts e.g. `evilfacebook.com`). The code (from the `FB.login` callback) and the ids
   (from the `FINISH` message) are paired in memory, in either order, and sent once to
   `completeSignup` as `{ code, wabaId, phoneNumberId }`; the code is then dropped. It is never
   rendered, logged, stored or put in a URL. If the code arrives but Meta's `FINISH` does not
   follow within 10 seconds, the attempt ends ("Signup did not finish"). `FINISH` itself may
   come long before the code: Meta counts its final screen as finished, and the code only
   arrives when the window closes, so the page waits for that without a limit. One attempt runs
   at a time.
4. **Outcomes, in fixed words** (`lib/whatsapp/messages.ts`): cancelled (with the step reached),
   window closed or pop-up blocked, Meta error (with Meta's error code and session id for support,
   never Meta's error text), unsupported variants (no number chosen, a number already in the
   WhatsApp Business app, migration or API-access-only signups), every server refusal (another
   organization's account or number, an operator-managed number, a concurrent signup, an expired
   code, …), and the setup result: connected, setup not finished (with the next step), or connect
   again. The latest outcome is shown at the top and receives focus.
5. **Accounts.** `listAccounts` (live): each account with its name (from the connection), status
   badge, WABA id, numbers (registered or not, and when registration may be retried after Meta's
   rate limit) and the reason in words. Admins get **Retry setup** for an unfinished setup (one call
   at a time), **Connect again** for one that needs reauthorization (a new signup) and **Disconnect**
   for an active one: a confirmation (Cancel has focus; Escape cancels) lists what happens, then
   `disconnectAccount` runs once. The result says whether Meta's cleanup finished, is still being
   retried, or gave up (with guidance to remove the app in the Meta business settings). A
   disconnected account shows that status, no actions, and is connected again with **Connect
   WhatsApp**. History stays visible to every member.

Limits: Meta's SDK runs with the page's privileges (it can read what the page can, including the
Clerk session cookie). It is loaded only from `/whatsapp/settings`, for admins, when signup is available,
but a script cannot be unloaded: once loaded it stays in the page, also after navigating to other
pages, until a full reload. The
app has no Content Security Policy yet. The real Meta flow needs an HTTPS origin listed in the Meta
app's Allowed domains ([whatsapp.md](whatsapp.md#connect-ui-meta-configuration)); it has never run
against Meta.

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
cannot be linked. The Meta Ads section works the same way with the mock Meta user (`dev:seed`
already connects it and links accounts 1001 and 1002). In live mode without the Meta app
settings, "Connect Meta Ads" explains that Meta Ads is not available.

If a dynamic route unexpectedly returns 404 in `next dev` after pulling new routes, delete
`.next/dev` (a stale Turbopack dev cache) and restart.

## Tests

- Unit (Vitest + jsdom): pure logic in `lib/analytics/*.test.ts` and `lib/connections/*.test.ts`;
  components with mocked `convex/react` and `next/navigation` (`tests/unit/dashboard-harness.tsx`:
  query results, plus per-function `mockMutation(name)` / `mockAction(name)`; unregistered
  mutations fall back to the org gate's `ensureMock`). The Connections journey is covered in
  `components/dashboard/views/connections-view.test.tsx`; `tests/unit/connections-parity.test.ts`
  pins the dashboard's copies of the callback error codes and error reasons to the server's. The
  WhatsApp settings page: `lib/whatsapp/*.test.ts` (sender check, message parsing, pairing,
  texts) and `components/dashboard/views/whatsapp-view.test.tsx` (a stand-in for `next/script`
  and a fake `FB`; nothing loads from Meta). The WhatsApp inbox:
  `whatsapp-inbox-view.test.tsx`, `whatsapp-conversation-view.test.tsx` and
  `whatsapp-reply.test.tsx` (paging through the harness's `usePaginatedQueryMock` /
  `loadMoreMock`, statuses, the reply window, roles, and the reply box and template picker against
  mocked `sendText`, `listTemplates` and `sendTemplate`), with `lib/whatsapp/inbox.test.ts`,
  `template-form.test.ts` and `messages.test.ts`.
- YouTube (ADR 0016, Checkpoint 5): `components/dashboard/views/youtube-view.test.tsx` (channel
  selection, Pacific Time presets, day statuses, missing values and zeros, coverage and access
  notices, video pagination and links, the Instagram regression) and
  `components/dashboard/connections/youtube-connection.test.tsx` (connect, reconnect, link,
  `purge_pending`, disconnect and the server-confirmed deletion), with
  `lib/analytics/youtube-values.test.ts` and `lib/connections/youtube.test.ts`.
- Lint guards: `tests/lint/frontend-imports.test.ts`, `tests/lint/organic-dashboard-boundary.test.ts`.
- Playwright: `dashboard.spec.ts`, `social.spec.ts` and `smoke.spec.ts` are CI-safe (shell,
  navigation, gate, mobile menu, not-found, axe on every page including `/connections`,
  `/whatsapp` and `/whatsapp/settings`). `whatsapp.spec.ts` checks the WhatsApp inbox and
  settings pages locally (opt-in, see below).
  `youtube.spec.ts` checks the YouTube view's sign-in gate (CI-safe) and, locally with
  `E2E_DASHBOARD_DATA=1`, the platform switch, the YouTube view (or its empty state), the
  YouTube card on `/connections` (it only opens and cancels the disconnect confirmation), axe
  and a 375 px layout; it never connects, links or disconnects anything.
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
  and callback URLs, the Convex CLI targets a local deployment (the project's local deployment or
  an anonymous local one; never a cloud deployment) with `PROVIDER_MODE` unset or `mock`, the
  dashboard's `NEXT_PUBLIC_CONVEX_URL` is that same deployment (its public `/instance_name`
  equals the CLI's deployment name), port 3000 free. In the browser every non-loopback request
  and WebSocket is blocked (Google included).
- **Isolated run (when the local deployment is in live mode):** the guards read the checkout's own
  `.env.local`, so run the journeys from a separate checkout with its own anonymous mock
  deployment; the live deployment is never touched (see "Isolated run" below).
- **Identity:** the dashboard server keeps the developer's dev token; the spec swaps it, in memory,
  for a token of the throwaway org `e2e-google-ads` on the Convex WebSocket, and clicks nothing
  until the org badge shows "E2E Google Ads". Tokens are minted in memory and never printed or
  written. `dev-org` is only read: its connections, ad accounts and Instagram accounts are
  compared before and after.
- **Sync:** only `sync/admin:requestSync` for the one linked test account; never the planner.
- **Cleanup:** setup disconnects any leftover connection of the throwaway org; teardown always
  disconnects (connection revoked, credential deleted, discovered accounts deleted, account
  unlinked; further syncs are refused and the planner parks the sync state).
- **Residue (accepted, local only, throwaway orgs `e2e-google-ads` and `e2e-google-ads-other`):**
  the orgs, one revoked connection (reused by later runs), one unlinked ad account and its sync
  state, the synced mock structure and metrics (upserted, so they do not grow), and per run one
  consumed OAuth state (swept hourly), one sync run with its tasks and about seven audit entries.
  No purge function exists; only resetting the local deployment removes them.

**Isolated run.** From the repository root, with port 3000 free (copy any uncommitted changes
into the new checkout first). The anonymous deployment keeps its data inside that checkout
(`.convex/local/default`) and has nothing in common with the project's local deployment:

```bash
git worktree add --detach ../marketing-microservice-e2e-mock
cd ../marketing-microservice-e2e-mock && npm ci
# keep this running in its own terminal:
CONVEX_AGENT_MODE=anonymous npx convex dev --local-cloud-port 3310 --local-site-port 3311
npx convex env set PROVIDER_MODE mock
npm run dev:auth setup && npm run dev:seed
E2E_CONNECTIONS_JOURNEY=1 npm run test:e2e:connections
```

Afterwards stop that `convex dev` and remove the checkout with
`git worktree remove --force ../marketing-microservice-e2e-mock`.

**Recovery after a hard kill** (Ctrl+C or a crash skips teardown, so the test account may stay
linked and keep syncing mock data hourly):

```bash
npm run test:e2e:connections:cleanup
```

It runs the same guards and disconnects every non-revoked Google Ads connection of
`e2e-google-ads` and every non-revoked connection of `e2e-meta-ads` (idempotent; it prints only
counts). The next journey run also does this first.
If port 3000 stays busy, stop the leftover `next dev` process before running again.

### Meta Ads Connections journey (local, opt-in)

`tests/e2e/meta-ads-journey.spec.mts` drives the Meta Ads section of `/connections` with the same
config, guards, browser lockdown (Facebook included) and in-memory identity swap as the Google
Ads journey, as the throwaway org **`e2e-meta-ads`** ("E2E Meta Ads"): Connect Meta Ads →
(mock consent =) OAuth callback → discovery (Meta columns: no account type or test status, the
business, raw ad account ids, no Google wording) → link one ad account → a sync of that one
account (successful run, coverage set, "Data through …") → "View analytics" (the Overview
filtered to the account shows only Meta in "Spend by platform"; unfiltered it also shows Google
Ads) → **Disconnect Meta Ads** (Cancel first, then confirm): connection revoked, account
unlinked, discovery cleared, further syncs refused.

```bash
E2E_CONNECTIONS_JOURNEY=1 npm run test:e2e:connections -- meta-ads-journey
```

- **Fixtures (same throwaway org, through the API, mock consent only):** a Google Ads connection
  with one linked and synced client account, and an Instagram connection with its linked account.
  The journey proves the Meta disconnect leaves both untouched, and that Instagram never appears
  on `/connections`.
- **Sync wait (by run state):** `sync/admin:requestSync` answers with the run that covers the
  request: a new one, an active one, or one of the same kind and window that already ran in the
  current 15-minute planner slot (a rerun within minutes). The journey waits for that run through
  the read-only `sync/admin:runStatus`; it must succeed, the account must report a successful last
  run whose coverage reaches the run's window, and a new run must finish after the request.
- **dev-org** is only read: its connections, ad accounts and Instagram accounts are compared before
  and after.
- **Cleanup:** setup and teardown disconnect every non-revoked connection of `e2e-meta-ads` (Meta
  and both fixtures). Residue is like the Google journey's: the org, revoked connections, unlinked
  accounts with their mock data and sync state, consumed OAuth states and audit entries.

### WhatsApp pages (local, opt-in)

`tests/e2e/whatsapp.spec.ts` opens the inbox, `/whatsapp`, as the dev-org admin against the local
backend (`npm run dev:backend`, `npm run dev:auth setup`), then follows **WhatsApp settings** to
`/whatsapp/settings`, with every request to Meta's hosts blocked and recorded:

```bash
E2E_WHATSAPP_PAGE=1 npx playwright test whatsapp
```

The inbox shows its conversations or "No conversations yet" and never requests Meta. Without the
Meta app settings in the local Convex env the settings page says WhatsApp is not available and
Meta's SDK is never requested; with them, the blocked SDK fails visibly and nothing can start. It
checks accessibility (axe) on both pages too. It never runs a real signup or sends a message: a
signup needs the Meta configuration in [whatsapp.md](whatsapp.md#connect-ui-meta-configuration),
sending a connected number ([whatsapp.md](whatsapp.md#live-check-sending-adr-0015)); both are
separate, manual tests.
