import { vi } from "vitest";
import { appSecretProof } from "./client";

/**
 * Fake Meta Graph (Phase 8 test harness). A `fetch`-compatible function serving
 * Marketing-API-SHAPED fixtures: accounts, campaigns, ad sets, ads, creatives and
 * insights (levels, time_increment=1, publisher_platform breakdown, actions with
 * attribution-window keys), paging, OAuth token flows and injected errors.
 *
 * It models the API as DOCUMENTED and as ASSUMED by the provisional Stage B mapping
 * (docs/providers/meta.md, "Real-account validation required"). It is NOT evidence of
 * real Meta behavior and contains no recorded data. Modeled assumptions:
 * - listings exclude DELETED/ARCHIVED objects unless `effective_status` asks for them, and
 *   insights exclude their delivery unless a `filtering` IN-clause asks for them (R6);
 * - only requested fields are returned; an unknown field is error 100 (like Graph);
 * - zero-valued `inline_link_clicks` and zero-count action types are omitted, and rows
 *   without any action have no `actions` field (R11); days without delivery have no row;
 * - `value` of an action entry is the ad set attribution-setting value; window keys
 *   ("1d_click", …) appear only when `action_attribution_windows` is requested.
 * Every token-bearing call is checked like Graph would (Bearer token + appsecret_proof)
 * and logged so tests can assert transport invariants. Two dots in the file name: never
 * deployed.
 */

export const FAKE_APP_ID = "1234567890";
export const FAKE_APP_SECRET = "test-app-secret";
export const FAKE_CONFIG_ID = "5550001";
export const FAKE_APP_CONFIG = {
  clientId: FAKE_APP_ID,
  clientSecret: FAKE_APP_SECRET,
  extra: { configId: FAKE_CONFIG_ID },
};

export type FakeUser = {
  /** App-scoped user id. */
  id: string;
  name: string;
  scopes: string[];
  /** Ad accounts /me/adaccounts returns (numeric ids). */
  accounts: string[];
  /** debug_token expires_at / data_access_expires_at (seconds; 0 = never). */
  expiresAt?: number;
  dataAccessExpiresAt?: number;
  /** Token issued to another app (debug_token app_id). */
  appId?: string;
  isValid?: boolean;
  granularTargets?: string[];
};

export const FAKE_USERS: Record<string, FakeUser> = {
  u1: {
    id: "1000000001",
    name: "Fake User",
    scopes: ["ads_read", "public_profile"],
    accounts: ["1001", "1002", "1003"],
    expiresAt: 1_800_000_000,
    dataAccessExpiresAt: 1_797_000_000,
    granularTargets: ["1001", "1002", "1003"],
  },
  u2: {
    id: "1000000002",
    name: "Second User",
    scopes: ["ads_read", "public_profile"],
    accounts: ["1001"],
    expiresAt: 1_800_000_000,
  },
  limited: {
    id: "1000000009",
    name: "Limited User",
    scopes: ["public_profile"],
    accounts: [],
    expiresAt: 1_800_000_000,
  },
  noexpiry: {
    id: "1000000003",
    name: "System-like User",
    scopes: ["ads_read"],
    accounts: ["1001"],
    expiresAt: 0,
    dataAccessExpiresAt: 0,
  },
  otherapp: {
    id: "1000000004",
    name: "Other App User",
    scopes: ["ads_read"],
    accounts: ["1001"],
    appId: "999999",
  },
  invalid: {
    id: "1000000005",
    name: "Invalid Token User",
    scopes: ["ads_read"],
    accounts: [],
    isValid: false,
  },
};

type Obj = Record<string, unknown>;

type RawAccount = {
  id: string;
  account_id: string;
  name: string;
  currency: string;
  timezone_name: string;
  account_status: number;
  disable_reason?: number;
  business?: { id: string };
};

/** One action type of one delivery cell: attribution-setting value + window values. */
export type FakeActionCell = {
  value: number;
  "1d_click"?: number;
  "7d_click"?: number;
  "1d_view"?: number;
};

/** Delivery of one ad on one day on one publisher_platform (the leaf all rows aggregate). */
export type FakeCell = {
  adId: string;
  date: string;
  platform: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  videoPlays?: number;
  videoCompletions?: number;
  /** Action counts per action_type. */
  actions: Record<string, FakeActionCell>;
  /** Action values (cents) per action_type. */
  values: Record<string, FakeActionCell>;
};

export type FakeDataset = {
  accounts: RawAccount[];
  campaigns: Record<string, Obj[]>;
  adsets: Record<string, Obj[]>;
  ads: Record<string, Obj[]>;
  adcreatives: Record<string, Obj[]>;
  /** Delivery cells per account. */
  cells: Record<string, FakeCell[]>;
};

function days(from: string, count: number): string[] {
  const start = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
}

