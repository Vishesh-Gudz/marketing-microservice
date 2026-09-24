/// <reference types="vite/client" />
import { beforeAll, describe, expect, it } from "vitest";
import { AD_METRICS, type AdMetricKey } from "../domain/metrics";
import { AD_GROUP_KINDS, ENTITY_LEVELS, PLACEMENTS, type EntityLevel } from "../domain/types";
import { addDays, compareDateKeys } from "../lib/dates";
import { isProviderError, type ProviderErrorKind } from "./errors";
import { collectAll } from "./pagination";
import type {
  AdsProvider,
  MetricsRequest,
  ProviderAd,
  ProviderAdAccount,
  ProviderAdGroup,
  ProviderCampaign,
  ProviderContext,
  ProviderCreative,
  ProviderPage,
  ProviderRecordKind,
} from "./types";
import { recordIssues } from "./validate";

/**
 * Reusable contract every AdsProvider must pass: the mock flavors now, the real
 * Meta / Google providers (against recorded fixtures) in Phases 8-9.
 * File name has two dots, so Convex never deploys it.
 */
export type ContractOptions<C> = {
  name: string;
  create: () => AdsProvider<C>;
  credential: C;
  /** A range (<= maxMetricsRangeDays) in which the provider has data. */
  range: { from: string; to: string };
};

/** Internal / tenant identifiers that must never appear on provider records. */
const FORBIDDEN_KEYS = [
  "_id",
  "_creationTime",
  "orgId",
  "adAccountId",
  "campaignId",
  "adGroupId",
  "adId",
  "creativeId",
  "connectionId",
  "linkedAt",
  "entityId",
  "syncedAt",
  "createdAt",
  "updatedAt",
];

export function expectValidRecord(kind: ProviderRecordKind, record: unknown) {
  expect(recordIssues(kind, record), `${kind}: ${JSON.stringify(record, bigintReplacer)}`).toEqual(
    [],
  );
  for (const key of FORBIDDEN_KEYS) expect(record, `${kind}.${key}`).not.toHaveProperty(key);
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? `${value}n` : value;
}

export async function expectProviderError(promise: Promise<unknown>, kind: ProviderErrorKind) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(isProviderError(caught), `expected ProviderError(${kind}), got ${String(caught)}`).toBe(
    true,
  );
  expect((caught as { kind: string }).kind).toBe(kind);
}

type AccountSnapshot = {
  account: ProviderAdAccount;
  campaigns: ProviderCampaign[];
  adGroups: ProviderAdGroup[];
  ads: ProviderAd[];
  creatives: ProviderCreative[];
};

