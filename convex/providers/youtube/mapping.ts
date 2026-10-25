import { compareDateKeys, eachDay, isDateKey, toDateKey, type DateKey } from "../../lib/dates";
import type {
  ProviderSocialAccount,
  ProviderSocialAccountDay,
  ProviderSocialPost,
  ProviderSocialPostSnapshot,
} from "../social/types";
import type { ProviderOperation } from "../types";
import { youtubeError } from "./errors";
import type { RawChannel, RawReport, RawVideo } from "./schemas";
import { parseCount } from "./schemas";
import {
  ACCOUNT_REPORT_TARGETS,
  CHANNEL_ACCOUNT_TYPE,
  EXCLUDED_BROADCAST_CONTENT,
  HANDLE,
  HANDLE_PREFIX,
  PUBLISHED_BROADCAST_CONTENT,
  REPORT_DIMENSION,
  TITLE_MAX_CHARS,
  VIDEO_POST_TYPE,
  VIDEO_STATISTICS_COLUMNS,
  youtubePermalink,
} from "./semantics";

/**
 * Pure YouTube -> canonical record mapping (ADR 0016), driven by ./semantics.ts. Inputs are
 * shape-checked raw API resources (./schemas.ts); outputs are provider records the caller
 * validates at the boundary. Rules:
 * - a missing value stays ABSENT; an explicit 0 stays 0; nothing is ever zero-filled;
 * - values are stored as YouTube reports them; nothing is calculated (Policies III.E.4.h);
 * - the built permalink is the only URL that survives; thumbnails never do;
 * - "upcoming" broadcasts are excluded; a video without a usable publish time, broadcast state
 *   or owner is unresolved — neither is ever emitted as a post.
 */

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/**
 * [doc] Data API times are ISO 8601 in UTC ("2026-09-28T12:00:00Z"). Parsed explicitly; any
 * other shape (including an offset) is undefined. [PROVISIONAL YR8] the exact format.
 */
export function parseYouTubeTimestamp(raw: string | undefined): number | undefined {
  const match = raw === undefined ? null : TIMESTAMP.exec(raw);
  if (match === null) return undefined;
  const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const base = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(base);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    h > 23 ||
    mi > 59 ||
    s > 59
  ) {
    return undefined;
  }
  const fraction = match[7];
  const instant = base + (fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1000));
  return instant > 0 && Number.isSafeInteger(instant) ? instant : undefined;
}

/** At most TITLE_MAX_CHARS characters (code points, never a split surrogate pair). */
export function capTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  const chars = Array.from(trimmed);
  return chars.length <= TITLE_MAX_CHARS ? trimmed : chars.slice(0, TITLE_MAX_CHARS).join("");
}

/** The handle without its "@" when `customUrl` is a handle; anything else is undefined. */
export function handleOf(customUrl: string | undefined): string | undefined {
  if (customUrl === undefined || !customUrl.startsWith(HANDLE_PREFIX)) return undefined;
  const handle = customUrl.slice(HANDLE_PREFIX.length);
  return HANDLE.test(handle) ? handle : undefined;
}

/**
 * The preflight record of one channel: the title (falling back to the handle, then the id),
 * the handle as username, and the (rounded) subscriber count unless hidden. No URL (no
 * thumbnails, no custom URL beyond the handle).
 */
export function mapChannel(raw: RawChannel): ProviderSocialAccount {
  const username = handleOf(raw.snippet?.customUrl);
  const name = capTitle(raw.snippet?.title) ?? username ?? raw.id;
  const followersCount =
    raw.statistics?.hiddenSubscriberCount === true
      ? undefined
      : parseCount(raw.statistics?.subscriberCount);
  return {
    platform: "youtube",
    externalId: raw.id,
    ...(username !== undefined ? { username } : {}),
    name,
    accountType: CHANNEL_ACCOUNT_TYPE,
    ...(followersCount !== undefined ? { followersCount } : {}),
    status: "active",
  };
}

export type MappedVideo =
  { kind: "post"; record: ProviderSocialPost } | { kind: "excluded" } | { kind: "unresolved" };

/** One upload of `channelId` as a post, or why it is not one. */
export function mapVideo(raw: RawVideo, channelId: string): MappedVideo {
  const snippet = raw.snippet;
  if (snippet === undefined || snippet.channelId !== channelId) return { kind: "unresolved" };
  const broadcast = snippet.liveBroadcastContent;
  if (broadcast !== undefined && EXCLUDED_BROADCAST_CONTENT.has(broadcast)) {
    return { kind: "excluded" };
  }
  if (broadcast === undefined || !PUBLISHED_BROADCAST_CONTENT.has(broadcast)) {
    return { kind: "unresolved" };
  }
  const publishedAt = parseYouTubeTimestamp(snippet.publishedAt);
  if (publishedAt === undefined) return { kind: "unresolved" };
  const caption = capTitle(snippet.title);
  return {
    kind: "post",
    record: {
      platform: "youtube",
      accountExternalId: channelId,
      externalId: raw.id,
      type: VIDEO_POST_TYPE,
      publishedAt,
      ...(caption !== undefined ? { caption } : {}),
      permalink: youtubePermalink(raw.id),
    },
  };
}

