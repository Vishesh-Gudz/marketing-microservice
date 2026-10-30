# ADR 0011 — Instagram organic provider

- Status: Stage A (infrastructure) and Stage B (B1 data sync, B2 analytics API, B3 dashboard)
  implemented and tested against mock and fake data only. Real-account validation is pending
  (IR2–IR21, IR23–IR25 provisional).
- Date: 2026-09-28 (Stage A); Stage B 2026-09-29

## Context

Phase 10 adds organic Instagram data (Business and Creator accounts) next to the paid tree.
Instagram ads stay Meta ads.

- `@opencoredev/social-sdk@0.5.0` covers profile, media listing and five lifetime post
  metrics. It does not cover account insights, `views`, `total_interactions` or
  `account_type`.
- The SDK is ESM-only and needs Node ≥ 22.12, while Convex Node actions default to Node 20.
- The connection layer and the sync engine (Phases 4–5) were typed for ad accounts only.
- No real Instagram account is available.

Details: [docs/providers/instagram.md](../providers/instagram.md).

## Decisions

1. **Connection model:** Instagram Login with a new `instagram` connection provider. The Meta
   connection is not reused and Meta is unchanged.
2. **Own OAuthSpec:** SDK-free, in the default runtime. Scopes are
   `instagram_business_basic` and `instagram_business_manage_insights` only. No PKCE (not
   documented), so the state nonce is the CSRF defense. D28b stages: `token_exchange`,
   `long_lived_exchange`, `identity`, `config`, `token_refresh`.
3. **SDK plus a minimal Graph reader.** The SDK is used for what it supports. A minimal,
   allowlisted, read-only Graph reader covers only the documented gaps. Stage A implements
   the identity read. Posts cost 3 requests per post per day (approved), under an explicit
   budget with request-count tests.
4. **Runtime:** `convex.json` sets `node.nodeVersion: "22"`. Gate V1 measured the Convex cloud
   runtime at Node 22.23.2 (linux/arm64). SDK modules are `"use node"`.
5. **Isolation:** only `convex/providers/instagram/node/**` imports the SDK, reachable only via
   `providers/social/nodeRegistry.ts` from the `"use node"` `sync/socialWorker.ts`. This is
   enforced by ESLint and a source-scan test. No SDK type, error or cursor crosses the
   boundary.
6. **Discovery:** from the OAuth identity in the default-runtime callback, with no Node hop.
   The result is the minimum identity (id, username, account type) in the new table
   `discoveredSocialAccounts`.
7. **Secret in URL:** the global rule is unchanged. The ONE exception covers the exact
   documented GET shapes of `graph.instagram.com/access_token` (`ig_exchange_token`) and
   `/refresh_access_token` (`ig_refresh_token`), for the OAuth caller only. The URLs are never
   logged, persisted or put in errors.
8. **Credentials and refresh:** tokens go through the existing credential store. A daily job
   refreshes tokens that are at least 24 h old and expire within 10 days, replacing the
   ciphertext atomically together with the expiry and the credential version. An `auth`
   failure moves the connection to `needs_reauth`.
9. **Schema (all additive, orgId-first):**
   - `connections.provider` and `oauthStates.provider` are widened to
     `meta | google_ads | instagram`;
   - new table `discoveredSocialAccounts`;
   - `socialAccounts` gains `connectionId?`, `linkedAt?` and the index `by_org_connection`;
   - `syncAccounts`, `syncRuns` and `syncTasks` gain `socialAccountId?`, `adAccountId` becomes
     optional, and new social indexes are added;
   - `syncRuns.platform` also accepts social platforms;
   - four social sync operations are added.
10. **Sync subject:** every sync row names exactly one subject (`sync/subject.ts`). The
    planner, runs, claims, commits, cancellation, auth cascade and retention branch on subject
    kind. Ad paths are behavior-identical. Social runs are planned by the pure
    `sync/socialPlan.ts` (capability-driven, UTC days, 90-day horizon, 3-day lookback) and
    executed by the Node social worker through the same claim and failure mutations. Stage B
    adds social coverage (decision 16).
