#!/usr/bin/env node
// Phase 8 G1 — real Meta account spike RECORDER. Local tool: never deployed, never imported
// by production code, not a test. It issues read-only Graph API GET requests against ONE ad
// account and writes SCRUBBED recordings for the G1 evidence report
// (docs/providers/meta-g1.md). Nothing here is a mapping; it only records what Meta returns.
//
// Credentials come from the environment ONLY (never arguments, never files):
//   META_SPIKE_ACCESS_TOKEN   user token with ads_read for the app (Graph API Explorer)
//   META_SPIKE_APP_SECRET     the app secret (appsecret_proof; app token for debug_token)
//   META_SPIKE_APP_ID         the app id (numeric)
//   META_SPIKE_ACCOUNT        the ad account id to inspect (numeric, without "act_")
// Optional: META_SPIKE_VERSION (default v26.0), META_SPIKE_SINCE / META_SPIKE_UNTIL
// (YYYY-MM-DD; default the 28 days ending yesterday, UTC), META_SPIKE_DELAY_MS (default 1500),
// META_SPIKE_RESUME=1 (skip labels already recorded), META_SPIKE_OUT (output directory).
//
// Safety:
// - GET only. The token travels in the Authorization header; appsecret_proof in the query.
//   debug_token is the only call with the user token in the query (input_token); it goes to
//   Meta only and is never recorded.
// - Recordings never contain tokens, secrets, appsecret_proof, OAuth values, paging URLs,
//   cursor values, fbtrace ids, raw headers (only the allowlisted usage headers, parsed) or
//   free text (names, bodies, titles, captions: replaced by "<text len=N>"). URLs become
//   "<url>", hashes "<hash>". Every Meta id is replaced by a consistent numeric pseudonym of
//   the same length ("9000…n"), so relations between objects are kept.
// - Before anything is written, the serialized record is checked for the token, the secret,
//   the raw app and account ids, and the fixture-scrub patterns; a failing record is not
//   written (fail closed). Console output shows labels, HTTP status and row counts only.
// - On a rate-limit response the run records it and stops; rerun later with
//   META_SPIKE_RESUME=1.
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;

function fail(message) {
  console.error(`meta-g1-spike: ${message}`);
  process.exit(2);
}

if (process.argv.length > 2) fail("takes no arguments; configure it through META_SPIKE_* env");

const TOKEN = env.META_SPIKE_ACCESS_TOKEN ?? "";
const SECRET = env.META_SPIKE_APP_SECRET ?? "";
const APP_ID = env.META_SPIKE_APP_ID ?? "";
const ACCOUNT = (env.META_SPIKE_ACCOUNT ?? "").replace(/^act_/, "");
const missing = [
  ["META_SPIKE_ACCESS_TOKEN", TOKEN.length >= 20],
  ["META_SPIKE_APP_SECRET", SECRET.length >= 8],
  ["META_SPIKE_APP_ID", /^\d{5,32}$/.test(APP_ID)],
  ["META_SPIKE_ACCOUNT", /^\d{5,32}$/.test(ACCOUNT)],
]
  .filter(([, ok]) => !ok)
  .map(([name]) => name);
if (missing.length > 0) fail(`missing or invalid: ${missing.join(", ")}`);

const VERSION = env.META_SPIKE_VERSION ?? "v26.0";
if (!/^v\d{1,3}\.0$/.test(VERSION)) fail("META_SPIKE_VERSION must look like v26.0");
const OUT = resolve(ROOT, env.META_SPIKE_OUT ?? "convex/providers/meta/recordings/g1");
const DELAY_MS = Number(env.META_SPIKE_DELAY_MS ?? 1500);
const RESUME = env.META_SPIKE_RESUME === "1";
const GRAPH = `https://graph.facebook.com/${VERSION}/`;
const TIMEOUT_MS = 60_000;

