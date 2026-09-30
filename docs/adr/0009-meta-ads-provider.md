# ADR 0009 — Meta Ads provider

- Status: accepted (Stage A); Stage B implemented with PROVISIONAL semantics — real-account
  validation required (docs/providers/meta.md)
- Date: 2026-09-26

## Context

Phases 3–7 built the provider contract, connections, sync, analytics and the dashboard against
deterministic mocks. Phase 8 plugs in the real Meta Marketing API without changing the schema, the
public v1 API, mapping, analytics, the dashboard or the mock. Meta's metric semantics (missing vs
zero, conversions, action attribution, placements, reach, money) cannot be decided from
documentation alone, so the phase was split: Stage A shipped semantics-neutral plumbing and a
real-account spike (G1) was to supply the evidence for Stage B. No real Meta ad account was
available, so G1 could not run. Stage B therefore implements the mappings from the Marketing API
reference and the canonical model as explicitly PROVISIONAL assumptions, isolated in the Meta
provider and listed for validation when a real account is connected.

## Decisions

1. **D1** Pinned `v26.0` with a validated `META_GRAPH_API_VERSION` override. `providerId`
   (`meta-marketing-api/<version>`) is run metadata only; `platform = meta` and natural keys never
   change with the version. The version is part of the cursor fingerprint.
2. **D2** Plain `fetch` in the V8 runtime, no SDK; GET-only ads client; 60 s sync / 15 s OAuth and
   discovery timeouts; no retries in the client (the sync engine owns retries).
3. **D3** Raw responses validated with Convex `v` validators and `convex-helpers` `validate`. No Zod,
   no new dependency.
4. **D4** Facebook Login for Business with a long-lived user token (about 60 days, no refresh). No
   system-user tokens in Phase 8.
5. **D5** `MetaCredential` v1 in the encrypted blob; `expiresAt` = earliest finite expiry (0 =
   never); `refreshable: false`.
6. **D6** `appsecret_proof` on every call; the token in the `Authorization` header; OAuth secrets in
   form bodies. Exception pending V2: `debug_token`'s `input_token` query parameter.
7. **D7** No platform revoke on disconnect.
8. **D8** `PROVIDER_MODE` fails closed: local + unset → mock; `mock` → mock; `live` → live; cloud +
   unset → `provider_mode_missing`; any other value → `provider_mode_invalid`. A configuration error
   registers unavailable stubs (calls throw `unknown`), no OAuth specs, no network, no reauth.
   **D8-A:** in live mode Google Ads is the unavailable stub (`auth` / `provider_unavailable`).
9. **D9** Discovery via `/me/adaccounts` with `ads_read` only. `business_management` only if G1
   proves it is required, and then as a separate decision.
10. **D10** Account mapping from `account_status`; `parentExternalId` from Meta's `business.id`; no
    portfolio or app id in the repository (ownership is operator configuration).
11. **D15** Request-bound composite cursor (`m1.`), fingerprinted by operation, version, account,
    window and request plan.
12. **D21** Capabilities declared from the implemented mapping: all wide metrics except
    `allConversions`, placements `all`/facebook/instagram/audience_network/messenger/threads/other,
    `actionMetrics: true` with windows `1d_click`/`7d_click`/`1d_view`, `incrementalEntities: false`,
    page size 500; scopes `ads_read` only.
13. **D22, D24** Error classification by Graph codes, HTTP status and usage headers only; generic
    messages; `retryAfterMs` from BUC, `X-Ad-Account-Usage` and `Retry-After` (≤ 1 h).
    Configuration and mode errors are `unknown` (no reauth, no block).
14. **D26** Fake-Graph test seam behind the stubbed global `fetch`, serving Marketing-API-shaped
    responses that model the documented API and the provisional assumptions (not recordings; no
    real data); a scrub guard rejects token- and secret-shaped strings in fixtures. No test hooks
    in production code: the provider, OAuth and client factories have no `fetch` or `mapping`
    option; tests replace the global `fetch`, never the factories.
15. **D27** `no-console` for all of `convex/providers/**`; analytics may not import
    `providers/meta`.
