import type { AdPlatform } from "../../domain/types";
import { diffDays, isDateKey } from "../../lib/dates";
import { assertCapability } from "../capabilities";
import { ProviderError, toProviderError } from "../errors";
import { fingerprint } from "../hash";
import { paginateArray } from "../pagination";
import type {
  AccountLookupRequest,
  AdsProvider,
  EntityRequest,
  MetricsRequest,
  PageRequest,
  ProviderContext,
  ProviderOperation,
  ProviderPage,
  ProviderRecordByKind,
  ProviderRecordKind,
} from "../types";
import { assertValidRecord } from "../validate";
import { isMockCredential, type MockCredential } from "./credential";
import type { MockAccountInfo, MockFlavor, RawEntry } from "./flavor";
import { generateNeutralRows } from "./generator";
import { googleFlavor } from "./google";
import { metaFlavor } from "./meta";
import { applyScenarioGates, type MockScenario } from "./scenarios";

export { mockCredential, REVOKED_MOCK_TOKEN, type MockCredential } from "./credential";
export { MOCK_SCENARIOS, RATE_LIMIT_RETRY_AFTER_MS, type MockScenario } from "./scenarios";

const FLAVORS: Record<AdPlatform, MockFlavor> = { meta: metaFlavor, google_ads: googleFlavor };

export type MockProviderOptions = {
  platform: AdPlatform;
  scenario?: MockScenario;
  /** Shifts metric values on identical keys (simulates restated data). Default 0. */
  variant?: number;
};

const SEED = "marketing-mock-v1";

/** Per-call behavior. A MockCredential may override scenario/variant (mock-only test seam). */
type Mode = { scenario: MockScenario; variant: number };

/**
 * Deterministic mock ads provider impersonating a real platform. It walks the
 * same path a real provider will: raw platform-shaped payloads -> page ->
 * normalize -> boundary validation -> provider records. Never touches the
 * network, the database, the clock, or tenant data.
 */
