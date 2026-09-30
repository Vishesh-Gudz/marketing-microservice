import { isDateKey, type DateKey } from "../../lib/dates";

/**
 * Typed GAQL builder (Phase 9). Every query is assembled from DECLARED fields and TYPED
 * values — never by concatenating untrusted strings:
 * - fields must be declared for the FROM resource (below); unknown fields are rejected;
 * - values are ids (digits), integers, enums (UPPER_CASE), booleans or dates (YYYY-MM-DD);
 *   there are no free-form string literals, so nothing can be injected;
 * - segments.* and metrics.* are allowed only on metric resources, and
 *   segments.conversion_action* only together with conversion metrics (documented API rule);
 * - ORDER BY fields must be selected, so results are ordered deterministically (paging
 *   offsets rely on it).
 * The declarations describe the documented API surface used by the provider; they are not
 * a metric mapping (mappings live in mapping.ts).
 */

export type GaqlResource =
  | "customer"
  | "customer_client"
  | "campaign"
  | "ad_group"
  | "asset_group"
  | "ad_group_ad"
  | "conversion_action";

type FieldKind =
  | "id"
  | "int"
  | "string"
  | "enum"
  | "bool"
  | "date"
  | "resource_name"
  /** Repeated or message-typed fields (selectable, never filterable). */
  | "message"
  | "metric"
  | "conversion_metric";

const CUSTOMER_FIELDS: Record<string, FieldKind> = {
  "customer.id": "id",
  "customer.descriptive_name": "string",
  "customer.currency_code": "string",
  "customer.time_zone": "string",
  "customer.manager": "bool",
  "customer.status": "enum",
  "customer.test_account": "bool",
};

/** Attributed customer fields, selectable on every metric resource. */
const CUSTOMER_ATTRIBUTES: Record<string, FieldKind> = {
  "customer.id": "id",
  "customer.currency_code": "string",
  "customer.time_zone": "string",
};

const SEGMENTS: Record<string, FieldKind> = {
  "segments.date": "date",
  "segments.ad_network_type": "enum",
  "segments.conversion_action": "resource_name",
  "segments.conversion_action_name": "string",
  "segments.conversion_action_category": "enum",
};

const METRICS: Record<string, FieldKind> = {
  "metrics.impressions": "metric",
  "metrics.clicks": "metric",
  "metrics.cost_micros": "metric",
  "metrics.conversions": "conversion_metric",
  "metrics.conversions_value": "conversion_metric",
  "metrics.all_conversions": "conversion_metric",
  "metrics.all_conversions_value": "conversion_metric",
};

/**
 * Fields selectable/filterable per FROM resource. `noSegments` lists segments the provider
 * never requests on that resource (asset groups: no network segmentation, GR10 / G-D12).
 */
const RESOURCES: Record<
  GaqlResource,
  { fields: Record<string, FieldKind>; metrics: boolean; noSegments?: readonly string[] }
> = {
  customer: { fields: CUSTOMER_FIELDS, metrics: true },
  customer_client: {
    fields: {
      "customer_client.id": "id",
      "customer_client.client_customer": "resource_name",
      "customer_client.descriptive_name": "string",
      "customer_client.currency_code": "string",
      "customer_client.time_zone": "string",
      "customer_client.manager": "bool",
      "customer_client.status": "enum",
      "customer_client.level": "int",
      "customer_client.hidden": "bool",
      "customer_client.test_account": "bool",
    },
    metrics: false,
  },
  campaign: {
    fields: {
      ...CUSTOMER_ATTRIBUTES,
      "campaign.id": "id",
      "campaign.name": "string",
      "campaign.status": "enum",
      "campaign.serving_status": "enum",
      "campaign.advertising_channel_type": "enum",
      "campaign.bidding_strategy_type": "enum",
      "campaign.start_date_time": "string",
      "campaign.end_date_time": "string",
      "campaign.campaign_budget": "resource_name",
      // Attributed resource: the campaign's budget.
      "campaign_budget.id": "id",
      "campaign_budget.period": "enum",
      "campaign_budget.amount_micros": "int",
      "campaign_budget.total_amount_micros": "int",
      "campaign_budget.explicitly_shared": "bool",
    },
    metrics: true,
  },
  ad_group: {
    fields: {
      ...CUSTOMER_ATTRIBUTES,
      "ad_group.id": "id",
      "ad_group.name": "string",
      "ad_group.status": "enum",
      "ad_group.type": "enum",
      "campaign.id": "id",
    },
    metrics: true,
  },
  asset_group: {
    fields: {
      ...CUSTOMER_ATTRIBUTES,
      "asset_group.id": "id",
      "asset_group.name": "string",
      "asset_group.status": "enum",
      "campaign.id": "id",
    },
    metrics: true,
    noSegments: ["segments.ad_network_type"],
  },
  ad_group_ad: {
    fields: {
      ...CUSTOMER_ATTRIBUTES,
      "ad_group_ad.ad.id": "id",
      "ad_group_ad.ad.type": "enum",
      "ad_group_ad.ad.name": "string",
      "ad_group_ad.ad.final_urls": "message",
      "ad_group_ad.ad.responsive_search_ad.headlines": "message",
      "ad_group_ad.ad.responsive_search_ad.descriptions": "message",
      "ad_group_ad.ad.responsive_display_ad.headlines": "message",
      "ad_group_ad.ad.responsive_display_ad.descriptions": "message",
      "ad_group_ad.ad.responsive_display_ad.call_to_action_text": "string",
      "ad_group_ad.status": "enum",
      "ad_group.id": "id",
      "campaign.id": "id",
    },
    metrics: true,
  },
  conversion_action: {
    fields: {
      "conversion_action.id": "id",
      "conversion_action.name": "string",
      "conversion_action.status": "enum",
      "conversion_action.category": "enum",
      "conversion_action.primary_for_goal": "bool",
    },
    metrics: false,
  },
};