/** The days with delivery in the fake dataset (account 1001, America/New_York). */
export const FAKE_DAYS = days("2026-03-01", 7);
export const FAKE_RANGE = { from: FAKE_DAYS[0]!, to: FAKE_DAYS[FAKE_DAYS.length - 1]! };

/** Average purchase value (cents) of the fake shop. */
const PURCHASE_VALUE_CENTS = 4_550;

type DeliveryPlan = {
  adId: string;
  dayIndexes: number[];
  platforms: string[];
  kind: "purchase" | "video" | "lead" | "none";
  /** Ad set attribution setting: unified value = these windows summed. */
  unified: ("7d_click" | "1d_click" | "1d_view")[];
};

const DELIVERY: DeliveryPlan[] = [
  {
    adId: "4001",
    dayIndexes: [0, 1, 2, 3, 4, 5, 6],
    platforms: ["facebook", "instagram"],
    kind: "purchase",
    unified: ["7d_click", "1d_view"],
  },
  {
    adId: "4002",
    dayIndexes: [0, 1, 2, 3, 4, 5, 6],
    platforms: ["facebook", "instagram", "audience_network"],
    kind: "video",
    unified: ["7d_click", "1d_view"],
  },
  {
    adId: "4003",
    dayIndexes: [0, 1, 2, 3],
    platforms: ["facebook", "instagram"],
    kind: "lead",
    unified: ["1d_click"],
  },
  {
    adId: "4004",
    dayIndexes: [0, 1, 2],
    platforms: ["facebook", "threads"],
    kind: "none",
    unified: ["7d_click", "1d_view"],
  },
  {
    adId: "4005",
    dayIndexes: [0, 1],
    platforms: ["facebook"],
    kind: "none",
    unified: ["7d_click", "1d_view"],
  },
];

function windows(
  counts: { "1d_click": number; "7d_click": number; "1d_view": number },
  unified: DeliveryPlan["unified"],
  scale = 1,
): FakeActionCell {
  const cell: FakeActionCell = {
    value: unified.reduce((sum, key) => sum + counts[key], 0) * scale,
  };
  for (const key of ["1d_click", "7d_click", "1d_view"] as const) {
    if (counts[key] > 0) cell[key] = counts[key] * scale;
  }
  return cell;
}

function plain(value: number): FakeActionCell {
  return { value };
}

function deliveryCells(): FakeCell[] {
  const cells: FakeCell[] = [];
  DELIVERY.forEach((plan, a) => {
    for (const d of plan.dayIndexes) {
      plan.platforms.forEach((platform, p) => {
        // Audience Network delivers only on even days (missing combinations stay missing).
        if (platform === "audience_network" && d % 2 === 1) return;
        const impressions = 600 + ((a * 131 + d * 57 + p * 29) % 900);
        let clicks = Math.floor((impressions * (12 + ((a + d + p) % 7))) / 1000);
        // A reported zero: ad 4002 on Instagram on 2026-03-04 had no clicks at all.
        if (plan.adId === "4002" && platform === "instagram" && d === 3) clicks = 0;
        const linkClicks = Math.floor(clicks * 0.6);
        const actions: Record<string, FakeActionCell> = {};
        const values: Record<string, FakeActionCell> = {};
        const reactions = 3 + ((a + d * 3 + p) % 5);
        const comments = (a + d + p) % 3;
        actions.post_reaction = plain(reactions);
        if (comments > 0) actions.comment = plain(comments);
        if (linkClicks > 0) actions.link_click = plain(linkClicks);
        actions.post_engagement = plain(reactions + comments + linkClicks);
        if (d === 0 && p === 0) actions.like = plain(1);
        if ((d + p) % 2 === 0) actions["onsite_conversion.post_save"] = plain(1);
        let videoPlays: number | undefined;
        let videoCompletions: number | undefined;
        if (plan.kind === "video") {
          videoPlays = Math.floor(impressions * 0.35);
          videoCompletions = Math.floor(impressions * 0.05);
          actions.video_view = plain(Math.floor(impressions * 0.3));
        }
        if (plan.kind === "purchase" && (d + p) % 3 !== 2) {
          const count = 1 + ((a + d + p) % 3);
          const counts = {
            "1d_click": count > 1 ? count - 1 : count,
            "7d_click": count,
            "1d_view": d % 2,
          };
          actions.omni_purchase = windows(counts, plan.unified);
          // The channel-specific type is part of omni_purchase (never stored twice).
          actions["offsite_conversion.fb_pixel_purchase"] = windows(counts, plan.unified);
          actions.omni_add_to_cart = windows(
            { "1d_click": count + 1, "7d_click": count + 2, "1d_view": 0 },
            plan.unified,
          );
          values.omni_purchase = windows(counts, plan.unified, PURCHASE_VALUE_CENTS);
          values["offsite_conversion.fb_pixel_purchase"] = windows(
            counts,
            plan.unified,
            PURCHASE_VALUE_CENTS,
          );
        }
        if (plan.kind === "lead") {
          const leads = 1 + (d % 2);
          const counts = { "1d_click": leads, "7d_click": leads, "1d_view": 0 };
          actions.lead = windows(counts, plan.unified);
          actions["onsite_conversion.lead_grouped"] = windows(counts, plan.unified);
          if (d % 2 === 1) {
            actions["offsite_conversion.custom.8880001"] = windows(
              { "1d_click": 1, "7d_click": 1, "1d_view": 0 },
              plan.unified,
            );
          }
        }
        cells.push({
          adId: plan.adId,
          date: FAKE_DAYS[d]!,
          platform,
          spendCents: Math.floor((impressions * (850 + a * 40)) / 1000),
          impressions,
          clicks,
          linkClicks,
          ...(videoPlays !== undefined ? { videoPlays } : {}),
          ...(videoCompletions !== undefined ? { videoCompletions } : {}),
          actions,
          values,
        });
      });
    }
  });
  // Two unrecognized publisher_platform values for the SAME ad and day: both map to the
  // canonical placement "other" and must be accumulated, even across pages (R9). Between
  // them: clicks explicitly "0" on both, inline_link_clicks omitted on both, post_reaction
  // reported by one only (the merged total is unknown → absent), the rest on both (summed).
  cells.push(
    {
      adId: "4004",
      date: FAKE_DAYS[1]!,
      platform: "unknown",
      spendCents: 37,
      impressions: 41,
      clicks: 0,
      linkClicks: 0,
      actions: { post_reaction: plain(1), post_engagement: plain(1) },
      values: {},
    },
    {
      adId: "4004",
      date: FAKE_DAYS[1]!,
      platform: "oculus",
      spendCents: 52,
      impressions: 60,
      clicks: 0,
      linkClicks: 0,
      actions: { post_engagement: plain(2) },
      values: {},
    },
  );
  return cells;
}