const DAY = 86_400_000;
const dateKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const isDateKey = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const UNTIL = env.META_SPIKE_UNTIL ?? dateKey(Date.now() - DAY);
const SINCE = env.META_SPIKE_SINCE ?? dateKey(Date.parse(`${UNTIL}T00:00:00Z`) - 27 * DAY);
if (!isDateKey(SINCE) || !isDateKey(UNTIL)) fail("META_SPIKE_SINCE/UNTIL must be YYYY-MM-DD");
const RANGE = JSON.stringify({ since: SINCE, until: UNTIL });
const OLD_UNTIL = dateKey(Date.now() - 370 * DAY);
const OLD_SINCE = dateKey(Date.now() - 400 * DAY);
const OLD_RANGE = JSON.stringify({ since: OLD_SINCE, until: OLD_UNTIL });
const UPDATED_SINCE = Math.floor((Date.now() - 30 * DAY) / 1000);

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

const pseudonyms = new Map();
/** Same real digit string -> same pseudonym of the same length ("9" + zero-padded counter). */
function pseudo(digits) {
  let value = pseudonyms.get(digits);
  if (value === undefined) {
    const n = String(pseudonyms.size + 1);
    const width = Math.max(digits.length, n.length + 1);
    value = `9${n.padStart(width - 1, "0")}`;
    pseudonyms.set(digits, value);
  }
  return value;
}
const pseudoRuns = (text, minLength) =>
  text.replace(new RegExp(`\\d{${minLength},}`, "g"), (run) => pseudo(run));

const DROP_KEYS = new Set([
  "fbtrace_id",
  "access_token",
  "appsecret_proof",
  "input_token",
  "token",
  "client_secret",
  "code",
]);
/** Keys whose value is (or contains) a Meta object id. */
const ID_KEY =
  /(^|_)(id|ids)$|^business$|^target_ids$|^object_story_id$|^effective_object_story_id$/;
const HASH_KEY = /hash$/;
/** Keys whose string values are enum-like or dates and are kept (digit runs >= 8 pseudonymized). */
const SAFE_KEYS = new Set([
  "status",
  "configured_status",
  "effective_status",
  "objective",
  "buying_type",
  "bid_strategy",
  "billing_event",
  "optimization_goal",
  "destination_type",
  "currency",
  "account_currency",
  "timezone_name",
  "date_start",
  "date_stop",
  "created_time",
  "updated_time",
  "start_time",
  "stop_time",
  "end_time",
  "action_type",
  "action_destination",
  "action_device",
  "publisher_platform",
  "platform_position",
  "impression_device",
  "object_type",
  "call_to_action_type",
  "attribution_setting",
  "event_type",
  "type",
  "permission",
  "scope",
  "scopes",
  "special_ad_categories",
  "ads_api_access_tier",
  "window_days",
]);
/** Error text is kept (useful evidence) with ids and URLs removed. */
const ERROR_TEXT_KEYS = new Set(["message", "error_user_title", "error_user_msg"]);
const NUMERIC = /^-?\d+(\.\d+)?$/;
const URL_LIKE = /^https?:\/\//i;

function scrubString(value, key) {
  if (URL_LIKE.test(value)) return "<url>";
  if (/^[0-9a-f]{32,}$/i.test(value) || HASH_KEY.test(key)) return "<hash>";
  if (ID_KEY.test(key)) return value.replace(/\d{3,}/g, (run) => pseudo(run));
  if (/^act_\d+$/.test(value)) return `act_${pseudo(value.slice(4))}`;
  if (ERROR_TEXT_KEYS.has(key)) {
    return pseudoRuns(value.replace(/https?:\/\/\S+/gi, "<url>"), 6).replace(
      /[0-9a-f]{32,}/gi,
      "<hash>",
    );
  }
  if (SAFE_KEYS.has(key)) return pseudoRuns(value.replace(/https?:\/\/\S+/gi, "<url>"), 8);
  if (NUMERIC.test(value)) {
    return value.split(".")[0].replace("-", "").length >= 12 ? pseudoRuns(value, 12) : value;
  }
  return `<text len=${value.length}>`;
}

function describeUrl(url) {
  try {
    const parsed = new URL(url);
    const names = [...new Set([...parsed.searchParams.keys()])].sort();
    const embedsToken = names.includes("access_token");
    return `<paging url; embeds access token: ${embedsToken ? "yes" : "no"}; params: ${names
      .filter((n) => n !== "access_token")
      .join(",")}>`;
  } catch {
    return "<paging url>";
  }
}

