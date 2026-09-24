import type { AdPlatform } from "../../domain/types";
import { diffDays, isDateKey } from "../../lib/dates";
import { assertCapability } from "../capabilities";
import { ProviderError, toProviderError } from "../errors";
import { fingerprint } from "../hash";
import { paginateArray } from "../pagination";
import type {
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
import type { MockCredential } from "./credential";
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

/**
 * Deterministic mock ads provider impersonating a real platform. It walks the
 * same path a real provider will: raw platform-shaped payloads -> page ->
 * normalize -> boundary validation -> provider records. Never touches the
 * network, the database, the clock, or tenant data.
 */
export function createMockAdsProvider(options: MockProviderOptions): AdsProvider<MockCredential> {
  const flavor = FLAVORS[options.platform];
  const scenario = options.scenario ?? "default";
  const variant = options.variant ?? 0;
  const caps = flavor.capabilities;
  const platform = flavor.platform;

  function pageSizeOf(request: PageRequest) {
    return scenario === "slow_pages" ? 1 : request.pageSize;
  }

  async function run<T>(
    ctx: ProviderContext<MockCredential>,
    operation: ProviderOperation,
    request: PageRequest & { accountExternalId?: string },
    body: () => ProviderPage<T>,
  ): Promise<ProviderPage<T>> {
    try {
      applyScenarioGates({
        scenario,
        platform,
        operation,
        ctx,
        cursor: request.cursor,
        ...(request.accountExternalId !== undefined
          ? { accountExternalId: request.accountExternalId }
          : {}),
        deniedAccountExternalId: flavor.deniedAccountExternalId,
      });
      return body();
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

  /** Pages RAW entries, then normalizes and validates only the returned page. */
  function pageEntities<K extends ProviderRecordKind>(
    kind: K,
    operation: ProviderOperation,
    request: EntityRequest,
    all: RawEntry<ProviderRecordByKind[K]>[],
  ): ProviderPage<ProviderRecordByKind[K]> {
    const since = caps.incrementalEntities ? request.updatedSince : undefined;
    const filtered =
      scenario === "empty"
        ? []
        : all.filter(
            (e) => since === undefined || e.updatedAt === undefined || e.updatedAt >= since,
          );
    const page = paginateArray(
      filtered,
      { ...request, pageSize: pageSizeOf(request) },
      {
        requestFingerprint: fingerprint([operation, request.accountExternalId, since ?? null]),
        defaultPageSize: caps.defaultPageSize,
        maxPageSize: caps.maxPageSize,
        platform,
        operation,
      },
    );
    const items = page.items.map((entry) => {
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
    });
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

  function neutralRows(account: MockAccountInfo, request: MetricsRequest) {
    if (scenario === "empty") return [];
    return generateNeutralRows({
      seed: `${SEED}|${platform}`,
      variant,
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
    kind: K,
    operation: ProviderOperation,
    request: MetricsRequest,
    records: ProviderRecordByKind[K][],
  ): ProviderPage<ProviderRecordByKind[K]> {
    const page = paginateArray(
      records,
      { ...request, pageSize: pageSizeOf(request) },
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
    list: (accountExternalId: string) => RawEntry<ProviderRecordByKind[K]>[],
  ) {
    return (ctx: ProviderContext<MockCredential>, request: EntityRequest) =>
      run(ctx, operation, request, () => {
        assertCapability(supported, platform, operation, `${kind} listing`);
        requireAccount(request.accountExternalId, operation);
        return pageEntities(kind, operation, request, list(request.accountExternalId));
      });
  }

  const malformed = scenario === "malformed";

  return Object.freeze({
    platform,
    providerId: "mock",
    capabilities: caps,

    listAccounts: (ctx: ProviderContext<MockCredential>, request: PageRequest) =>
      run(ctx, "listAccounts", request, () =>
        pageEntities(
          "adAccount",
          "listAccounts",
          { ...request, accountExternalId: "" },
          flavor.accounts(),
        ),
      ),
    listCampaigns: entityOperation("campaign", "listCampaigns", caps.entities.campaigns, (a) =>
      flavor.campaigns(a, malformed),
    ),
    listAdGroups: entityOperation("adGroup", "listAdGroups", caps.entities.adGroups, (a) =>
      flavor.adGroups(a, malformed),
    ),
    listAds: entityOperation("ad", "listAds", caps.entities.ads, (a) => flavor.ads(a)),
    listCreatives: entityOperation("creative", "listCreatives", caps.entities.creatives, (a) =>
      flavor.creatives(a),
    ),

    fetchDailyMetrics: (ctx: ProviderContext<MockCredential>, request: MetricsRequest) =>
      run(ctx, "fetchDailyMetrics", request, () => {
        const account = validateMetricsRequest(request, "fetchDailyMetrics");
        const records = flavor.metricRows(account, neutralRows(account, request));
        return pageRecords("metricRow", "fetchDailyMetrics", request, records);
      }),

    fetchActionMetrics: (ctx: ProviderContext<MockCredential>, request: MetricsRequest) =>
      run(ctx, "fetchActionMetrics", request, () => {
        assertCapability(caps.actionMetrics, platform, "fetchActionMetrics", "action metrics");
        const account = validateMetricsRequest(request, "fetchActionMetrics");
        const records = flavor.actionRows(account, neutralRows(account, request));
        return pageRecords("actionRow", "fetchActionMetrics", request, records);
      }),
  });
}