/**
 * Account 1001 (USD, America/New_York): an active CBO sales campaign, a paused ABO lead
 * campaign, an ARCHIVED legacy-objective campaign and a DELETED campaign, each with one ad
 * set and ads that delivered on 2026-03-01..07. Accounts 1002 (JPY, disabled) and 1003
 * (EUR, closed) have no objects.
 */
export function fakeMetaDataset(): FakeDataset {
  return {
    accounts: [
      {
        id: "act_1001",
        account_id: "1001",
        name: "Fake Shop USD",
        currency: "USD",
        timezone_name: "America/New_York",
        account_status: 1,
        business: { id: "7770001" },
      },
      {
        id: "act_1002",
        account_id: "1002",
        name: "Fake Shop JPY",
        currency: "JPY",
        timezone_name: "Asia/Tokyo",
        account_status: 2,
        disable_reason: 3,
      },
      {
        id: "act_1003",
        account_id: "1003",
        name: "Fake Closed EUR",
        currency: "EUR",
        timezone_name: "Europe/Berlin",
        account_status: 101,
      },
    ],
    campaigns: {
      "1001": [
        {
          id: "2001",
          name: "Prospecting — Sales",
          status: "ACTIVE",
          effective_status: "ACTIVE",
          objective: "OUTCOME_SALES",
          daily_budget: "15000",
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
          start_time: "2026-02-15T00:00:00-0500",
          created_time: "2026-02-10T09:00:00-0500",
          updated_time: "2026-03-02T10:00:00-0500",
        },
        {
          id: "2002",
          name: "Leads — ABO",
          status: "PAUSED",
          effective_status: "PAUSED",
          objective: "OUTCOME_LEADS",
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
          start_time: "2026-02-20T00:00:00-0500",
          stop_time: "2026-04-30T23:59:59-0400",
          created_time: "2026-02-18T11:30:00-0500",
          updated_time: "2026-03-05T08:00:00-0500",
        },
        {
          id: "2003",
          name: "Spring Awareness",
          status: "ARCHIVED",
          effective_status: "ARCHIVED",
          objective: "REACH",
          lifetime_budget: "50000",
          start_time: "2026-01-01T00:00:00-0500",
          stop_time: "2026-03-31T23:59:59-0400",
          created_time: "2025-12-20T09:00:00-0500",
          updated_time: "2026-03-04T12:00:00-0500",
        },
        {
          id: "2004",
          name: "Old Traffic Test",
          status: "DELETED",
          effective_status: "DELETED",
          objective: "LINK_CLICKS",
          start_time: "2026-02-01T00:00:00-0500",
          created_time: "2026-01-30T09:00:00-0500",
          updated_time: "2026-03-03T16:00:00-0500",
        },
      ],
    },
    adsets: {
      "1001": [
        {
          id: "3001",
          name: "Broad US 25-54",
          campaign_id: "2001",
          status: "ACTIVE",
          effective_status: "ACTIVE",
          optimization_goal: "OFFSITE_CONVERSIONS",
          attribution_spec: [
            { event_type: "CLICK_THROUGH", window_days: 7 },
            { event_type: "VIEW_THROUGH", window_days: 1 },
          ],
          start_time: "2026-02-15T00:00:00-0500",
        },
        {
          id: "3002",
          name: "Lookalike leads",
          campaign_id: "2002",
          status: "ACTIVE",
          effective_status: "CAMPAIGN_PAUSED",
          daily_budget: "5000",
          optimization_goal: "LEAD_GENERATION",
          attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
          start_time: "2026-02-20T00:00:00-0500",
        },
        {
          id: "3003",
          name: "Reach all",
          campaign_id: "2003",
          status: "ARCHIVED",
          effective_status: "ARCHIVED",
          optimization_goal: "REACH",
          start_time: "2026-01-01T00:00:00-0500",
          end_time: "2026-03-31T23:59:59-0400",
        },
        {
          id: "3004",
          name: "Traffic test",
          campaign_id: "2004",
          status: "DELETED",
          effective_status: "DELETED",
          daily_budget: "2000",
          optimization_goal: "LINK_CLICKS",
        },
      ],
    },
    ads: {
      "1001": [
        {
          id: "4001",
          name: "Sale — photo",
          campaign_id: "2001",
          adset_id: "3001",
          status: "ACTIVE",
          effective_status: "ACTIVE",
          creative: { id: "5001", object_type: "PHOTO" },
        },
        {
          id: "4002",
          name: "Sale — video",
          campaign_id: "2001",
          adset_id: "3001",
          status: "ACTIVE",
          effective_status: "ACTIVE",
          creative: { id: "5002", object_type: "VIDEO" },
        },
        {
          id: "4003",
          name: "Quote — link",
          campaign_id: "2002",
          adset_id: "3002",
          status: "ACTIVE",
          effective_status: "CAMPAIGN_PAUSED",
          creative: { id: "5003", object_type: "SHARE" },
        },
        {
          id: "4004",
          name: "Awareness — photo",
          campaign_id: "2003",
          adset_id: "3003",
          status: "ARCHIVED",
          effective_status: "ARCHIVED",
          creative: { id: "5001", object_type: "PHOTO" },
        },
        {
          id: "4005",
          name: "Traffic — deleted",
          campaign_id: "2004",
          adset_id: "3004",
          status: "DELETED",
          effective_status: "DELETED",
        },
      ],
    },
    adcreatives: {
      "1001": [
        {
          id: "5001",
          name: "Photo creative",
          object_type: "PHOTO",
          title: "Spring sale",
          body: "Up to 30% off",
          call_to_action_type: "SHOP_NOW",
          link_url: "https://shop.example.test/spring",
          thumbnail_url: "https://cdn.example.test/t/5001.jpg",
          image_url: "https://cdn.example.test/i/5001.jpg",
          effective_object_story_id: "7770002_9990001",
          effective_instagram_media_id: "17900000000000001",
        },
        {
          id: "5002",
          object_type: "VIDEO",
          title: "Spring sale video",
          call_to_action_type: "SHOP_NOW",
          thumbnail_url: "https://cdn.example.test/t/5002.jpg",
          video_id: "6660001",
        },
        {
          id: "5003",
          object_type: "SHARE",
          title: "Get a quote",
          body: "Tell us about your project",
          call_to_action_type: "SIGN_UP",
          link_url: "https://quotes.example.test/start",
        },
      ],
    },
    cells: { "1001": deliveryCells() },
  };
}