function scrub(value, key = "") {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return ID_KEY.test(key) && Number.isInteger(value) && String(value).length >= 5
      ? Number(pseudo(String(value)))
      : value;
  }
  if (typeof value === "string") return scrubString(value, key);
  if (Array.isArray(value)) return value.map((item) => scrub(item, key));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP_KEYS.has(k) && !(k === "code" && typeof v === "number")) continue;
      const outKey = /^\d{5,}$/.test(k)
        ? pseudo(k)
        : /^act_\d+$/.test(k)
          ? `act_${pseudo(k.slice(4))}`
          : k;
      if (k === "paging" && v && typeof v === "object") {
        out.paging = {
          ...(v.cursors
            ? {
                cursors: Object.fromEntries(
                  Object.entries(v.cursors).map(([ck, cv]) => [
                    ck,
                    `<cursor len=${String(cv).length}>`,
                  ]),
                ),
              }
            : {}),
          ...(v.next ? { next: describeUrl(v.next) } : {}),
          ...(v.previous ? { previous: describeUrl(v.previous) } : {}),
        };
        continue;
      }
      out[outKey] = scrub(v, k);
    }
    return out;
  }
  return `<${typeof value}>`;
}

const USAGE_HEADERS = [
  "x-business-use-case-usage",
  "x-ad-account-usage",
  "x-app-usage",
  "x-fb-ads-insights-throttle",
  "retry-after",
];
function usageHeaders(headers) {
  const out = {};
  for (const name of USAGE_HEADERS) {
    const raw = headers.get(name);
    if (raw === null) continue;
    try {
      out[name] = scrub(JSON.parse(raw), name);
    } catch {
      out[name] = NUMERIC.test(raw) ? raw : `<text len=${raw.length}>`;
    }
  }
  return out;
}

const FORBIDDEN = [
  ["graph token", /EAA[A-Za-z0-9]{20,}/],
  ["token parameter", /access_token=/],
  ["32-hex", /\b[0-9a-f]{32}\b/i],
  ["trace id", /fbtrace_id/],
];
const exact = (digits) => new RegExp(`(?<!\\d)${digits}(?!\\d)`);
function assertClean(text) {
  const problems = FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  if (text.includes(TOKEN)) problems.push("access token");
  if (text.includes(SECRET)) problems.push("app secret");
  if (exact(APP_ID).test(text)) problems.push("raw app id");
  if (exact(ACCOUNT).test(text)) problems.push("raw account id");
  return problems;
}

// ---------------------------------------------------------------------------
// Graph (GET only)
// ---------------------------------------------------------------------------

const proof = createHmac("sha256", SECRET).update(TOKEN).digest("hex");
const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 368, 613]);
const isRateLimited = (status, code) =>
  status === 429 || RATE_LIMIT_CODES.has(code) || (code >= 80_000 && code <= 80_014);