// ---------------------------------------------------------------------------
// Video lifetime snapshot (Checkpoint 3)
// ---------------------------------------------------------------------------

/**
 * The lifetime statistics of one video, captured at `capturedAt` (UTC capture day). A hidden
 * or disabled count is absent from the API and stays absent; a malformed one fails closed.
 */
export function mapVideoSnapshot(input: {
  operation: ProviderOperation;
  accountExternalId: string;
  video: RawVideo;
  capturedAt: number;
}): ProviderSocialPostSnapshot {
  const metrics: Record<string, number> = {};
  const statistics: Readonly<Record<string, string | number | undefined>> =
    input.video.statistics ?? {};
  for (const [name, column] of Object.entries(VIDEO_STATISTICS_COLUMNS)) {
    const raw = statistics[name];
    if (raw === undefined) continue;
    const value = parseCount(raw);
    if (value === undefined) {
      throw youtubeError("data", input.operation, "metric_invalid", "Unexpected YouTube statistic");
    }
    metrics[column] = value;
  }
  return {
    platform: "youtube",
    accountExternalId: input.accountExternalId,
    postExternalId: input.video.id,
    capturedDate: toDateKey(input.capturedAt, "UTC"),
    capturedAt: input.capturedAt,
    ...metrics,
  };
}

// ---------------------------------------------------------------------------
// Channel day report (Checkpoint 3)
// ---------------------------------------------------------------------------

type ReportTarget = { column: string } | { extra: string };

/**
 * One record for EVERY requested day [from, to] (YouTube's Pacific Time day keys, unchanged),
 * also when YouTube returned no row for it: a synced day without values is "not reported",
 * never zero. The table must be exactly what was requested: the `day` dimension plus known
 * metrics (a requested metric YouTube left out is absent on every day); an unknown column, a
 * duplicate or out-of-window day, a row of the wrong width or a value that is not a
 * non-negative integer fails closed as a "data" error.
 */
export function mapReportDays(input: {
  operation: ProviderOperation;
  accountExternalId: string;
  from: DateKey;
  to: DateKey;
  report: RawReport;
}): ProviderSocialAccountDay[] {
  const fail = (code: string) =>
    youtubeError("data", input.operation, code, "Unexpected YouTube report");
  const targets = ACCOUNT_REPORT_TARGETS as Readonly<Record<string, ReportTarget>>;
  const headers = input.report.columnHeaders;
  const names = headers.map((header) => header.name);
  if (new Set(names).size !== names.length) throw fail("report_unexpected");
  const dayIndex = names.indexOf(REPORT_DIMENSION);
  if (dayIndex < 0) throw fail("report_unexpected");
  headers.forEach((header, index) => {
    const expected = index === dayIndex ? "DIMENSION" : "METRIC";
    if (header.columnType !== undefined && header.columnType !== expected) {
      throw fail("report_unexpected");
    }
    if (index !== dayIndex && targets[header.name] === undefined) throw fail("metric_unexpected");
  });

  const byDay = new Map<DateKey, Record<string, number>>();
  for (const row of input.report.rows ?? []) {
    if (row.length !== names.length) throw fail("report_unexpected");
    const day: unknown = row[dayIndex];
    if (
      !isDateKey(day) ||
      compareDateKeys(day, input.from) < 0 ||
      compareDateKeys(day, input.to) > 0 ||
      byDay.has(day)
    ) {
      throw fail("day_unexpected");
    }
    const values: Record<string, number> = {};
    row.forEach((cell: unknown, index) => {
      if (index === dayIndex || cell === null || cell === undefined) return;
      if (typeof cell !== "number" || !Number.isSafeInteger(cell) || cell < 0) {
        throw fail("metric_invalid");
      }
      values[names[index]!] = cell;
    });
    byDay.set(day, values);
  }

  return eachDay(input.from, input.to).map((date) => {
    const columns: Record<string, number> = {};
    const extras: Record<string, number> = {};
    for (const [name, value] of Object.entries(byDay.get(date) ?? {})) {
      const target = targets[name]!;
      if ("column" in target) columns[target.column] = value;
      else extras[target.extra] = value;
    }
    return {
      platform: "youtube",
      accountExternalId: input.accountExternalId,
      date,
      ...columns,
      ...(Object.keys(extras).length > 0 ? { extras } : {}),
    };
  });
}