export type FakeResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

export type RequestLogEntry = {
  method: string;
  version: string;
  /** Path after the version, e.g. "act_1001/campaigns". */
  path: string;
  params: Record<string, string>;
  /** Form fields of POST bodies (names only). */
  formFields: string[];
  auth: "user" | "app" | "none";
  hasProof: boolean;
  /** True if any URL parameter carries a secret (access_token / client_secret / code). */
  secretInUrl: boolean;
};

export type InjectRule = {
  match: (entry: RequestLogEntry) => boolean;
  /** How many times the rule fires (default 1). */
  times?: number;
  response: FakeResponse | "network" | "hang";
};

export type FakeGraph = {
  fetch: typeof fetch;
  log: RequestLogEntry[];
  /** An authorization code for `user` (single use). */
  issueCode(user: keyof typeof FAKE_USERS | string): string;
  inject(rule: InjectRule): void;
  /** Number of Graph calls made so far. */
  calls(): number;
};

export function graphError(code: number, subcode?: number, status = 400): FakeResponse {
  return {
    status,
    body: {
      error: {
        message: "Fake Graph error",
        type: "OAuthException",
        code,
        ...(subcode !== undefined ? { error_subcode: subcode } : {}),
      },
    },
  };
}

const SECRET_PARAMS = ["access_token", "client_secret", "code", "fb_exchange_token"];

