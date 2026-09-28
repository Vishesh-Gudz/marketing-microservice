# ADR 0011 — Instagram organic provider

- Status: Stage A implemented (infrastructure). Stage B (semantics, organic analytics, v1 and
  dashboard) and real-account validation are pending.
- Date: 2026-09-28

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
    executed by the Node social worker through the same claim and failure mutations. Coverage
    stays ad-only until Stage B.
11. **Fail closed in Stage A:** every Instagram sync operation throws `unknown` /
    `instagram_mapping_pending` before any network call (mock: `social_mapping_pending`).
    Capabilities declare no posts or metrics, so only the preflight is planned. A social page
    can never be committed (no social page write path yet).
12. **Public API (additive):** `v1/connections:beginConnect` and `connectionDto.provider` accept
    `instagram`. New functions: `listDiscoveredSocialAccounts`, `linkSocialAccounts`,
    `unlinkSocialAccount`. Ad and social link paths are separate and cannot be crossed.

## Consequences

- Stage B adds, in order:
  1. mappings (`[doc]` / `[PROVISIONAL IRn]`);
  2. the social page write path in `sync/upsert.ts` (the column-group rule for daily rows);
  3. social coverage;
  4. organic analytics, the organic v1 API and the `/social` dashboard.
- A Graph version bump is coupled to an SDK upgrade.
- Two inventory tests changed additively (the schema inventory and the v1 surface), and one sync
  test received type-only non-null assertions because `adAccountId` became optional.