export function runAdsProviderContract<C>(options: ContractOptions<C>) {
  describe(`${options.name}: AdsProvider contract`, () => {
    const provider = options.create();
    const ctx: ProviderContext<C> = { credential: options.credential, attempt: 1 };
    const caps = provider.capabilities;
    const snapshots: AccountSnapshot[] = [];

    const all = <T>(fetch: (cursor: string | undefined) => Promise<ProviderPage<T>>) =>
      collectAll(fetch, { maxPages: 1_000 }).then((r) => r.items);

    const metricsRequest = (
      accountExternalId: string,
      level: EntityLevel,
      breakdown: MetricsRequest["breakdown"],
    ): MetricsRequest => ({ accountExternalId, level, breakdown, ...options.range });

    beforeAll(async () => {
      const accounts = await all((cursor) => provider.listAccounts(ctx, cursor ? { cursor } : {}));
      for (const account of accounts.filter((a) => !a.isManager)) {
        const req = (cursor?: string) => ({
          accountExternalId: account.externalId,
          ...(cursor ? { cursor } : {}),
        });
        snapshots.push({
          account,
          campaigns: caps.entities.campaigns
            ? await all((c) => provider.listCampaigns(ctx, req(c)))
            : [],
          adGroups: caps.entities.adGroups
            ? await all((c) => provider.listAdGroups(ctx, req(c)))
            : [],
          ads: caps.entities.ads ? await all((c) => provider.listAds(ctx, req(c))) : [],
          creatives: caps.entities.creatives
            ? await all((c) => provider.listCreatives(ctx, req(c)))
            : [],
        });
      }
    });

    const withData = () => snapshots.filter((s) => s.campaigns.length > 0);

    it("declares capabilities within the canonical vocabulary", () => {
      expect(caps.placements).toContain("all");
      expect(caps.placements.every((p) => (PLACEMENTS as readonly string[]).includes(p))).toBe(
        true,
      );
      expect(caps.reportedMetrics.every((m) => m in AD_METRICS)).toBe(true);
      expect(
        caps.adGroupKinds.every((k) => (AD_GROUP_KINDS as readonly string[]).includes(k)),
      ).toBe(true);
      expect(caps.metricLevels.every((l) => (ENTITY_LEVELS as readonly string[]).includes(l))).toBe(
        true,
      );
      expect(caps.defaultPageSize).toBeGreaterThan(0);
      expect(caps.maxPageSize).toBeGreaterThanOrEqual(caps.defaultPageSize);
      expect(caps.maxMetricsRangeDays).toBeGreaterThan(0);
    });

    it("lists accounts as valid, tenant-free records of its own platform", async () => {
      const accounts = await all((cursor) => provider.listAccounts(ctx, cursor ? { cursor } : {}));
      expect(accounts.length).toBeGreaterThan(0);
      for (const account of accounts) {
        expectValidRecord("adAccount", account);
        expect(account.platform).toBe(provider.platform);
      }
      const ids = accounts.map((a) => a.externalId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(withData().length).toBeGreaterThan(0);
    });

    it("lists entities with unique ids and referential integrity", () => {
      for (const { account, campaigns, adGroups, ads, creatives } of snapshots) {
        const campaignIds = new Set(campaigns.map((c) => c.externalId));
        const groupIds = new Map(adGroups.map((g) => [g.externalId, g]));
        const creativeIds = new Set(creatives.map((c) => c.externalId));
        expect(campaignIds.size).toBe(campaigns.length);
        expect(groupIds.size).toBe(adGroups.length);
        expect(creativeIds.size).toBe(creatives.length);
        expect(new Set(ads.map((a) => a.externalId)).size).toBe(ads.length);

        for (const [kind, list] of [
          ["campaign", campaigns],
          ["adGroup", adGroups],
          ["ad", ads],
          ["creative", creatives],
        ] as const) {
          for (const record of list) {
            expectValidRecord(kind, record);
            expect(record.platform).toBe(provider.platform);
            expect(record.accountExternalId).toBe(account.externalId);
          }
        }
        for (const group of adGroups) {
          expect(campaignIds.has(group.campaignExternalId), group.externalId).toBe(true);
          expect(caps.adGroupKinds).toContain(group.kind);
        }
        for (const ad of ads) {
          expect(campaignIds.has(ad.campaignExternalId), ad.externalId).toBe(true);
          if (ad.adGroupExternalId !== undefined) {
            expect(groupIds.get(ad.adGroupExternalId)?.campaignExternalId, ad.externalId).toBe(
              ad.campaignExternalId,
            );
          }
          if (ad.creativeExternalId !== undefined) {
            expect(creativeIds.has(ad.creativeExternalId), ad.externalId).toBe(true);
          }
        }
      }
    });

    it("returns metric rows that reference listed entities and honor capabilities", async () => {
      expect(withData().length).toBeGreaterThan(0);
      const rowsPerLevel = new Map<EntityLevel, number>();
      for (const { account, campaigns, adGroups, ads } of withData()) {
        const byLevel: Record<EntityLevel, Set<string>> = {
          account: new Set([account.externalId]),
          campaign: new Set(campaigns.map((c) => c.externalId)),
          ad_group: new Set(adGroups.map((g) => g.externalId)),
          ad: new Set(ads.map((a) => a.externalId)),
        };
        const campaignOf = new Map<string, ProviderCampaign>();
        for (const c of campaigns) campaignOf.set(`campaign:${c.externalId}`, c);
        for (const g of adGroups) {
          campaignOf.set(
            `ad_group:${g.externalId}`,
            campaigns.find((c) => c.externalId === g.campaignExternalId)!,
          );
        }
        for (const a of ads) {
          campaignOf.set(
            `ad:${a.externalId}`,
            campaigns.find((c) => c.externalId === a.campaignExternalId)!,
          );
        }

        for (const level of caps.metricLevels) {
          const breakdown = caps.placementBreakdown ? "placement" : "none";
          const rows = await all((cursor) =>
            provider.fetchDailyMetrics(ctx, {
              ...metricsRequest(account.externalId, level, breakdown),
              ...(cursor ? { cursor } : {}),
            }),
          );
          for (const row of rows) {
            expectValidRecord("metricRow", row);
            expect(row.platform).toBe(provider.platform);
            expect(row.level).toBe(level);
            expect(row.accountExternalId).toBe(account.externalId);
            expect(row.currency).toBe(account.currency);
            expect(
              byLevel[level].has(row.entityExternalId),
              `${level} ${row.entityExternalId}`,
            ).toBe(true);
            expect(compareDateKeys(row.date, options.range.from)).toBeGreaterThanOrEqual(0);
            expect(compareDateKeys(row.date, options.range.to)).toBeLessThanOrEqual(0);
            expect(caps.placements).toContain(row.placement);
            const emitted = Object.keys(row).filter((k): k is AdMetricKey => k in AD_METRICS);
            for (const metric of emitted) expect(caps.reportedMetrics, metric).toContain(metric);

            const campaign = campaignOf.get(`${level}:${row.entityExternalId}`);
            if (campaign?.startDate)
              expect(compareDateKeys(row.date, campaign.startDate)).toBeGreaterThanOrEqual(0);
            if (campaign?.endDate)
              expect(compareDateKeys(row.date, campaign.endDate)).toBeLessThanOrEqual(0);
          }
          const keys = rows.map((r) => `${r.entityExternalId}|${r.date}|${r.placement}`);
          expect(new Set(keys).size, `${level} duplicate upsert keys`).toBe(keys.length);
          rowsPerLevel.set(level, (rowsPerLevel.get(level) ?? 0) + rows.length);
        }
      }
      for (const level of caps.metricLevels) {
        expect(rowsPerLevel.get(level) ?? 0, `${level} rows in range`).toBeGreaterThan(0);
      }
    });

    it("returns only 'all' rows without a placement breakdown", async () => {
      const { account } = withData()[0]!;
      const rows = await all((cursor) =>
        provider.fetchDailyMetrics(ctx, {
          ...metricsRequest(account.externalId, "account", "none"),
          ...(cursor ? { cursor } : {}),
        }),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.placement === "all")).toBe(true);
    });

    it("returns action rows that honor capabilities", async () => {
      const { account } = withData()[0]!;
      const request = metricsRequest(
        account.externalId,
        "campaign",
        caps.placementBreakdown ? "placement" : "none",
      );
      if (!caps.actionMetrics) {
        await expectProviderError(provider.fetchActionMetrics(ctx, request), "unsupported");
        return;
      }
      const rows = await all((cursor) =>
        provider.fetchActionMetrics(ctx, { ...request, ...(cursor ? { cursor } : {}) }),
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expectValidRecord("actionRow", row);
        expect(row.currency).toBe(account.currency);
        expect(caps.attributionWindows).toContain(row.attributionWindow);
        expect(caps.placements).toContain(row.placement);
      }
      const keys = rows.map(
        (r) =>
          `${r.entityExternalId}|${r.date}|${r.placement}|${r.rawActionType}|${r.attributionWindow}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("paginates without gaps or duplicates, whatever the page size", async () => {
      const { account } = withData()[0]!;
      const entityReq = { accountExternalId: account.externalId };
      const small = await all((cursor) =>
        provider.listCampaigns(ctx, { ...entityReq, pageSize: 1, ...(cursor ? { cursor } : {}) }),
      );
      const large = await all((cursor) =>
        provider.listCampaigns(ctx, {
          ...entityReq,
          pageSize: caps.maxPageSize,
          ...(cursor ? { cursor } : {}),
        }),
      );
      expect(small).toEqual(large);

      const request = metricsRequest(account.externalId, "campaign", "placement");
      const pagedRows = await all((cursor) =>
        provider.fetchDailyMetrics(ctx, { ...request, pageSize: 3, ...(cursor ? { cursor } : {}) }),
      );
      const bigRows = await all((cursor) =>
        provider.fetchDailyMetrics(ctx, {
          ...request,
          pageSize: caps.maxPageSize,
          ...(cursor ? { cursor } : {}),
        }),
      );
      expect(pagedRows).toEqual(bigRows);
    });

    it("clamps page sizes to 1..maxPageSize", async () => {
      const { account } = withData()[0]!;
      const request = metricsRequest(account.externalId, "account", "placement");
      const huge = await provider.fetchDailyMetrics(ctx, { ...request, pageSize: 1_000_000 });
      expect(huge.items.length).toBeLessThanOrEqual(caps.maxPageSize);
      const zero = await provider.fetchDailyMetrics(ctx, { ...request, pageSize: 0 });
      expect(zero.items.length).toBeLessThanOrEqual(1);
    });

    it("issues deterministic, request-bound cursors", async () => {
      const { account } = withData()[0]!;
      const request = {
        ...metricsRequest(account.externalId, "campaign", "placement"),
        pageSize: 2,
      };
      const first = await provider.fetchDailyMetrics(ctx, request);
      expect(first.nextCursor).toBeDefined();
      const again = await provider.fetchDailyMetrics(ctx, request);
      expect(again.nextCursor).toBe(first.nextCursor);

      const next = { ...request, cursor: first.nextCursor! };
      expect(await provider.fetchDailyMetrics(ctx, next)).toEqual(
        await provider.fetchDailyMetrics(ctx, next),
      );

      await expectProviderError(
        provider.fetchDailyMetrics(ctx, {
          ...request,
          level: "account",
          cursor: first.nextCursor!,
        }),
        "invalid_request",
      );
      await expectProviderError(
        provider.listCampaigns(ctx, {
          accountExternalId: account.externalId,
          cursor: first.nextCursor!,
        }),
        "invalid_request",
      );
      await expectProviderError(
        provider.fetchDailyMetrics(ctx, { ...request, cursor: "garbage" }),
        "invalid_request",
      );
    });

    it("rejects invalid requests with typed, non-retryable errors", async () => {
      const { account } = withData()[0]!;
      const base = metricsRequest(account.externalId, "account", "none");
      await expectProviderError(
        provider.listCampaigns(ctx, { accountExternalId: "9999999999" }),
        "not_found",
      );
      await expectProviderError(
        provider.fetchDailyMetrics(ctx, {
          ...base,
          from: base.to,
          to: base.from === base.to ? addDays(base.to, -1) : base.from,
        }),
        "invalid_request",
      );
      await expectProviderError(
        provider.fetchDailyMetrics(ctx, {
          ...base,
          to: addDays(base.from, caps.maxMetricsRangeDays),
        }),
        "invalid_request",
      );
      await expectProviderError(
        provider.fetchDailyMetrics(ctx, { ...base, from: "2026-02-30" }),
        "invalid_request",
      );
      for (const level of ENTITY_LEVELS.filter((l) => !caps.metricLevels.includes(l))) {
        await expectProviderError(
          provider.fetchDailyMetrics(ctx, { ...base, level }),
          "unsupported",
        );
      }
    });

    it("applies updatedSince only when incremental listing is supported", async () => {
      const { account, campaigns } = withData()[0]!;
      const since = Math.max(...campaigns.map((c) => c.platformUpdatedAt ?? 0));
      const filtered = await all((cursor) =>
        provider.listCampaigns(ctx, {
          accountExternalId: account.externalId,
          updatedSince: since,
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (caps.incrementalEntities && since > 0) {
        expect(filtered.length).toBeGreaterThan(0);
        expect(filtered.length).toBeLessThanOrEqual(campaigns.length);
        for (const c of filtered) {
          if (c.platformUpdatedAt !== undefined)
            expect(c.platformUpdatedAt).toBeGreaterThanOrEqual(since);
        }
      } else {
        expect(filtered).toEqual(campaigns);
      }
    });
  });
}
