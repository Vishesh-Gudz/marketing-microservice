import { diffDays, isDateKey } from "../../lib/dates";
import { assertCapability } from "../capabilities";
import { ProviderError, toProviderError } from "../errors";
import { fingerprint } from "../hash";
import { clampPageSize } from "../pagination";
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
import { META_CAPABILITIES } from "./capabilities";
import { createGraphClient, type GraphClient, type GraphFailure } from "./client";
import {
  isValidMetaAppId,
  isValidMetaSecret,
  META_CONFIG_INVALID,
  metaProviderId,
  resolveMetaVersion,
  SYNC_TIMEOUT_MS,
  OAUTH_TIMEOUT_MS,
} from "./config";
import { isMetaCredential, type MetaCredential } from "./credential";
import { addToCarry, decodeCarry, encodeCarry, takeFromCarry, type Carry } from "./carry";
import {
  CursorTooLargeError,
  decodeMetaCursorPosition,
  encodeMetaCursor,
  encodeMetaPosition,
  type MetaCursorPosition,
} from "./cursor";
import { classifyGraphFailure, metaError, metaProviderError } from "./errors";
import {
  META_MAPPING,
  META_MAPPING_PENDING,
  type MetaEntityMapping,
  type MetaInsightsMapping,
  type MetaRequestPlan,
} from "./mapping";
import { ACCOUNT_FIELDS, normalizeAdAccount, type MetaAccountInfo } from "./normalize";
import { pagedEnvelope, parseRaw, rawAccountInfo, rawAdAccount, rawPermissions } from "./schemas";

export { META_CAPABILITIES } from "./capabilities";
export { META_API_VERSION } from "./config";
export type { MetaCredential } from "./credential";

export type MetaProviderOptions = {
  /** META_GRAPH_API_VERSION override (validated); defaults to the pinned version. */
  version?: string;
  /** META_APP_ID (numeric). Missing/invalid → every call fails "unknown" (never "auth"). */
  appId?: string;
  /** META_APP_SECRET (appsecret_proof key). Missing/invalid → "unknown". */
  appSecret?: string;
  timeoutMs?: number;
  /** Discovery (listAccounts) runs inside the OAuth callback: shorter timeout. */
  discoveryTimeoutMs?: number;
};

type Session = { accessToken: string; appSecret: string; client: GraphClient };

const ACCOUNT_ID = /^\d{1,32}$/;
/** D23: from the 3rd attempt of a page, request smaller pages (never below this). */
const SHRUNK_PAGE_FLOOR = 50;

/**
 * Real Meta Ads provider (Phase 8). Implements the AdsProvider contract end to end:
 * ad account discovery and the sync preflight (D10), and structure and insights through
 * META_MAPPING (mapping.ts). Operations without a mapping entry fail closed. Pure,
 * tenant-free, database-free.
 *
 * Options are deployment configuration only (the registry passes them from the
 * Convex env). There is no test injection path: the mapping is the module's
 * META_MAPPING and HTTP goes through the runtime's global `fetch`. Tests stub
 * that global (the fake Graph), never the factory.
 */