16. **D28b** Sanitized OAuth-failure diagnostics: allowlisted `failureKind`, `failureStage` and
    `providerCode` on the existing `connection.oauth_failed` audit, passed through an internal
    argument of `oauthState.fail`; anything else is dropped. No schema or public API change.
17. **D34 (narrow Phase 5 compatibility correction)** — the only sync edit:
    - (a) the page-commit checkpoint resets `rateLimitHits` to 0, so the throttle budget is per page
      (like the transient budget). Ten consecutive throttles on one page still fail the task, and
      backoff restarts from the base after every commit.
    - (c) a `backfill` run that ends `partial` without merging any completed window counts as a
      failure for scheduling: `consecutiveFailures + 1` and
      `nextPlanAt = max(nextDueAt, now + failureBackoffMs(n))` (the failed-run formula). Other run
      kinds, and backfills that merged a window, are unchanged; a successful or window-merging run
      resets the streak.

    Both were latent with mocks and become real with Meta's page counts and deterministic failures.

18. **Mapping seam.** Structure and metric semantics live behind one `MetaMapping` definition,
    `META_MAPPING` in `mapping.ts`, imported directly by the engine (not injectable). Every
    Meta-specific choice is one named definition in `semantics.ts`, tagged `[doc]` or
    `[PROVISIONAL Rn]`. An operation without a mapping entry fails closed with `unknown` /
    `meta_mapping_pending_g1` (never `unsupported`).
19. **Staged insights (D15/D16).** One metrics request is answered in stages: rows without
    breakdown ("all", with reach) and, for the placement breakdown, `publisher_platform` rows
    (without reach). The cursor records the stage, so a placement task stays authoritative for
    every placement. Unknown platforms become `other`; because several raw rows share that
    canonical key and may span Graph pages, they are accumulated in a carry inside the cursor
    (committed atomically with each page by the sync) and emitted on flush pages at the end of
    the stage: exact sums where every contribution reported a metric, absent otherwise; a
    carry beyond the cursor cap fails closed (`placement_carry_limit`).
20. **Provisional semantics (Stage B, real-account validation required).**
    - **D18** absent field or action type = not reported (absent), `"0"` = 0, no row = no delivery.
    - **D19** `conversions` / `conversionValueMicros` = `omni_purchase` + `lead` with each ad set's
      attribution setting (`use_unified_attribution_setting=true`).
    - **D20** action rows for `omni_*` conversion types, `lead` and custom conversions in the fixed
      windows `1d_click`, `7d_click`, `1d_view`; `action_report_time=impression`, hence
      `attributionBasis = impression_or_click_date`. No basis is invented; a mismatch found in
      validation is reported for a decision.
    - **D11** listings and insights explicitly include DELETED/ARCHIVED objects (complete
      `effective_status` enums).
    - **D14** budgets converted from Meta offset units only where unambiguous (else raw kept in
      attributes); dates are account-local; spend and values are decimals in account currency.
    - **D17** reach on "all" rows only, for windows starting within 380 days.
    - **D23** from the 3rd attempt of a page the page size halves per attempt (floor 50).
    - **D12** creatives from `/adcreatives`; format only for unambiguous `object_type` values.
    - **D13** (account time zone/currency in the cursor) not implemented: the time zone and
      currency are read per listing page and rows carry `account_currency`; the sync rejects rows
      whose currency differs from the account.

## Real-account validation

The complete checklist (R1–R20, with how to validate each item) is in
[docs/providers/meta.md](../providers/meta.md#real-account-validation-required).
`scripts/meta-g1-spike.mjs` records scrubbed evidence when an account is available. An
invalidated assumption changes only the Meta provider's `semantics.ts` / `normalize.ts` /
`mapping.ts` and their tests; the schema, v1, sync, analytics and dashboard are unaffected by
design.

## Consequences

- With `PROVIDER_MODE` unset locally, behavior is identical to Phase 7 except D34.
- In live mode a Meta account syncs structure, daily insights (with placements), conversions and
  action metrics into the existing tables; Phase 6 analytics and the Phase 7 dashboard show them
  without any schema or public API change. Their Meta semantics remain provisional until validated
  on a real account.
- Every cloud deployment must set `PROVIDER_MODE`; production must set `live` before its first
  deploy.
- Users reconnect about every 60 days.