11. **Fail closed in Stage A (superseded by Stage B):** every Instagram sync operation threw
    `unknown` / `instagram_mapping_pending` before any network call, and no social page could be
    committed. Stage B replaced this with the mapping and the write path below.
12. **Public API (additive):** `v1/connections:beginConnect` and `connectionDto.provider` accept
    `instagram`. New functions: `listDiscoveredSocialAccounts`, `linkSocialAccounts`,
    `unlinkSocialAccount`. Ad and social link paths are separate and cannot be crossed.

### Stage B (approved F1–F21 and R1b–R13)

13. **Mapping (B1):** one tagged table, `providers/instagram/semantics.ts`. The permalink is the
    only stored URL (F1, R1b). Account insights: one `period=day&metric_type=total_value` request
    per UTC day (F2) plus `follows_and_unfollows` by `follow_type` (F3, provisional);
    `profile_links_taps` goes to `extras.profileLinksTaps` (F4); `reposts`, `profile_visits` and
    `follows` are not requested (F5); `total_*` metrics are never requested (F6). `AD` and
    `STORY` media are excluded (F20); captions are capped at 2,200 characters (F21).
14. **Write path (B1):** `commitSocialPage` and the social writers of `sync/upsert.ts`;
    provenance fields `followersCapturedAt` / `insightsSyncedAt` and independent column groups
    (F7); unresolved posts are skipped (F8); incremental early stop (F9); shared cadence (F10);
    account-type drift blocks and audits (F11); truncation is a warning; bounded post removal
    with the mass-removal veto.
15. **Sliding backfill horizon (B1, approved fix):** a social account's backfill horizon follows
    the platform's retention (today UTC − 89), so an aged-out gap can never loop a backfill.
16. **Coverage (B1):** fully resolved `fetchAccountMetrics` windows (UTC days) grow coverage;
    post snapshots never do.
17. **Analytics (B2):** query-time, in the separate module `convex/analytics/organic/`; missing
    is never zero; engagement rate = interactions / reach only for one account × one UTC day or a
    post snapshot (F12); states reported / partial / unknown / unsupported, no `no_delivery`
    (F13); no post deltas (F14); one read budget of 8,000 rows (F16).
18. **Public API (B2, additive):** `v1/socialAccounts:list|get`, `v1/socialPosts:list|get`,
    `v1/organicAnalytics:overview|accountSeries` (F17). Account metrics use UTC days; post
    publish filters use the org timezone (R12).
19. **Dashboard (B3, N1–N10):** `/social` and `/social/posts/[postId]`, nav label "Organic";
    one account at a time; presets resolve against today in UTC through a backward-compatible
    `dayBasis` on the shared filter bar (paid pages unchanged); organic-only components (no
    generalized paid chart); 6 headline + 7 detail KPI cards; posts show lifetime totals; the
    permalink is re-checked in the browser before it becomes a link; the reconnect banner stays
    read-only. `npm run dev:seed` connects mock Instagram users for development and tests only.
20. **Validation:** mock and fake data only (F15). No real Instagram account was used; IR22 is
    settled by Meta's documentation, IR1 by measurement; every other IR stays provisional.

## Consequences

- Deferred beyond Phase 10: comments and commenters, stories, DMs, WhatsApp, messaging,
  webhooks, publishing, Reels-specific insights and audience demographics. Since then: WhatsApp
  (ADR 0013–0015); DMs, their webhook and Meta's deauthorize / data-deletion callbacks for the
  Instagram Login app ([ADR 0017](0017-instagram-messaging.md)).
- Before production use, every provisional IR must be checked on a real Instagram professional
  account (checklist in [docs/providers/instagram.md](../providers/instagram.md)).
- A Graph version bump is coupled to an SDK upgrade.
- Two inventory tests changed additively (the schema inventory and the v1 surface), and one sync
  test received type-only non-null assertions because `adAccountId` became optional.