export function createMetaAdsProvider(
  options: MetaProviderOptions = {},
): AdsProvider<MetaCredential> {
  const caps = META_CAPABILITIES;
  const version = resolveMetaVersion(options.version);
  const mapping = META_MAPPING;
  const syncClient = createGraphClient({
    version: version.version,
    timeoutMs: options.timeoutMs ?? SYNC_TIMEOUT_MS,
  });
  const discoveryClient = createGraphClient({
    version: version.version,
    timeoutMs: options.discoveryTimeoutMs ?? OAUTH_TIMEOUT_MS,
  });

  /** Config + credential checks. Config problems → "unknown"; credential problems → "auth". */
  function session(
    ctx: ProviderContext<MetaCredential>,
    operation: ProviderOperation,
    client: GraphClient,
  ): Session {
    if (
      !version.valid ||
      !isValidMetaAppId(options.appId) ||
      !isValidMetaSecret(options.appSecret)
    ) {
      throw metaError(
        "unknown",
        operation,
        META_CONFIG_INVALID,
        "Meta app configuration is missing or invalid",
      );
    }
    const credential: unknown = ctx.credential;
    if (!isMetaCredential(credential)) {
      throw metaError(
        "auth",
        operation,
        "credential_invalid",
        "Stored credential is not a Meta credential",
      );
    }
    if (credential.appId !== options.appId) {
      throw metaError(
        "auth",
        operation,
        "app_id_mismatch",
        "Credential belongs to a different Meta app",
      );
    }
    return { accessToken: credential.accessToken, appSecret: options.appSecret, client };
  }

  async function run<T>(operation: ProviderOperation, body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      throw toProviderError(error, "meta", operation);
    }
  }

  /** 10/200-299/3/403: auth when ads_read is gone token-wide, else permission (D22). */
  async function failureError(
    failure: GraphFailure,
    operation: ProviderOperation,
    s: Session,
  ): Promise<ProviderError> {
    const classification = classifyGraphFailure(failure);
    if (!classification.permissionCheck) return metaProviderError(classification, operation);
    const probe = await s.client.get("me/permissions", {}, s);
    if (probe.ok) {
      try {
        const permissions = parseRaw(rawPermissions, probe.body, operation, "permissions");
        const granted = permissions.data.some(
          (p) => p.permission === "ads_read" && p.status === "granted",
        );
        if (!granted) return metaProviderError({ ...classification, kind: "auth" }, operation);
      } catch {
        // Unreadable probe: keep "permission" (never escalate to reauth on doubt).
      }
    }
    return metaProviderError({ ...classification, kind: "permission" }, operation);
  }

  function pending(operation: ProviderOperation): never {
    throw metaError(
      "unknown",
      operation,
      META_MAPPING_PENDING,
      "Meta structure/metric mapping is not available",
    );
  }

  function invalidCursor(operation: ProviderOperation): ProviderError {
    return metaError(
      "invalid_request",
      operation,
      "cursor_invalid",
      "Cursor is malformed or belongs to a different request.",
    );
  }

  /** A listing cursor: stage 0, no flush, no carry. */
  function isPlainPosition(position: MetaCursorPosition): boolean {
    return (
      position.stage === 0 &&
      position.flush === undefined &&
      position.carry === undefined &&
      position.rows === undefined
    );
  }

  function assertAccountId(value: string, operation: ProviderOperation) {
    if (!ACCOUNT_ID.test(value)) {
      throw metaError("invalid_request", operation, "account_id", "Ad account id must be numeric");
    }
  }

  function normalizeOne<K extends ProviderRecordKind>(
    kind: K,
    operation: ProviderOperation,
    produce: () => ProviderRecordByKind[K],
  ): ProviderRecordByKind[K] {
    let record: ProviderRecordByKind[K];
    try {
      record = produce();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw metaError("data", operation, "normalize", `Could not normalize a Meta ${kind}`);
    }
    assertValidRecord(kind, record, "meta", operation);
    return record;
  }

  /** Page size for this attempt: clamped, and shrunk from the 3rd attempt of a page (D23). */
  function pageLimit(request: PageRequest, attempt: number): number {
    const limit = clampPageSize(request.pageSize, caps.defaultPageSize, caps.maxPageSize);
    if (attempt < 3) return limit;
    return Math.max(Math.min(limit, SHRUNK_PAGE_FLOOR), Math.floor(limit / 2 ** (attempt - 2)));
  }

  /** One Graph page: GET, envelope validation, Meta's next `after` (never follows paging.next). */
  async function fetchPage(
    operation: ProviderOperation,
    s: Session,
    plan: MetaRequestPlan,
    limit: number,
    after: string | undefined,
  ): Promise<{ data: unknown[]; nextAfter?: string }> {
    const result = await s.client.get(
      plan.path,
      { ...plan.params, limit: String(limit), ...(after !== undefined ? { after } : {}) },
      s,
    );
    if (!result.ok) throw await failureError(result.failure, operation, s);
    const envelope = parseRaw(pagedEnvelope, result.body, operation, "page");
    const nextAfter =
      envelope.paging?.next !== undefined ? envelope.paging.cursors?.after : undefined;
    return { data: envelope.data, ...(nextAfter !== undefined ? { nextAfter } : {}) };
  }

  /** Account currency and time zone (entity listings: budgets and local dates). */
  async function accountInfo(
    s: Session,
    accountExternalId: string,
    operation: ProviderOperation,
  ): Promise<MetaAccountInfo> {
    const result = await s.client.get(
      `act_${accountExternalId}`,
      { fields: "currency,timezone_name" },
      s,
    );
    if (!result.ok) throw await failureError(result.failure, operation, s);
    const raw = parseRaw(rawAccountInfo, result.body, operation, "ad account");
    return { currency: raw.currency, timezone: raw.timezone_name };
  }

  function listEntities<K extends "campaign" | "adGroup" | "ad" | "creative">(
    kind: K,
    operation: ProviderOperation,
    supported: boolean,
    entry: MetaEntityMapping<ProviderRecordByKind[K]> | undefined,
  ) {
    return (ctx: ProviderContext<MetaCredential>, request: EntityRequest) =>
      run(operation, async () => {
        assertCapability(supported, "meta", operation, `${kind} listing`);
        assertAccountId(request.accountExternalId, operation);
        if (entry === undefined) pending(operation);
        const s = session(ctx, operation, syncClient);
        const since = caps.incrementalEntities ? request.updatedSince : undefined;
        const plan = entry.plan({
          accountExternalId: request.accountExternalId,
          ...(since !== undefined ? { updatedSince: since } : {}),
        });
        const fp = fingerprint([
          operation,
          version.version,
          request.accountExternalId,
          since ?? null,
          plan,
        ]);
        const position =
          request.cursor !== undefined
            ? decodeMetaCursorPosition(request.cursor, fp, operation)
            : { stage: 0 };
        if (!isPlainPosition(position)) throw invalidCursor(operation);
        const account = entry.needsAccount
          ? await accountInfo(s, request.accountExternalId, operation)
          : undefined;
        const page = await fetchPage(
          operation,
          s,
          plan,
          pageLimit(request, ctx.attempt),
          position.after,
        );
        const context = {
          accountExternalId: request.accountExternalId,
          ...(account !== undefined ? { account } : {}),
        };
        const items = page.data.map((raw) =>
          normalizeOne(kind, operation, () => entry.normalize(raw, context)),
        );
        return page.nextAfter === undefined
          ? { items }
          : { items, nextCursor: encodeMetaCursor(fp, page.nextAfter) };
      });
  }

  function validateMetricsRequest(request: MetricsRequest, operation: ProviderOperation) {
    assertCapability(
      caps.metricLevels.includes(request.level),
      "meta",
      operation,
      `level "${request.level}"`,
    );
    assertCapability(
      request.breakdown === "none" || caps.placementBreakdown,
      "meta",
      operation,
      "placement breakdown",
    );
    assertAccountId(request.accountExternalId, operation);
    const invalid = (message: string) => metaError("invalid_request", operation, "range", message);
    if (!isDateKey(request.from) || !isDateKey(request.to))
      throw invalid("from/to must be YYYY-MM-DD");
    const span = diffDays(request.from, request.to);
    if (span < 0) throw invalid("from must not be after to");
    if (span + 1 > caps.maxMetricsRangeDays)
      throw invalid(`Range exceeds ${caps.maxMetricsRangeDays} days`);
  }

  /**
   * Staged insights: the mapping's stages (e.g. rows without breakdown, then the
   * publisher_platform breakdown) are paged in order; the cursor records the stage.
   */
  function insights<K extends "metricRow" | "actionRow">(
    kind: K,
    operation: "fetchDailyMetrics" | "fetchActionMetrics",
    supported: boolean,
    entry: MetaInsightsMapping<ProviderRecordByKind[K]> | undefined,
  ) {
    return (ctx: ProviderContext<MetaCredential>, request: MetricsRequest) =>
      run(operation, async (): Promise<ProviderPage<ProviderRecordByKind[K]>> => {
        assertCapability(supported, "meta", operation, "action metrics");
        validateMetricsRequest(request, operation);
        if (entry === undefined) pending(operation);
        const s = session(ctx, operation, syncClient);
        const stages = entry.stages(request, Date.now());
        const fp = fingerprint([
          operation,
          version.version,
          request.accountExternalId,
          request.level,
          request.from,
          request.to,
          request.breakdown,
          stages,
        ]);
        const position: MetaCursorPosition =
          request.cursor !== undefined
            ? decodeMetaCursorPosition(request.cursor, fp, operation)
            : { stage: 0 };
        if (stages[position.stage] === undefined) throw invalidCursor(operation);
        /** The carry the request arrived with (decoded afresh for every Graph attempt). */
        const incomingCarry = (): Carry => {
          try {
            return decodeCarry(position.carry, entry.carry, {
              platform: "meta",
              accountExternalId: request.accountExternalId,
              level: request.level,
            });
          } catch {
            throw invalidCursor(operation);
          }
        };
        /** One Graph page → the records to emit; accumulating records go to `into`. */
        const pageItems = (data: unknown[], into: Carry): ProviderRecordByKind[K][] => {
          let records: ProviderRecordByKind[K][];
          try {
            records = entry.normalizePage(data, {
              request,
              stage: position.stage === 0 ? 0 : 1,
            });
          } catch (error) {
            if (error instanceof ProviderError) throw error;
            throw metaError("data", operation, "normalize", "Could not normalize Meta insights");
          }
          for (const record of records) assertValidRecord(kind, record, "meta", operation);
          // Unique keys are emitted with their page; keys that can collect several raw rows
          // are accumulated across ALL pages of the stage (carried in the cursor).
          const out: ProviderRecordByKind[K][] = [];
          const keys = new Set<string>();
          try {
            for (const record of records) {
              if (entry.carry.accumulates(record)) {
                addToCarry(into, record, entry.carry);
                continue;
              }
              const key = entry.carry.key(record);
              if (keys.has(key)) throw new Error("duplicate insights row");
              keys.add(key);
              out.push(record);
            }
          } catch {
            throw metaError("data", operation, "normalize", "Inconsistent Meta insights rows");
          }
          return out;
        };
        let carry = incomingCarry();
        const limit = pageLimit(request, ctx.attempt);
        const nextStage = (): MetaCursorPosition | undefined =>
          position.stage + 1 < stages.length ? { stage: position.stage + 1 } : undefined;

        let items: ProviderRecordByKind[K][];
        let next: MetaCursorPosition | undefined;
        if (position.flush) {
          // The stage has no more Graph pages: emit accumulated records, at most one page.
          items = takeFromCarry(carry, limit) as ProviderRecordByKind[K][];
          next =
            carry.size > 0
              ? { stage: position.stage, flush: true, carry: encodeCarry(carry, entry.carry) }
              : nextStage();
        } else {
          // One Graph row can become many records (one action row per conversion type and
          // window), so a full Graph page may not fit one sync page. Then the SAME position is
          // re-requested with fewer rows until it fits; every attempt starts from the incoming
          // carry, and the next cursor starts right after the rows emitted, so no row is
          // skipped or emitted twice. The row count found is kept for the stage's next page.
          let rows = Math.min(limit, position.rows ?? limit);
          for (let shrinks = 0; ; shrinks++) {
            carry = incomingCarry();
            const page = await fetchPage(
              operation,
              s,
              stages[position.stage]!,
              rows,
              position.after,
            );
            items = pageItems(page.data, carry);
            if (items.length <= caps.maxPageSize) {
              // A sparse page lets the next one ask for more rows again (up to the limit).
              const nextRows =
                items.length * 2 <= caps.maxPageSize ? Math.min(limit, rows * 2) : rows;
              next =
                page.nextAfter !== undefined
                  ? {
                      stage: position.stage,
                      after: page.nextAfter,
                      ...(nextRows < limit ? { rows: nextRows } : {}),
                      ...(carry.size > 0 ? { carry: encodeCarry(carry, entry.carry) } : {}),
                    }
                  : carry.size > 0
                    ? { stage: position.stage, flush: true, carry: encodeCarry(carry, entry.carry) }
                    : nextStage();
              break;
            }
            if (page.data.length <= 1) {
              // Fail closed: never split or drop the records of one Graph row.
              throw metaError(
                "data",
                operation,
                "insights_row_too_large",
                "One Meta insights row has more records than fit in one page",
              );
            }
            // Rows that should fit at this page's density; strictly fewer than requested, and
            // at least halved after the first miss, so the loop ends within a few requests.
            const fitting = Math.floor((caps.maxPageSize * page.data.length) / items.length);
            const ceiling = shrinks === 0 ? page.data.length - 1 : Math.floor(page.data.length / 2);
            rows = Math.max(1, Math.min(fitting, ceiling));
          }
        }
        // Accumulated records are re-validated when emitted (sums of valid parts).
        for (const record of items) assertValidRecord(kind, record, "meta", operation);
        let nextCursor: string | undefined;
        try {
          nextCursor = next === undefined ? undefined : encodeMetaPosition(fp, next);
        } catch (error) {
          if (error instanceof CursorTooLargeError) {
            // Fail closed: never drop accumulated rows.
            throw metaError(
              "data",
              operation,
              "placement_carry_limit",
              "Too many accumulated placement rows for one request",
            );
          }
          throw error;
        }
        return nextCursor === undefined ? { items } : { items, nextCursor };
      });
  }

  return Object.freeze({
    platform: "meta" as const,
    providerId: metaProviderId(version),
    capabilities: caps,

    listAccounts: (ctx: ProviderContext<MetaCredential>, request: PageRequest) =>
      run("listAccounts", async () => {
        const s = session(ctx, "listAccounts", discoveryClient);
        const plan = { path: "me/adaccounts", params: { fields: ACCOUNT_FIELDS } };
        const fp = fingerprint(["listAccounts", version.version, plan]);
        const position =
          request.cursor !== undefined
            ? decodeMetaCursorPosition(request.cursor, fp, "listAccounts")
            : { stage: 0 };
        if (!isPlainPosition(position)) throw invalidCursor("listAccounts");
        const page = await fetchPage(
          "listAccounts",
          s,
          plan,
          pageLimit(request, ctx.attempt),
          position.after,
        );
        const items = page.data.map((raw) =>
          normalizeOne("adAccount", "listAccounts", () =>
            normalizeAdAccount(parseRaw(rawAdAccount, raw, "listAccounts", "ad account")),
          ),
        );
        return page.nextAfter === undefined
          ? { items }
          : { items, nextCursor: encodeMetaCursor(fp, page.nextAfter) };
      }),

    getAccount: (ctx: ProviderContext<MetaCredential>, request: AccountLookupRequest) =>
      run("getAccount", async () => {
        assertAccountId(request.accountExternalId, "getAccount");
        const s = session(ctx, "getAccount", syncClient);
        const result = await s.client.get(
          `act_${request.accountExternalId}`,
          { fields: ACCOUNT_FIELDS },
          s,
        );
        if (!result.ok) throw await failureError(result.failure, "getAccount", s);
        const record = normalizeOne("adAccount", "getAccount", () =>
          normalizeAdAccount(parseRaw(rawAdAccount, result.body, "getAccount", "ad account")),
        );
        if (record.externalId !== request.accountExternalId) {
          throw metaError(
            "data",
            "getAccount",
            "account_mismatch",
            "Meta returned a different ad account",
          );
        }
        return record;
      }),

    listCampaigns: listEntities(
      "campaign",
      "listCampaigns",
      caps.entities.campaigns,
      mapping.campaigns,
    ),
    listAdGroups: listEntities("adGroup", "listAdGroups", caps.entities.adGroups, mapping.adGroups),
    listAds: listEntities("ad", "listAds", caps.entities.ads, mapping.ads),
    listCreatives: listEntities(
      "creative",
      "listCreatives",
      caps.entities.creatives,
      mapping.creatives,
    ),

    fetchDailyMetrics: insights("metricRow", "fetchDailyMetrics", true, mapping.dailyMetrics),
    fetchActionMetrics: insights(
      "actionRow",
      "fetchActionMetrics",
      caps.actionMetrics,
      mapping.actionMetrics,
    ),
  });
}
