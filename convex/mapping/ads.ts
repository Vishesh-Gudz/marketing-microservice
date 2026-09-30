import type { WithoutSystemFields } from "convex/server";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import { MappingError } from "../providers/errors";
import type {
  ProviderActionRow,
  ProviderAd,
  ProviderAdAccount,
  ProviderAdGroup,
  ProviderCampaign,
  ProviderCreative,
  ProviderMetricRow,
  ProviderRecordKind,
} from "../providers/types";
import { recordIssues } from "../providers/validate";
import type { EntityRefResolver } from "./resolver";
import type { AccountScope, OrgScope } from "./scope";

/**
 * Provider records -> canonical Phase 2 rows. Pure (no DB): the caller
 * supplies the scope (tenant) and a resolver (stored parents). Rows carry
 * createdAt = updatedAt = lastSeenAt = now; the Phase 5 upsert keeps the
 * existing createdAt when patching, enforces natural-key uniqueness, and caps
 * attributes/extras.
 */
export type CanonicalInsert<T extends TableNames> = WithoutSystemFields<Doc<T>>;

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function ensureValid(kind: ProviderRecordKind, record: unknown): void {
  const issues = recordIssues(kind, record);
  if (issues.length > 0) {
    throw new MappingError("invalid_record", `Invalid ${kind} record: ${issues.join("; ")}`, {
      kind,
    });
  }
}

/** Records must belong to the scope's account, platform and currency. */
function ensureInScope(
  record: { platform: string; accountExternalId: string; currency?: string },
  scope: AccountScope,
): void {
  if (record.platform !== scope.platform) {
    throw new MappingError("platform_mismatch", "Record platform does not match the ad account", {
      record: record.platform,
      scope: scope.platform,
    });
  }
  if (record.accountExternalId !== scope.externalId) {
    throw new MappingError("account_mismatch", "Record belongs to a different ad account", {
      record: record.accountExternalId,
      scope: scope.externalId,
    });
  }
  if (record.currency !== undefined && record.currency !== scope.currency) {
    throw new MappingError(
      "currency_mismatch",
      "Record currency differs from the ad account currency",
      {
        record: record.currency,
        scope: scope.currency,
      },
    );
  }
}

function unresolved(kind: string, externalId: string): MappingError {
  return new MappingError(
    "unresolved_entity",
    `${kind} "${externalId}" is not stored for this account`,
    {
      kind,
      externalId,
    },
  );
}