function encodeAfter(offset: number): string {
  return btoa(`o:${offset}`).replace(/=+$/, "");
}

function decodeAfter(after: string): number | undefined {
  try {
    const match = /^o:(\d+)$/.exec(atob(after));
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function toResponse(fake: FakeResponse): Response {
  return new Response(fake.body === undefined ? "" : JSON.stringify(fake.body), {
    status: fake.status,
    headers: { "Content-Type": "application/json", ...(fake.headers ?? {}) },
  });
}

/** URLSearchParams as a plain object (the Convex tsconfig has no DOM iterables). */
export function paramsObject(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  params.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Cents → Meta decimal money string ("12.34", "0"). */
export function centsToDecimal(cents: number): string {
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Field projection (Graph returns only requested fields; unknown fields are errors)
// ---------------------------------------------------------------------------

class UnknownField extends Error {}

/** "id,creative{id,object_type}" → Map(name → sub-field spec). */
function parseFields(spec: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= spec.length; i++) {
    const ch = spec[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if ((ch === "," || i === spec.length) && depth === 0) {
      const part = spec.slice(start, i).trim();
      if (part !== "") {
        const match = /^([a-z0-9_]+)(?:\{(.*)\})?$/.exec(part);
        if (!match) throw new UnknownField(part);
        out.set(match[1]!, match[2]);
      }
      start = i + 1;
    }
  }
  return out;
}

function project(obj: Obj, fields: Map<string, string | undefined>): Obj {
  const out: Obj = {};
  for (const [name, sub] of fields) {
    if (!(name in obj)) continue;
    const value = obj[name];
    out[name] =
      sub !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
        ? project(value as Obj, parseFields(sub))
        : value;
  }
  return out;
}

const KNOWN_FIELDS: Record<string, ReadonlySet<string>> = {
  account: new Set([
    "id",
    "account_id",
    "name",
    "currency",
    "timezone_name",
    "account_status",
    "disable_reason",
    "business",
  ]),
  campaigns: new Set([
    "id",
    "name",
    "status",
    "effective_status",
    "configured_status",
    "objective",
    "daily_budget",
    "lifetime_budget",
    "bid_strategy",
    "start_time",
    "stop_time",
    "created_time",
    "updated_time",
  ]),
  adsets: new Set([
    "id",
    "name",
    "campaign_id",
    "status",
    "effective_status",
    "daily_budget",
    "lifetime_budget",
    "optimization_goal",
    "attribution_spec",
    "start_time",
    "end_time",
    "created_time",
    "updated_time",
  ]),
  ads: new Set([
    "id",
    "name",
    "campaign_id",
    "adset_id",
    "status",
    "effective_status",
    "creative",
    "created_time",
    "updated_time",
  ]),
  adcreatives: new Set([
    "id",
    "name",
    "object_type",
    "title",
    "body",
    "call_to_action_type",
    "link_url",
    "thumbnail_url",
    "image_url",
    "video_id",
    "effective_object_story_id",
    "effective_instagram_media_id",
  ]),
  insights: new Set([
    "date_start",
    "date_stop",
    "account_id",
    "account_currency",
    "campaign_id",
    "adset_id",
    "ad_id",
    "spend",
    "impressions",
    "clicks",
    "reach",
    "inline_link_clicks",
    "actions",
    "action_values",
    "video_play_actions",
    "video_p100_watched_actions",
  ]),
};

function requestedFields(
  params: Record<string, string>,
  edge: keyof typeof KNOWN_FIELDS,
): Map<string, string | undefined> {
  const fields = parseFields(params.fields ?? "id");
  for (const name of fields.keys()) {
    if (!KNOWN_FIELDS[edge]!.has(name)) throw new UnknownField(name);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Insights aggregation
// ---------------------------------------------------------------------------

const INSIGHT_LEVELS = ["account", "campaign", "adset", "ad"] as const;
type InsightLevel = (typeof INSIGHT_LEVELS)[number];
const WINDOW_KEYS = ["1d_click", "7d_click", "1d_view", "28d_click", "1d_ev"];
const HIDDEN_BY_DEFAULT = new Set(["DELETED", "ARCHIVED"]);

type Aggregate = {
  spendCents: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  videoPlays: number;
  videoCompletions: number;
  actions: Map<string, FakeActionCell>;
  values: Map<string, FakeActionCell>;
};

function addActions(target: Map<string, FakeActionCell>, source: Record<string, FakeActionCell>) {
  for (const [type, cell] of Object.entries(source)) {
    const sum = target.get(type) ?? { value: 0 };
    sum.value += cell.value;
    for (const key of ["1d_click", "7d_click", "1d_view"] as const) {
      if (cell[key] !== undefined) sum[key] = (sum[key] ?? 0) + cell[key];
    }
    target.set(type, sum);
  }
}

function actionEntries(
  map: Map<string, FakeActionCell>,
  windows: string[] | undefined,
  format: (n: number) => string,
): Obj[] | undefined {
  const entries = [...map.entries()]
    .filter(([, cell]) => cell.value > 0 || (windows ?? []).some((w) => (cell as Obj)[w]))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([type, cell]) => {
      const entry: Obj = { action_type: type, value: format(cell.value) };
      for (const window of windows ?? []) {
        const n = (cell as Record<string, number | undefined>)[window];
        if (n !== undefined && n > 0) entry[window] = format(n);
      }
      return entry;
    });
  return entries.length > 0 ? entries : undefined;
}

export function createFakeGraph(
  options: {
    dataset?: FakeDataset;
    users?: Record<string, FakeUser>;
    /** Graph may return fewer rows than `limit`: at most this many per page. */
    pageCap?: number;
  } = {},
): FakeGraph {
  const dataset = options.dataset ?? fakeMetaDataset();
  const users = options.users ?? FAKE_USERS;
  const log: RequestLogEntry[] = [];
  const rules: InjectRule[] = [];
  const codes = new Map<string, { user: string; used: boolean }>();
  let codeSeq = 0;

  const shortToken = (user: string) => `test-short-${user}`;
  const longToken = (user: string) => `test-long-${user}`;
  const userOfLong = (token: string) =>
    token.startsWith("test-long-") ? users[token.slice("test-long-".length)] : undefined;

  function page(items: unknown[], params: Record<string, string>): Response {
    const limit = Math.max(
      1,
      Math.min(Number(params.limit ?? "25") || 25, 5000, options.pageCap ?? 5000),
    );
    let offset = 0;
    if (params.after !== undefined) {
      const decoded = decodeAfter(params.after);
      if (decoded === undefined || decoded > items.length) {
        return toResponse(graphError(100));
      }
      offset = decoded;
    }
    const end = offset + limit;
    const hasMore = end < items.length;
    return json(200, {
      data: items.slice(offset, end),
      paging: {
        cursors: { before: encodeAfter(offset), after: encodeAfter(Math.min(end, items.length)) },
        ...(hasMore ? { next: "https://graph.facebook.com/fake-next-page" } : {}),
      },
    });
  }

  /** Listing edge: effective_status filter (default hides DELETED/ARCHIVED) + projection. */
  function listing(
    edge: "campaigns" | "adsets" | "ads" | "adcreatives",
    accountId: string,
    params: Record<string, string>,
  ): Response {
    const fields = requestedFields(params, edge);
    let items = dataset[edge][accountId] ?? [];
    if (edge !== "adcreatives") {
      const statuses = params.effective_status
        ? new Set(JSON.parse(params.effective_status) as string[])
        : undefined;
      items = items.filter((item) => {
        const status = String(item.effective_status);
        return statuses ? statuses.has(status) : !HIDDEN_BY_DEFAULT.has(status);
      });
    }
    return page(
      items.map((item) => project(item, fields)),
      params,
    );
  }

  function insights(accountId: string, params: Record<string, string>): Response {
    const account = dataset.accounts.find((a) => a.account_id === accountId)!;
    const level = (params.level ?? "account") as InsightLevel;
    if (!INSIGHT_LEVELS.includes(level)) return toResponse(graphError(100));
    if (params.time_increment !== undefined && params.time_increment !== "1") {
      return toResponse(graphError(100));
    }
    const breakdown = params.breakdowns;
    if (breakdown !== undefined && breakdown !== "publisher_platform") {
      return toResponse(graphError(100));
    }
    const fields = requestedFields(params, "insights");
    const windows = params.action_attribution_windows
      ? (JSON.parse(params.action_attribution_windows) as string[])
      : undefined;
    if (windows?.some((w) => !WINDOW_KEYS.includes(w))) return toResponse(graphError(100));
    const range = params.time_range
      ? (JSON.parse(params.time_range) as { since: string; until: string })
      : undefined;
    const filters = params.filtering
      ? (JSON.parse(params.filtering) as { field: string; operator: string; value: string[] }[])
      : [];

    const ads = new Map((dataset.ads[accountId] ?? []).map((a) => [String(a.id), a]));
    const adsets = new Map((dataset.adsets[accountId] ?? []).map((a) => [String(a.id), a]));
    const campaigns = new Map((dataset.campaigns[accountId] ?? []).map((c) => [String(c.id), c]));
    const objectsOf = (adId: string) => {
      const ad = ads.get(adId)!;
      const adset = adsets.get(String(ad.adset_id))!;
      return { ad, adset, campaign: campaigns.get(String(ad.campaign_id))! };
    };

    const groups = new Map<string, { ids: Obj; date: string; platform?: string; agg: Aggregate }>();
    for (const cell of dataset.cells[accountId] ?? []) {
      if (range && (cell.date < range.since || cell.date > range.until)) continue;
      const objects = objectsOf(cell.adId);
      if (level !== "account") {
        if (filters.length > 0) {
          const pass = filters.every((f) => {
            const [prefix, property] = f.field.split(".");
            const object = objects[prefix as "ad" | "adset" | "campaign"];
            if (f.operator !== "IN" || property !== "effective_status" || object === undefined) {
              throw new UnknownField(f.field);
            }
            return f.value.includes(String(object.effective_status));
          });
          if (!pass) continue;
        } else {
          const own = { campaign: objects.campaign, adset: objects.adset, ad: objects.ad }[level];
          if (HIDDEN_BY_DEFAULT.has(String(own.effective_status))) continue;
        }
      }
      const ids: Obj = { account_id: accountId };
      if (level !== "account") ids.campaign_id = String(objects.campaign.id);
      if (level === "adset" || level === "ad") ids.adset_id = String(objects.adset.id);
      if (level === "ad") ids.ad_id = String(objects.ad.id);
      const platform = breakdown ? cell.platform : undefined;
      const key = JSON.stringify([ids, cell.date, platform ?? null]);
      const group = groups.get(key) ?? {
        ids,
        date: cell.date,
        ...(platform !== undefined ? { platform } : {}),
        agg: {
          spendCents: 0,
          impressions: 0,
          clicks: 0,
          linkClicks: 0,
          videoPlays: 0,
          videoCompletions: 0,
          actions: new Map(),
          values: new Map(),
        },
      };
      const agg = group.agg;
      agg.spendCents += cell.spendCents;
      agg.impressions += cell.impressions;
      agg.clicks += cell.clicks;
      agg.linkClicks += cell.linkClicks;
      agg.videoPlays += cell.videoPlays ?? 0;
      agg.videoCompletions += cell.videoCompletions ?? 0;
      addActions(agg.actions, cell.actions);
      addActions(agg.values, cell.values);
      groups.set(key, group);
    }

    const rows = [...groups.values()]
      .map(({ ids, date, platform, agg }) => {
        const full: Obj = {
          ...ids,
          account_currency: account.currency,
          ...(platform !== undefined ? { publisher_platform: platform } : {}),
          spend: centsToDecimal(agg.spendCents),
          impressions: String(agg.impressions),
          clicks: String(agg.clicks),
          reach: String(Math.floor(agg.impressions * 0.8)),
          ...(agg.linkClicks > 0 ? { inline_link_clicks: String(agg.linkClicks) } : {}),
          actions: actionEntries(agg.actions, windows, String),
          action_values: actionEntries(agg.values, windows, centsToDecimal),
          ...(agg.videoPlays > 0
            ? { video_play_actions: [{ action_type: "video_view", value: String(agg.videoPlays) }] }
            : {}),
          ...(agg.videoCompletions > 0
            ? {
                video_p100_watched_actions: [
                  { action_type: "video_view", value: String(agg.videoCompletions) },
                ],
              }
            : {}),
        };
        const row: Obj = {
          ...project(full, fields),
          date_start: date,
          date_stop: date,
          ...(platform !== undefined ? { publisher_platform: platform } : {}),
        };
        for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key];
        return row;
      })
      .sort((a, b) => {
        const ka = `${String(a.date_start)}|${String(a.ad_id ?? a.adset_id ?? a.campaign_id ?? "")}|${String(a.publisher_platform ?? "")}`;
        const kb = `${String(b.date_start)}|${String(b.ad_id ?? b.adset_id ?? b.campaign_id ?? "")}|${String(b.publisher_platform ?? "")}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
    return page(rows, params);
  }

  async function route(entry: RequestLogEntry, request: Request): Promise<Response> {
    const { path, params } = entry;

    // --- OAuth -------------------------------------------------------------
    if (path === "oauth/access_token" && entry.method === "POST") {
      const form = new URLSearchParams(await request.text());
      if (form.get("client_id") !== FAKE_APP_ID || form.get("client_secret") !== FAKE_APP_SECRET) {
        return toResponse(graphError(1));
      }
      if (form.get("grant_type") === "fb_exchange_token") {
        const token = form.get("fb_exchange_token") ?? "";
        if (!token.startsWith("test-short-")) return toResponse(graphError(190));
        const user = token.slice("test-short-".length);
        return json(200, {
          access_token: longToken(user),
          token_type: "bearer",
          expires_in: 5_183_944,
        });
      }
      const code = form.get("code") ?? "";
      const issued = codes.get(code);
      if (!issued || !form.get("redirect_uri")) return toResponse(graphError(100, 36_007));
      if (issued.used) return toResponse(graphError(100, 36_009));
      issued.used = true;
      return json(200, {
        access_token: shortToken(issued.user),
        token_type: "bearer",
        expires_in: 3_600,
      });
    }
    if (path === "debug_token") {
      if (entry.auth !== "app") return toResponse(graphError(190));
      const user = userOfLong(params.input_token ?? "");
      if (!user) return json(200, { data: { app_id: FAKE_APP_ID, is_valid: false } });
      return json(200, {
        data: {
          app_id: user.appId ?? FAKE_APP_ID,
          is_valid: user.isValid ?? true,
          user_id: user.id,
          scopes: user.scopes,
          ...(user.granularTargets
            ? { granular_scopes: [{ scope: "ads_read", target_ids: user.granularTargets }] }
            : {}),
          ...(user.expiresAt !== undefined ? { expires_at: user.expiresAt } : {}),
          ...(user.dataAccessExpiresAt !== undefined
            ? { data_access_expires_at: user.dataAccessExpiresAt }
            : {}),
        },
      });
    }

    // --- Token-bearing reads ------------------------------------------------
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const user = userOfLong(bearer);
    if (!user) return toResponse(graphError(190, 463, 401));
    if (params.appsecret_proof !== (await appSecretProof(FAKE_APP_SECRET, bearer))) {
      return toResponse(graphError(100));
    }
    if (path === "me") return json(200, { id: user.id, name: user.name });
    if (path === "me/permissions") {
      return json(200, {
        data: [
          {
            permission: "ads_read",
            status: user.scopes.includes("ads_read") ? "granted" : "declined",
          },
          { permission: "public_profile", status: "granted" },
        ],
      });
    }
    if (!user.scopes.includes("ads_read")) return toResponse(graphError(200, undefined, 403));
    try {
      if (path === "me/adaccounts") {
        const fields = requestedFields(params, "account");
        return page(
          dataset.accounts
            .filter((a) => user.accounts.includes(a.account_id))
            .map((a) => project(a as Obj, fields)),
          params,
        );
      }
      const match = /^act_(\d+)(?:\/(campaigns|adsets|ads|adcreatives|insights))?$/.exec(path);
      if (match) {
        const accountId = match[1]!;
        const account = dataset.accounts.find((a) => a.account_id === accountId);
        if (!account || !user.accounts.includes(accountId)) {
          return toResponse(graphError(100, 33));
        }
        const edge = match[2];
        if (edge === undefined) {
          return json(200, project(account as Obj, requestedFields(params, "account")));
        }
        if (edge === "insights") return insights(accountId, params);
        return listing(edge as "campaigns" | "adsets" | "ads" | "adcreatives", accountId, params);
      }
    } catch (error) {
      if (error instanceof UnknownField) return toResponse(graphError(100));
      throw error;
    }
    return toResponse(graphError(2500));
  }

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const versionMatch = /^\/(v\d+\.0)\/(.*)$/.exec(url.pathname);
    const params = paramsObject(url.searchParams);
    const authorization = request.headers.get("authorization") ?? "";
    const formFields =
      request.method === "POST"
        ? Object.keys(paramsObject(new URLSearchParams(await request.clone().text())))
        : [];
    const entry: RequestLogEntry = {
      method: request.method,
      version: versionMatch?.[1] ?? "none",
      path: versionMatch?.[2] ?? url.pathname,
      params,
      formFields,
      auth: authorization.includes("|")
        ? "app"
        : authorization.startsWith("Bearer ")
          ? "user"
          : "none",
      hasProof: "appsecret_proof" in params,
      secretInUrl: SECRET_PARAMS.some((name) => url.searchParams.has(name)),
    };
    log.push(entry);

    for (const rule of rules) {
      if ((rule.times ?? 1) > 0 && rule.match(entry)) {
        rule.times = (rule.times ?? 1) - 1;
        if (rule.response === "network") throw new TypeError("fetch failed");
        if (rule.response === "hang") {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          });
        }
        return toResponse(rule.response);
      }
    }
    if (url.origin !== "https://graph.facebook.com" || !versionMatch) {
      return toResponse(graphError(2500, undefined, 404));
    }
    return await route(entry, request);
  };

  return {
    fetch: fakeFetch as typeof fetch,
    log,
    issueCode(user) {
      codeSeq += 1;
      const code = `test-code-${codeSeq}`;
      codes.set(code, { user: String(user), used: false });
      return code;
    },
    inject(rule) {
      rules.push(rule);
    },
    calls: () => log.length,
  };
}

/**
 * Installs a fake Graph as the runtime's global `fetch` — the only HTTP seam the
 * Meta provider has (its factories take no fetch option). Undo with
 * `vi.unstubAllGlobals()`.
 */
export function installFakeGraph(graph: FakeGraph = createFakeGraph()): FakeGraph {
  vi.stubGlobal("fetch", graph.fetch);
  return graph;
}
