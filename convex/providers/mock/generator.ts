import type { EntityLevel, Placement } from "../../domain/types";
import { PLACEMENTS } from "../../domain/types";
import { compareDateKeys, eachDay, type DateKey } from "../../lib/dates";
import { seededRandom } from "../hash";

/**
 * Deterministic, flavor-neutral metric generation. Values are a pure function
 * of (seed, variant, entity, date, placement): no Math.random, no clock.
 * Leaves (ads, or asset groups without ads) generate per-placement cells;
 * every higher level and the "all" placement are exact sums of those cells,
 * so additive totals are consistent. Reach is non-additive and generated
 * independently per (entity, date) on "all" rows only.
 */

export type ActionCell = {
  /** Flavor-specific raw action key (Meta action_type / Google conversion action name). */
  rawActionType: string;
  /** Flavor-specific window key. */
  window: string;
  count: number;
  valueMicros?: bigint;
};

export type NeutralMetrics = {
  spendMicros: bigint;
  impressions: number;
  clicks: number;
  reach?: number;
  linkClicks?: number;
  videoPlays?: number;
  videoViews?: number;
  engagements?: number;
  reactions?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  follows?: number;
  actions: ActionCell[];
};

export type LeafSpec = {
  level: "ad" | "ad_group";
  externalId: string;
  campaignExternalId: string;
  /** For ad leaves: their ad group; for asset-group leaves: themselves. */
  adGroupExternalId?: string;
  deliveryFrom: DateKey;
  deliveryTo?: DateKey;
  placements: readonly Placement[];
  traits: { video?: boolean; conversions?: "purchase" | "lead" | "none" };
};

export type LeafGenerator = {
  /** Metrics for one leaf/day/placement, or undefined when that placement did not deliver. */
  cell(random: () => number, leaf: LeafSpec, placement: Placement): NeutralMetrics | undefined;
  /** Reach for an "all" row, or undefined if the platform does not report reach. */
  reach?(random: () => number, impressions: number): number | undefined;
};

export type NeutralRow = {
  level: EntityLevel;
  entityExternalId: string;
  date: DateKey;
  placement: Placement;
  metrics: NeutralMetrics;
};

/** Share of leaf-days with no delivery at all (rows omitted: missing, not zero). */
const ZERO_DELIVERY_SHARE = 0.1;

const OPTIONAL_COUNTS = [
  "reach",
  "linkClicks",
  "videoPlays",
  "videoViews",
  "engagements",
  "reactions",
  "comments",
  "shares",
  "saves",
  "follows",
] as const;

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : a + b;
}

/** Additive sum; absent stays absent. Reach is excluded (non-additive). */
export function sumMetrics(items: readonly NeutralMetrics[]): NeutralMetrics {
  const total: NeutralMetrics = { spendMicros: 0n, impressions: 0, clicks: 0, actions: [] };
  const actions = new Map<string, ActionCell>();
  for (const m of items) {
    total.spendMicros += m.spendMicros;
    total.impressions += m.impressions;
    total.clicks += m.clicks;
    for (const key of OPTIONAL_COUNTS) {
      if (key === "reach") continue;
      const value = addOptional(total[key], m[key]);
      if (value !== undefined) total[key] = value;
    }
    for (const cell of m.actions) {
      const key = `${cell.rawActionType}\u0000${cell.window}`;
      const existing = actions.get(key);
      if (!existing) {
        actions.set(key, { ...cell });
      } else {
        existing.count += cell.count;
        if (cell.valueMicros !== undefined) {
          existing.valueMicros = (existing.valueMicros ?? 0n) + cell.valueMicros;
        }
      }
    }
  }
  total.actions = [...actions.values()];
  return total;
}

function entityFor(level: EntityLevel, leaf: LeafSpec, accountExternalId: string) {
  switch (level) {
    case "account":
      return accountExternalId;
    case "campaign":
      return leaf.campaignExternalId;
    case "ad_group":
      return leaf.adGroupExternalId ?? (leaf.level === "ad_group" ? leaf.externalId : undefined);
    case "ad":
      return leaf.level === "ad" ? leaf.externalId : undefined;
  }
}

function isActive(leaf: LeafSpec, date: DateKey) {
  return (
    compareDateKeys(date, leaf.deliveryFrom) >= 0 &&
    (leaf.deliveryTo === undefined || compareDateKeys(date, leaf.deliveryTo) <= 0)
  );
}

const PLACEMENT_ORDER = new Map(PLACEMENTS.map((p, i) => [p, i]));

export function generateNeutralRows(input: {
  seed: string;
  variant: number;
  accountExternalId: string;
  leaves: readonly LeafSpec[];
  generator: LeafGenerator;
  level: EntityLevel;
  from: DateKey;
  to: DateKey;
  breakdown: "none" | "placement";
}): NeutralRow[] {
  const prefix = `${input.seed}|v${input.variant}`;
  // entity -> date -> placement -> cells
  const grouped = new Map<string, Map<DateKey, Map<Placement, NeutralMetrics[]>>>();

  for (const date of eachDay(input.from, input.to)) {
    for (const leaf of input.leaves) {
      if (!isActive(leaf, date)) continue;
      const entity = entityFor(input.level, leaf, input.accountExternalId);
      if (entity === undefined) continue;
      if (seededRandom(`${prefix}|day|${leaf.externalId}|${date}`)() < ZERO_DELIVERY_SHARE)
        continue;

      for (const placement of leaf.placements) {
        const cell = input.generator.cell(
          seededRandom(`${prefix}|cell|${leaf.externalId}|${date}|${placement}`),
          leaf,
          placement,
        );
        if (!cell) continue;
        const byDate = grouped.get(entity) ?? new Map();
        grouped.set(entity, byDate);
        const byPlacement = byDate.get(date) ?? new Map();
        byDate.set(date, byPlacement);
        const cells = byPlacement.get(placement) ?? [];
        byPlacement.set(placement, cells);
        cells.push(cell);
      }
    }
  }

  const rows: NeutralRow[] = [];
  for (const [entity, byDate] of grouped) {
    for (const [date, byPlacement] of byDate) {
      const placementTotals = [...byPlacement.entries()].map(
        ([placement, cells]) => [placement, sumMetrics(cells)] as const,
      );
      const all = sumMetrics(placementTotals.map(([, m]) => m));
      const reach = input.generator.reach?.(
        seededRandom(`${prefix}|reach|${input.level}|${entity}|${date}`),
        all.impressions,
      );
      if (reach !== undefined) all.reach = reach;
      rows.push({
        level: input.level,
        entityExternalId: entity,
        date,
        placement: "all",
        metrics: all,
      });
      if (input.breakdown === "placement") {
        for (const [placement, metrics] of placementTotals) {
          rows.push({ level: input.level, entityExternalId: entity, date, placement, metrics });
        }
      }
    }
  }

  return rows.sort(
    (a, b) =>
      compareDateKeys(a.date, b.date) ||
      (a.entityExternalId < b.entityExternalId
        ? -1
        : a.entityExternalId > b.entityExternalId
          ? 1
          : 0) ||
      PLACEMENT_ORDER.get(a.placement)! - PLACEMENT_ORDER.get(b.placement)!,
  );
}

/** Integer in [min, max]. */
export function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/** Rounds micros down to whole minor units of the currency (e.g. cents). */
export function toMinorUnitMicros(micros: bigint, minorUnits: number): bigint {
  const unit = 10n ** BigInt(6 - minorUnits);
  return (micros / unit) * unit;
}