function lifecycle(now: number) {
  return { createdAt: now, updatedAt: now, lastSeenAt: now };
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export function mapAdAccount(
  record: ProviderAdAccount,
  scope: OrgScope,
  now: number,
): CanonicalInsert<"adAccounts"> {
  ensureValid("adAccount", record);
  return compact({ ...record, orgId: scope.orgId, ...lifecycle(now) });
}

export function mapCampaign(
  record: ProviderCampaign,
  scope: AccountScope,
  now: number,
): CanonicalInsert<"campaigns"> {
  ensureValid("campaign", record);
  ensureInScope(record, scope);
  const { accountExternalId: _account, ...rest } = record;
  return compact({
    ...rest,
    orgId: scope.orgId,
    adAccountId: scope.adAccountId,
    platform: scope.platform,
    ...lifecycle(now),
  });
}

export function mapAdGroup(
  record: ProviderAdGroup,
  scope: AccountScope,
  resolver: EntityRefResolver,
  now: number,
): CanonicalInsert<"adGroups"> {
  ensureValid("adGroup", record);
  ensureInScope(record, scope);
  const { accountExternalId: _account, campaignExternalId, ...rest } = record;
  const campaignId = resolver.campaign(campaignExternalId);
  if (campaignId === undefined) throw unresolved("campaign", campaignExternalId);
  return compact({
    ...rest,
    orgId: scope.orgId,
    adAccountId: scope.adAccountId,
    campaignId,
    platform: scope.platform,
    ...lifecycle(now),
  });
}

export function mapCreative(
  record: ProviderCreative,
  scope: AccountScope,
  now: number,
): CanonicalInsert<"creatives"> {
  ensureValid("creative", record);
  ensureInScope(record, scope);
  const { accountExternalId: _account, ...rest } = record;
  return compact({
    ...rest,
    orgId: scope.orgId,
    adAccountId: scope.adAccountId,
    platform: scope.platform,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
}

export function mapAd(
  record: ProviderAd,
  scope: AccountScope,
  resolver: EntityRefResolver,
  now: number,
): CanonicalInsert<"ads"> {
  ensureValid("ad", record);
  ensureInScope(record, scope);
  const {
    accountExternalId: _account,
    campaignExternalId,
    adGroupExternalId,
    creativeExternalId,
    ...rest
  } = record;

  const campaignId = resolver.campaign(campaignExternalId);
  if (campaignId === undefined) throw unresolved("campaign", campaignExternalId);

  let adGroupId: Id<"adGroups"> | undefined;
  if (adGroupExternalId !== undefined) {
    const group = resolver.adGroup(adGroupExternalId);
    if (group === undefined) throw unresolved("adGroup", adGroupExternalId);
    if (group.campaignId !== campaignId) {
      throw new MappingError("invalid_record", "Ad group belongs to a different campaign", {
        adGroupExternalId,
        campaignExternalId,
      });
    }
    adGroupId = group.adGroupId;
  }

  let creativeId: Id<"creatives"> | undefined;
  if (creativeExternalId !== undefined) {
    creativeId = resolver.creative(creativeExternalId);
    if (creativeId === undefined) throw unresolved("creative", creativeExternalId);
  }

  return compact({
    ...rest,
    orgId: scope.orgId,
    adAccountId: scope.adAccountId,
    campaignId,
    adGroupId,
    creativeId,
    platform: scope.platform,
    ...lifecycle(now),
  });
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

type EntityRefs = {
  entityId: Doc<"metricsDaily">["entityId"];
  campaignId?: Id<"campaigns">;
  adGroupId?: Id<"adGroups">;
  adId?: Id<"ads">;
};

function resolveMetricEntity(
  row: ProviderMetricRow | ProviderActionRow,
  scope: AccountScope,
  resolver: EntityRefResolver,
): EntityRefs | undefined {
  switch (row.level) {
    case "account":
      return { entityId: scope.adAccountId };
    case "campaign": {
      const id = resolver.campaign(row.entityExternalId);
      return id === undefined ? undefined : { entityId: id, campaignId: id };
    }
    case "ad_group": {
      const group = resolver.adGroup(row.entityExternalId);
      return group === undefined
        ? undefined
        : { entityId: group.adGroupId, campaignId: group.campaignId, adGroupId: group.adGroupId };
    }
    case "ad": {
      const ad = resolver.ad(row.entityExternalId);
      return ad === undefined
        ? undefined
        : compact({
            entityId: ad.adId,
            campaignId: ad.campaignId,
            adGroupId: ad.adGroupId,
            adId: ad.adId,
          });
    }
  }
}

export type MappedBatch<Row, Record> = {
  rows: Row[];
  /** Records whose entity is not stored yet; the caller decides (Phase 5: retry after structure sync). */
  unresolved: Record[];
};

/**
 * Maps a page of metric rows. Scope violations (platform/account/currency)
 * fail the whole batch; unknown entities are returned in `unresolved`.
 */
export function mapMetricRows(
  records: readonly ProviderMetricRow[],
  scope: AccountScope,
  resolver: EntityRefResolver,
  now: number,
): MappedBatch<CanonicalInsert<"metricsDaily">, ProviderMetricRow> {
  const batch: MappedBatch<CanonicalInsert<"metricsDaily">, ProviderMetricRow> = {
    rows: [],
    unresolved: [],
  };
  for (const record of records) {
    ensureValid("metricRow", record);
    ensureInScope(record, scope);
    const refs = resolveMetricEntity(record, scope, resolver);
    if (refs === undefined) {
      batch.unresolved.push(record);
      continue;
    }
    const { accountExternalId: _account, entityExternalId: _entity, ...rest } = record;
    batch.rows.push(
      compact({
        ...rest,
        ...refs,
        orgId: scope.orgId,
        adAccountId: scope.adAccountId,
        platform: scope.platform,
        currency: scope.currency,
        syncedAt: now,
      }),
    );
  }
  return batch;
}

export function mapActionRows(
  records: readonly ProviderActionRow[],
  scope: AccountScope,
  resolver: EntityRefResolver,
  now: number,
): MappedBatch<CanonicalInsert<"actionMetricsDaily">, ProviderActionRow> {
  const batch: MappedBatch<CanonicalInsert<"actionMetricsDaily">, ProviderActionRow> = {
    rows: [],
    unresolved: [],
  };
  for (const record of records) {
    ensureValid("actionRow", record);
    ensureInScope(record, scope);
    const refs = resolveMetricEntity(record, scope, resolver);
    if (refs === undefined) {
      batch.unresolved.push(record);
      continue;
    }
    const { accountExternalId: _account, entityExternalId: _entity, ...rest } = record;
    batch.rows.push(
      compact({
        ...rest,
        ...refs,
        orgId: scope.orgId,
        adAccountId: scope.adAccountId,
        platform: scope.platform,
        currency: scope.currency,
        syncedAt: now,
      }),
    );
  }
  return batch;
}