async function graphGet(path, params, auth) {
  const url = new URL(path, GRAPH);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const headers = { Accept: "application/json" };
  if (auth === "app") {
    headers.Authorization = `Bearer ${APP_ID}|${SECRET}`;
  } else {
    headers.Authorization = `Bearer ${TOKEN}`;
    url.searchParams.set("appsecret_proof", proof);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { "<non-json>": `<text len=${text.length}>` };
    }
    return { status: response.status, headers: response.headers, body, ms: Date.now() - started };
  } catch (error) {
    return {
      status: 0,
      headers: new Headers(),
      body: { "<transport>": error?.name === "AbortError" ? "timeout" : "network" },
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Plan (G1 items in docs/providers/meta-g1.md)
// ---------------------------------------------------------------------------

const act = `act_${ACCOUNT}`;
const ACCOUNT_FIELDS =
  "id,account_id,name,currency,timezone_name,account_status,disable_reason,business{id}";
const ACCOUNT_EXTRA =
  "timezone_offset_hours_utc,timezone_id,amount_spent,spend_cap,min_daily_budget";
const CAMPAIGN_FIELDS =
  "id,name,status,configured_status,effective_status,objective,buying_type,bid_strategy," +
  "daily_budget,lifetime_budget,budget_remaining,spend_cap,start_time,stop_time,created_time," +
  "updated_time,special_ad_categories";
const ADSET_FIELDS =
  "id,name,campaign_id,status,configured_status,effective_status,daily_budget,lifetime_budget," +
  "budget_remaining,billing_event,optimization_goal,bid_strategy,destination_type," +
  "attribution_spec,start_time,end_time,created_time,updated_time";
const AD_FIELDS =
  "id,name,campaign_id,adset_id,status,configured_status,effective_status,creative{id}," +
  "created_time,updated_time";
const CREATIVE_FIELDS =
  "id,name,status,object_type,title,body,thumbnail_url,image_url,image_hash,video_id," +
  "object_story_id,effective_object_story_id,effective_instagram_media_id," +
  "instagram_permalink_url,call_to_action_type";
const MIN_FIELDS = "id,status,effective_status";
const ALL_STATUSES = JSON.stringify([
  "ACTIVE",
  "PAUSED",
  "DELETED",
  "ARCHIVED",
  "IN_PROCESS",
  "WITH_ISSUES",
  "CAMPAIGN_PAUSED",
  "ADSET_PAUSED",
  "PENDING_REVIEW",
  "DISAPPROVED",
  "PREAPPROVED",
  "PENDING_BILLING_INFO",
]);
const CORE =
  "date_start,date_stop,account_currency,spend,impressions,reach,frequency,clicks," +
  "inline_link_clicks,unique_clicks,ctr,cpm,cpc";
const VIDEO =
  "date_start,date_stop,video_play_actions,video_p25_watched_actions,video_p50_watched_actions," +
  "video_p75_watched_actions,video_p100_watched_actions,video_thruplay_watched_actions," +
  "video_30_sec_watched_actions";
const ENGAGEMENT = "date_start,date_stop,inline_post_engagement,outbound_clicks";
const ACTIONS = "date_start,date_stop,actions,action_values";
const daily = (level, fields, extra = {}) => ({
  level,
  fields,
  time_range: RANGE,
  time_increment: "1",
  ...extra,
});
const filterStatuses = (field) =>
  JSON.stringify([{ field, operator: "IN", value: JSON.parse(ALL_STATUSES) }]);

const PLAN = [
  // 1–2: identity, permissions, token facts, discovery
  { label: "01-me", items: [1, 2], path: "me", params: { fields: "id" } },
  { label: "02-me-permissions", items: [1], path: "me/permissions", params: {} },
  {
    label: "03-debug-token",
    items: [1],
    path: "debug_token",
    params: { input_token: TOKEN },
    auth: "app",
  },
  {
    label: "04-adaccounts-limit1",
    items: [1, 10],
    path: "me/adaccounts",
    params: { fields: ACCOUNT_FIELDS, limit: "1" },
    follow: 3,
  },
  {
    label: "05-adaccounts-default",
    items: [1, 11],
    path: "me/adaccounts",
    params: { fields: ACCOUNT_FIELDS },
  },
  // 2–4: the account
  { label: "06-account", items: [2, 3, 4], path: act, params: { fields: ACCOUNT_FIELDS } },
  { label: "07-account-extra", items: [3, 4], path: act, params: { fields: ACCOUNT_EXTRA } },
  // 5–7, 10, 11, 22: structure listings
  {
    label: "10-campaigns-default",
    items: [5, 22],
    path: `${act}/campaigns`,
    params: { fields: CAMPAIGN_FIELDS, limit: "100" },
    follow: 5,
    fallback: MIN_FIELDS,
  },
  {
    label: "11-campaigns-effective-status-param",
    items: [5, 22],
    path: `${act}/campaigns`,
    params: { fields: MIN_FIELDS, effective_status: ALL_STATUSES, limit: "100" },
    follow: 5,
  },
  {
    label: "12-campaigns-filtering-status",
    items: [5, 22],
    path: `${act}/campaigns`,
    params: { fields: MIN_FIELDS, filtering: filterStatuses("effective_status"), limit: "100" },
    follow: 5,
  },
  {
    label: "13-campaigns-updated-since",
    items: [5],
    path: `${act}/campaigns`,
    params: {
      fields: "id,updated_time",
      filtering: JSON.stringify([
        { field: "updated_time", operator: "GREATER_THAN", value: UPDATED_SINCE },
      ]),
      limit: "100",
    },
  },
  {
    label: "14-campaigns-limit1",
    items: [10],
    path: `${act}/campaigns`,
    params: { fields: "id", limit: "1" },
    follow: 2,
  },
  {
    label: "15-campaigns-limit5000",
    items: [11],
    path: `${act}/campaigns`,
    params: { fields: "id", limit: "5000" },
  },
  {
    label: "20-adsets-default",
    items: [6, 22],
    path: `${act}/adsets`,
    params: { fields: ADSET_FIELDS, limit: "100" },
    follow: 5,
    fallback: `${MIN_FIELDS},campaign_id`,
  },
  {
    label: "21-adsets-all-statuses",
    items: [6, 22],
    path: `${act}/adsets`,
    params: { fields: `${MIN_FIELDS},campaign_id`, effective_status: ALL_STATUSES, limit: "100" },
    follow: 5,
  },
  {
    label: "30-ads-default",
    items: [7, 22],
    path: `${act}/ads`,
    params: { fields: AD_FIELDS, limit: "100" },
    follow: 5,
    fallback: `${MIN_FIELDS},adset_id,campaign_id`,
  },
  {
    label: "31-ads-all-statuses",
    items: [7, 22],
    path: `${act}/ads`,
    params: {
      fields: `${MIN_FIELDS},adset_id,campaign_id,creative{id}`,
      effective_status: ALL_STATUSES,
      limit: "100",
    },
    follow: 5,
  },
  {
    label: "32-ads-limit1000",
    items: [11],
    path: `${act}/ads`,
    params: { fields: "id", limit: "1000" },
  },
  // 8, 23: creatives
  {
    label: "40-adcreatives",
    items: [8, 23],
    path: `${act}/adcreatives`,
    params: { fields: CREATIVE_FIELDS, limit: "50" },
    follow: 2,
    fallback: "id,status,object_type",
  },
  {
    label: "41-ads-nested-creative",
    items: [8, 23],
    path: `${act}/ads`,
    params: {
      fields:
        "id,effective_status,creative{id,object_type,thumbnail_url,effective_object_story_id}",
      effective_status: ALL_STATUSES,
      limit: "50",
    },
  },
  // 9, 13–15: insights, account level
  {
    label: "50-insights-account-daily-core",
    items: [9, 13, 14, 15],
    path: `${act}/insights`,
    params: daily("account", CORE),
  },
  {
    label: "51-insights-account-total-core",
    items: [13, 15],
    path: `${act}/insights`,
    params: { level: "account", fields: CORE, time_range: RANGE },
  },
  {
    label: "52-insights-account-daily-video",
    items: [13, 14],
    path: `${act}/insights`,
    params: daily("account", VIDEO),
  },
  {
    label: "53-insights-account-daily-engagement",
    items: [13, 14],
    path: `${act}/insights`,
    params: daily("account", ENGAGEMENT),
  },
  // 17–21: conversions, actions, attribution
  {
    label: "54-insights-actions-default",
    items: [17, 18, 19, 20],
    path: `${act}/insights`,
    params: daily("account", ACTIONS),
  },
  {
    label: "55-insights-conversions-fields",
    items: [17, 18],
    path: `${act}/insights`,
    params: daily(
      "account",
      "date_start,date_stop,conversions,conversion_values,cost_per_conversion",
    ),
  },
  {
    label: "56-insights-roas",
    items: [18],
    path: `${act}/insights`,
    params: daily("account", "date_start,date_stop,purchase_roas,website_purchase_roas"),
  },
  {
    label: "57-insights-results",
    items: [17],
    path: `${act}/insights`,
    params: daily("account", "date_start,date_stop,results,cost_per_result"),
  },
  {
    label: "58-insights-windows-current",
    items: [20, 21],
    path: `${act}/insights`,
    params: daily("account", ACTIONS, {
      action_attribution_windows: JSON.stringify(["1d_click", "7d_click", "1d_view"]),
    }),
  },
  {
    label: "59-insights-windows-legacy",
    items: [20, 21],
    path: `${act}/insights`,
    params: daily("account", ACTIONS, {
      action_attribution_windows: JSON.stringify(["28d_click", "7d_view", "28d_view"]),
    }),
  },
  {
    label: "60-insights-unified-attribution",
    items: [20, 21],
    path: `${act}/insights`,
    params: daily("account", ACTIONS, { use_unified_attribution_setting: "true" }),
  },
  {
    label: "61-insights-report-time-impression",
    items: [20, 21],
    path: `${act}/insights`,
    params: daily("account", ACTIONS, { action_report_time: "impression" }),
  },
  {
    label: "62-insights-report-time-conversion",
    items: [20, 21],
    path: `${act}/insights`,
    params: daily("account", ACTIONS, { action_report_time: "conversion" }),
  },
  {
    label: "63-insights-report-time-mixed",
    items: [20, 21],
    path: `${act}/insights`,
    params: daily("account", ACTIONS, { action_report_time: "mixed" }),
  },
  {
    label: "64-insights-action-destination",
    items: [19],
    path: `${act}/insights`,
    params: daily("account", ACTIONS, {
      action_breakdowns: JSON.stringify(["action_type", "action_destination"]),
    }),
  },
  {
    label: "65-insights-adset-attribution-setting",
    items: [20, 21],
    path: `${act}/insights`,
    params: {
      level: "adset",
      fields: "adset_id,campaign_id,attribution_setting,optimization_goal,spend",
      time_range: RANGE,
      limit: "100",
    },
    follow: 3,
  },
  // 16: placement
  {
    label: "70-insights-placement-daily",
    items: [16, 15],
    path: `${act}/insights`,
    params: daily("account", CORE, { breakdowns: "publisher_platform" }),
  },
  {
    label: "71-insights-placement-position",
    items: [16],
    path: `${act}/insights`,
    params: {
      level: "account",
      fields: "spend,impressions,reach,clicks",
      time_range: RANGE,
      breakdowns: "publisher_platform,platform_position",
    },
  },
  {
    label: "72-insights-placement-campaign-daily",
    items: [16],
    path: `${act}/insights`,
    params: daily("campaign", `campaign_id,${CORE}`, {
      breakdowns: "publisher_platform",
      limit: "500",
    }),
    follow: 5,
  },
  {
    label: "73-insights-placement-actions",
    items: [16, 19],
    path: `${act}/insights`,
    params: daily("account", ACTIONS, { breakdowns: "publisher_platform" }),
  },
  // 13, 14, 22: levels, zero days, deleted/archived objects in insights
  {
    label: "80-insights-campaign-daily",
    items: [13, 14, 22],
    path: `${act}/insights`,
    params: daily("campaign", `campaign_id,${CORE}`, { limit: "500" }),
    follow: 5,
  },
  {
    label: "81-insights-adset-daily",
    items: [13, 14],
    path: `${act}/insights`,
    params: daily("adset", `adset_id,campaign_id,${CORE}`, { limit: "500" }),
    follow: 5,
  },
  {
    label: "82-insights-ad-daily",
    items: [13, 14, 22],
    path: `${act}/insights`,
    params: daily("ad", `ad_id,adset_id,campaign_id,${CORE}`, { limit: "500" }),
    follow: 5,
  },
  {
    label: "83-insights-ad-daily-all-statuses",
    items: [22],
    path: `${act}/insights`,
    params: daily("ad", "ad_id,spend,impressions", {
      filtering: filterStatuses("ad.effective_status"),
      limit: "500",
    }),
    follow: 5,
  },
  // 10, 11: insights paging and page size
  {
    label: "84-insights-limit1",
    items: [10, 11],
    path: `${act}/insights`,
    params: daily("account", "date_start,spend", { limit: "1" }),
    follow: 2,
  },
  {
    label: "85-insights-limit5000",
    items: [11],
    path: `${act}/insights`,
    params: daily("ad", "ad_id,spend", { limit: "5000" }),
  },
  // 15: reach beyond ~13 months
  {
    label: "90-insights-reach-old-range",
    items: [15],
    path: `${act}/insights`,
    params: {
      level: "account",
      fields: "date_start,date_stop,impressions,reach",
      time_range: OLD_RANGE,
    },
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function redactParams(params) {
  const out = {};
  for (const [name, value] of Object.entries(params)) {
    if (DROP_KEYS.has(name)) continue;
    if (name === "after" || name === "before") {
      out[name] = `<cursor len=${String(value).length}>`;
      continue;
    }
    out[name] = pseudoRuns(
      String(value).replace(/act_\d+/g, (a) => `act_${pseudo(a.slice(4))}`),
      12,
    );
  }
  return out;
}

async function record(file, content) {
  const text = `${JSON.stringify(content, null, 2)}\n`;
  const problems = assertClean(text);
  if (problems.length > 0) {
    console.error(`  NOT WRITTEN (${file}): scrub check failed: ${problems.join(", ")}`);
    return false;
  }
  await writeFile(join(OUT, file), text, "utf8");
  return true;
}

function summarize(body) {
  if (Array.isArray(body?.data))
    return `${body.data.length} rows${body.paging?.cursors?.after ? ", has after" : ""}${body.paging?.next ? ", has next" : ""}`;
  if (body?.error)
    return `error ${body.error.code}${body.error.error_subcode ? `/${body.error.error_subcode}` : ""}`;
  return "object";
}

/** Records one request (and its follow-up pages); returns false when throttled. */
async function runStep(step, label, fields) {
  let params = fields ? { ...step.params, fields } : { ...step.params };
  for (let page = 1; page <= (step.follow ?? 1); page++) {
    const file = `${label}${page > 1 ? `-p${page}` : ""}.json`;
    if (RESUME && existsSync(join(OUT, file))) {
      console.log(`${file}: skipped (exists)`);
      return "ok";
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const result = await graphGet(step.path, params, step.auth);
    const code = result.body?.error?.code;
    let body = result.body;
    if (step.path === "debug_token" && body?.data) {
      const {
        app_id: appId,
        expires_at: exp,
        data_access_expires_at: dataExp,
        issued_at: iat,
        ...rest
      } = body.data;
      body = {
        data: {
          ...rest,
          app_id_matches_configured_app: String(appId) === APP_ID,
          expires_in_seconds: exp === 0 ? 0 : exp - nowSec,
          data_access_expires_in_seconds: dataExp === 0 ? 0 : dataExp - nowSec,
          ...(iat ? { issued_seconds_ago: nowSec - iat } : {}),
        },
      };
    }
    const written = await record(file, {
      label,
      g1Items: step.items,
      page,
      ...(fields ? { fallbackFields: true } : {}),
      request: {
        method: "GET",
        version: VERSION,
        path: step.path.replace(/act_\d+/, (a) => `act_${pseudo(a.slice(4))}`),
        params: redactParams(params),
        auth: step.auth === "app" ? "app token (header)" : "user token (header) + appsecret_proof",
      },
      response: {
        status: result.status,
        durationMs: result.ms,
        usageHeaders: usageHeaders(result.headers),
        body: scrub(body),
      },
    });
    const summary = summarize(result.body);
    console.log(`${file}: HTTP ${result.status}, ${summary}${written ? "" : " (not written)"}`);
    index.push({ file, items: step.items, status: result.status, summary, written });

    if (isRateLimited(result.status, code)) return "throttled";
    if (code === 100 && page === 1) return "invalid_fields";
    const after = result.body?.paging?.cursors?.after;
    if (!after || !result.body?.paging?.next) return "ok";
    params = { ...params, after };
    await sleep(DELAY_MS);
  }
  return "ok";
}

await mkdir(OUT, { recursive: true });
const index = [];
let throttled = false;

for (const step of PLAN) {
  let outcome = await runStep(step, step.label);
  if (outcome === "invalid_fields" && step.fallback) {
    // Some requested field is not valid for this edge/version: record that, then retry
    // page 1 with minimal fields so the listing itself is still observed ("-min").
    await sleep(DELAY_MS);
    outcome = await runStep(step, `${step.label}-min`, step.fallback);
  }
  if (outcome === "throttled") {
    throttled = true;
    console.log("Rate limited: stopping. Rerun later with META_SPIKE_RESUME=1.");
    break;
  }
  await sleep(DELAY_MS);
}

await record("index.json", {
  spike: "Phase 8 G1",
  version: VERSION,
  range: { since: SINCE, until: UNTIL },
  oldReachRange: { since: OLD_SINCE, until: OLD_UNTIL },
  recordedOn: dateKey(Date.now()),
  throttled,
  requests: index,
  note: "Ids are consistent pseudonyms; free text, URLs, cursors and hashes are redacted.",
});
console.log(`Done: ${index.filter((r) => r.written).length} recordings in ${OUT}`);