export function createMockAdsProvider(options: MockProviderOptions): AdsProvider<MockCredential> {
  const flavor = FLAVORS[options.platform];
  const caps = flavor.capabilities;
  const platform = flavor.platform;

  function modeOf(ctx: ProviderContext<MockCredential>): Mode {
    const credential = isMockCredential(ctx.credential) ? ctx.credential : undefined;
    return {
      scenario: credential?.scenario ?? options.scenario ?? "default",
      variant: credential?.variant ?? options.variant ?? 0,
    };
  }

  function pageSizeOf(mode: Mode, request: PageRequest) {
    return mode.scenario === "slow_pages" ? 1 : request.pageSize;
  }

  async function run<T>(
    ctx: ProviderContext<MockCredential>,
    operation: ProviderOperation,
    request: { cursor?: string; accountExternalId?: string },
    body: (mode: Mode) => T,
  ): Promise<T> {
    try {
      const mode = modeOf(ctx);
      applyScenarioGates({
        scenario: mode.scenario,
        platform,
        operation,
        ctx,
        cursor: request.cursor,
        ...(request.accountExternalId !== undefined
          ? { accountExternalId: request.accountExternalId }
          : {}),
        deniedAccountExternalId: flavor.deniedAccountExternalId,
      });
      return body(mode);
    } catch (error) {
      throw toProviderError(error, platform, operation);
    }
  }

  function requireAccount(externalId: string, operation: ProviderOperation): MockAccountInfo {
    const account = flavor.accountInfo(externalId);
    if (!account) {
      throw new ProviderError({
        kind: "not_found",
        platform,
        operation,
        message: `Ad account "${externalId}" not found or not accessible`,
      });
    }
    return account;
  }

  function normalizeEntry<K extends ProviderRecordKind>(
    kind: K,
    operation: ProviderOperation,
    entry: RawEntry<ProviderRecordByKind[K]>,
  ): ProviderRecordByKind[K] {
    let record: unknown;
    try {
      record = entry.normalize();
    } catch (error) {
      throw new ProviderError({
        kind: "data",
        platform,
        operation,
        message: `Could not normalize ${kind} "${entry.sortKey}": ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }
    assertValidRecord(kind, record, platform, operation);
    return record;
  }

  /** Pages RAW entries, then normalizes and validates only the returned page. */
  function pageEntities<K extends ProviderRecordKind>(
    mode: Mode,
    kind: K,
    operation: ProviderOperation,
    request: EntityRequest,
    all: RawEntry<ProviderRecordByKind[K]>[],
  ): ProviderPage<ProviderRecordByKind[K]> {
    const since = caps.incrementalEntities ? request.updatedSince : undefined;
    const filtered =
      mode.scenario === "empty"
        ? []
        : all.filter(
            (e) => since === undefined || e.updatedAt === undefined || e.updatedAt >= since,
          );
    const page = paginateArray(
      filtered,
      { ...request, pageSize: pageSizeOf(mode, request) },
      {
        requestFingerprint: fingerprint([operation, request.accountExternalId, since ?? null]),
        defaultPageSize: caps.defaultPageSize,
        maxPageSize: caps.maxPageSize,
        platform,
        operation,
      },
    );
    const items = page.items.map((entry) => normalizeEntry(kind, operation, entry));
    return page.nextCursor === undefined ? { items } : { items, nextCursor: page.nextCursor };
  }

  function validateMetricsRequest(request: MetricsRequest, operation: ProviderOperation) {
    assertCapability(
      caps.metricLevels.includes(request.level),
      platform,
      operation,
      `level "${request.level}"`,
    );
    assertCapability(
      request.breakdown === "none" || caps.placementBreakdown,
      platform,
      operation,
      "placement breakdown",
    );
    const invalid = (message: string) =>
      new ProviderError({ kind: "invalid_request", platform, operation, message });
    if (!isDateKey(request.from) || !isDateKey(request.to))
      throw invalid("from/to must be YYYY-MM-DD");
    const span = diffDays(request.from, request.to);
    if (span < 0) throw invalid("from must not be after to");
    if (span + 1 > caps.maxMetricsRangeDays) {
      throw invalid(`Range exceeds ${caps.maxMetricsRangeDays} days`);
    }
    const account = requireAccount(request.accountExternalId, operation);
    if (account.isManager) throw invalid("Metrics cannot be requested for a manager account");
    return account;
  }

  function neutralRows(mode: Mode, account: MockAccountInfo, request: MetricsRequest) {
    if (mode.scenario === "empty") return [];
    return generateNeutralRows({
      seed: `${SEED}|${platform}`,
      variant: mode.variant,
      accountExternalId: account.externalId,
      leaves: flavor.leaves(account.externalId),
      generator: flavor.generator(account.externalId),
      level: request.level,
      from: request.from,
      to: request.to,
      breakdown: request.breakdown,
    });
  }

  function metricsFingerprint(operation: ProviderOperation, r: MetricsRequest) {
    return fingerprint([operation, r.accountExternalId, r.level, r.from, r.to, r.breakdown]);
  }

  function pageRecords<K extends ProviderRecordKind>(
    mode: Mode,
    kind: K,
    operation: ProviderOperation,
    request: MetricsRequest,
    records: ProviderRecordByKind[K][],
  ): ProviderPage<ProviderRecordByKind[K]> {
    const page = paginateArray(
      records,
      { ...request, pageSize: pageSizeOf(mode, request) },
      {
        requestFingerprint: metricsFingerprint(operation, request),
        defaultPageSize: caps.defaultPageSize,
        maxPageSize: caps.maxPageSize,
        platform,
        operation,
      },
    );
    for (const record of page.items) assertValidRecord(kind, record, platform, operation);
    return page;
  }

  function entityOperation<K extends "campaign" | "adGroup" | "ad" | "creative">(
    kind: K,
    operation: ProviderOperation,
    supported: boolean,
    list: (accountExternalId: string, mode: Mode) => RawEntry<ProviderRecordByKind[K]>[],
  ) {
    return (ctx: ProviderContext<MockCredential>, request: EntityRequest) =>
      run(ctx, operation, request, (mode) => {
        assertCapability(supported, platform, operation, `${kind} listing`);
        requireAccount(request.accountExternalId, operation);
        return pageEntities(mode, kind, operation, request, list(request.accountExternalId, mode));
      });
  }

  return Object.freeze({
    platform,
    providerId: "mock",
    capabilities: caps,

    listAccounts: (ctx: ProviderContext<MockCredential>, request: PageRequest) =>
      run(ctx, "listAccounts", request, (mode) =>
        pageEntities(
          mode,
          "adAccount",
          "listAccounts",
          { ...request, accountExternalId: "" },
          flavor.accounts(),
        ),
      ),

    getAccount: (ctx: ProviderContext<MockCredential>, request: AccountLookupRequest) =>
      run(ctx, "getAccount", request, () => {
        requireAccount(request.accountExternalId, "getAccount");
        const entry = flavor
          .accounts()
          .find((candidate) => candidate.normalize().externalId === request.accountExternalId);
        if (!entry) {
          throw new ProviderError({
            kind: "not_found",
            platform,
            operation: "getAccount",
            message: `Ad account "${request.accountExternalId}" not found or not accessible`,
          });
        }
        return normalizeEntry("adAccount", "getAccount", entry);
      }),

    listCampaigns: entityOperation(
      "campaign",
      "listCampaigns",
      caps.entities.campaigns,
      (a, mode) => flavor.campaigns(a, mode.scenario === "malformed"),
    ),
    listAdGroups: entityOperation("adGroup", "listAdGroups", caps.entities.adGroups, (a, mode) =>
      flavor.adGroups(a, mode.scenario === "malformed"),
    ),
    listAds: entityOperation("ad", "listAds", caps.entities.ads, (a) => flavor.ads(a)),
    listCreatives: entityOperation("creative", "listCreatives", caps.entities.creatives, (a) =>
      flavor.creatives(a),
    ),

    fetchDailyMetrics: (ctx: ProviderContext<MockCredential>, request: MetricsRequest) =>
      run(ctx, "fetchDailyMetrics", request, (mode) => {
        const account = validateMetricsRequest(request, "fetchDailyMetrics");
        const records = flavor.metricRows(account, neutralRows(mode, account, request));
        return pageRecords(mode, "metricRow", "fetchDailyMetrics", request, records);
      }),

    fetchActionMetrics: (ctx: ProviderContext<MockCredential>, request: MetricsRequest) =>
      run(ctx, "fetchActionMetrics", request, (mode) => {
        assertCapability(caps.actionMetrics, platform, "fetchActionMetrics", "action metrics");
        const account = validateMetricsRequest(request, "fetchActionMetrics");
        const records = flavor.actionRows(account, neutralRows(mode, account, request));
        return pageRecords(mode, "actionRow", "fetchActionMetrics", request, records);
      }),
  });
}