export type GaqlValue =
  { id: string } | { int: number } | { enum: string } | { bool: boolean } | { date: DateKey };

export type GaqlCondition =
  | { field: string; op: "=" | "!=" | ">" | ">=" | "<" | "<="; value: GaqlValue }
  | { field: string; op: "IN"; values: readonly GaqlValue[] }
  | { field: string; op: "BETWEEN"; from: DateKey; to: DateKey };

export type GaqlQuery = {
  from: GaqlResource;
  select: readonly string[];
  where?: readonly GaqlCondition[];
  orderBy?: readonly { field: string; direction?: "ASC" | "DESC" }[];
  limit?: number;
};

export class GaqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GaqlError";
  }
}

function kindOf(resource: GaqlResource, field: string): FieldKind {
  const declared = RESOURCES[resource];
  const own = declared.fields[field];
  if (own !== undefined) return own;
  const extra = SEGMENTS[field] ?? METRICS[field];
  if (extra === undefined) throw new GaqlError(`Unknown field for ${resource}: ${field}`);
  if (!declared.metrics) throw new GaqlError(`${resource} has no ${field.split(".")[0]}`);
  if (declared.noSegments?.includes(field)) {
    throw new GaqlError(`${field} is not requested on ${resource}`);
  }
  return extra;
}

const ENUM = /^[A-Z][A-Z0-9_]{0,63}$/;
const ID = /^\d{1,20}$/;

function renderValue(kind: FieldKind, value: GaqlValue): string {
  if ("id" in value) {
    if (kind !== "id" || !ID.test(value.id)) throw new GaqlError("Invalid id value");
    return value.id;
  }
  if ("int" in value) {
    if ((kind !== "int" && kind !== "id") || !Number.isSafeInteger(value.int)) {
      throw new GaqlError("Invalid integer value");
    }
    return String(value.int);
  }
  if ("enum" in value) {
    if (kind !== "enum" || !ENUM.test(value.enum)) throw new GaqlError("Invalid enum value");
    return value.enum;
  }
  if ("bool" in value) {
    if (kind !== "bool") throw new GaqlError("Invalid boolean value");
    return value.bool ? "TRUE" : "FALSE";
  }
  if (kind !== "date" || !isDateKey(value.date)) throw new GaqlError("Invalid date value");
  return `'${value.date}'`;
}

function renderCondition(resource: GaqlResource, condition: GaqlCondition): string {
  const kind = kindOf(resource, condition.field);
  if (
    kind === "string" ||
    kind === "resource_name" ||
    kind === "message" ||
    kind === "metric" ||
    kind === "conversion_metric"
  ) {
    throw new GaqlError(`Field cannot be filtered: ${condition.field}`);
  }
  switch (condition.op) {
    case "IN":
      if (condition.values.length === 0 || condition.values.length > 1_000) {
        throw new GaqlError("IN needs 1..1000 values");
      }
      return `${condition.field} IN (${condition.values.map((v) => renderValue(kind, v)).join(", ")})`;
    case "BETWEEN":
      if (kind !== "date" || !isDateKey(condition.from) || !isDateKey(condition.to)) {
        throw new GaqlError("BETWEEN needs a date field and dates");
      }
      if (condition.from > condition.to) throw new GaqlError("BETWEEN range is reversed");
      return `${condition.field} BETWEEN '${condition.from}' AND '${condition.to}'`;
    default:
      return `${condition.field} ${condition.op} ${renderValue(kind, condition.value)}`;
  }
}

/** Builds a validated GAQL string; throws GaqlError on any violation (a provider bug). */
export function buildGaql(query: GaqlQuery): string {
  if (!(query.from in RESOURCES)) throw new GaqlError("Unknown resource");
  if (query.select.length === 0) throw new GaqlError("Empty SELECT");
  const selected = new Set<string>();
  const kinds = query.select.map((field) => {
    if (selected.has(field)) throw new GaqlError(`Duplicate field: ${field}`);
    selected.add(field);
    return kindOf(query.from, field);
  });
  const conversionSegment = query.select.some((f) => f.startsWith("segments.conversion_action"));
  if (conversionSegment && kinds.some((k) => k === "metric")) {
    throw new GaqlError("segments.conversion_action is compatible only with conversion metrics");
  }
  const where = (query.where ?? []).map((c) => renderCondition(query.from, c));
  const orderBy = (query.orderBy ?? []).map(({ field, direction }) => {
    if (!selected.has(field)) throw new GaqlError(`ORDER BY field must be selected: ${field}`);
    return `${field} ${direction ?? "ASC"}`;
  });
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) {
    throw new GaqlError("Invalid LIMIT");
  }
  return [
    `SELECT ${query.select.join(", ")}`,
    `FROM ${query.from}`,
    ...(where.length > 0 ? [`WHERE ${where.join(" AND ")}`] : []),
    ...(orderBy.length > 0 ? [`ORDER BY ${orderBy.join(", ")}`] : []),
    ...(query.limit !== undefined ? [`LIMIT ${query.limit}`] : []),
  ].join(" ");
}

/** "customer_client.descriptive_name" → ["customerClient", "descriptiveName"] (proto3 JSON). */
export function jsonPath(field: string): string[] {
  return field
    .split(".")
    .map((part) => part.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase()));
}

/** Reads a selected field from a search result row (undefined when absent). */
export function readField(row: unknown, field: string): unknown {
  let value: unknown = row;
  for (const key of jsonPath(field)) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
