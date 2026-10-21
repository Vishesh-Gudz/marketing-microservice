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
  ProviderAdAccount,
  ProviderContext,
  ProviderOperation,
  ProviderPage,
  ProviderRecordByKind,
  ProviderRecordKind,
} from "../types";
import { assertValidRecord } from "../validate";
import { GOOGLE_CAPABILITIES } from "./capabilities";
import { addToCarry, decodeCarry, encodeCarry, takeFromCarry, type Carry } from "./carry";
import { createGoogleAdsClient, type GoogleAdsClient } from "./client";
import {
  GOOGLE_CONFIG_INVALID,
  googleProviderId,
  isValidGoogleClientId,
  isValidGoogleClientSecret,
  MAX_DISCOVERY_CALLS_PER_PAGE,
  MAX_HIERARCHY_ACCOUNTS,
  OAUTH_TIMEOUT_MS,
  resolveGoogleVersion,
  SYNC_TIMEOUT_MS,
} from "./config";
import { isGoogleCredential, type GoogleCredential } from "./credential";
import {
  CursorTooLargeError,
  decodeGoogleCursor,
  encodeGoogleCursor,
  MAX_LOOKUP_ENTRIES,
  type GoogleCursorLookup,
  type GoogleCursorPosition,
} from "./cursor";
import { classifyGoogleFailure, googleError, googleProviderError } from "./errors";
import { buildGaql } from "./gaql";
import {
  GOOGLE_MAPPING,
  GOOGLE_MAPPING_PENDING,
  type GoogleEntityMapping,
  type GoogleInsightsMapping,
  type GoogleLookupSpec,
} from "./mapping";
import { normalizeCustomer, normalizeCustomerClient } from "./normalize";
import { accessibleCustomers, CUSTOMER_CLIENT_FIELDS, resolveRoute, type Session } from "./route";
import {
  parseRaw,
  rawCustomerClientRow,
  rawCustomerRow,
  rawSearchResponse,
  rawTokenResponse,
} from "./schemas";

export { GOOGLE_CAPABILITIES } from "./capabilities";
export { GOOGLE_ADS_API_VERSION } from "./config";
export type { GoogleCredential } from "./credential";

export type GoogleProviderOptions = {
  /** GOOGLE_ADS_API_VERSION override (validated); defaults to the pinned version. */
  version?: string;
  /** GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET: the OAuth client that minted the refresh token. */
  clientId?: string;
  clientSecret?: string;
  timeoutMs?: number;
  /** Discovery (listAccounts) runs inside the OAuth callback: shorter timeout. */
  discoveryTimeoutMs?: number;
};

const CUSTOMER_ID = /^\d{10}$/;
/** Google pages read for one request lookup (a loop guard; real pages hold 10,000 rows). */
const MAX_LOOKUP_PAGES = 100;

const CUSTOMER_QUERY = buildGaql({
  from: "customer",
  select: [
    "customer.id",
    "customer.descriptive_name",
    "customer.currency_code",
    "customer.time_zone",
    "customer.manager",
    "customer.status",
    "customer.test_account",
  ],
});

const HIERARCHY_QUERY = buildGaql({
  from: "customer_client",
  select: CUSTOMER_CLIENT_FIELDS,
  where: [{ field: "customer_client.level", op: ">", value: { int: 0 } }],
  orderBy: [{ field: "customer_client.id" }],
});

/**
 * Real Google Ads provider (Phase 9). The engine implements the AdsProvider contract's
 * plumbing: per-call access tokens (G-D5a), login-customer-id routing (G-D3), customer
 * discovery (G-D17), GAQL paging with provider slicing (G-D16), the request lookup and the
 * carry. Structure, metric and action semantics come from GOOGLE_MAPPING (mapping.ts, Stage
 * B); an operation without a mapping entry fails closed before any network call. Pure,
 * tenant-free, database-free.
 *
 * Options are deployment configuration only (the registry passes them from the Convex env).
 * There is no test injection path: HTTP goes through the runtime's global `fetch` and the
 * mapping is the module's GOOGLE_MAPPING.
 */
export function createGoogleAdsProvider(
  options: GoogleProviderOptions = {},
): AdsProvider<GoogleCredential> {
  const caps = GOOGLE_CAPABILITIES;
  const version = resolveGoogleVersion(options.version);
  const mapping = GOOGLE_MAPPING;
  const syncClient = createGoogleAdsClient({
    version: version.version,
    timeoutMs: options.timeoutMs ?? SYNC_TIMEOUT_MS,
  });
  const discoveryClient = createGoogleAdsClient({
    version: version.version,
    timeoutMs: options.discoveryTimeoutMs ?? OAUTH_TIMEOUT_MS,
  });

  async function run<T>(operation: ProviderOperation, body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      throw toProviderError(error, "google_ads", operation);
    }
  }

  function invalidCursor(operation: ProviderOperation): ProviderError {
    return googleError(
      "invalid_request",
      operation,
      "cursor_invalid",
      "Cursor is malformed or belongs to a different request.",
    );
  }

  function pending(operation: ProviderOperation): never {
    throw googleError(
      "unknown",
      operation,
      GOOGLE_MAPPING_PENDING,
      "Google Ads structure/metric mapping is not available",
    );
  }

  function assertCustomerId(value: string, operation: ProviderOperation) {
    if (!CUSTOMER_ID.test(value)) {
      throw googleError(
        "invalid_request",
        operation,
        "customer_id",
        "Customer id must be 10 digits",
      );
    }
  }

  /**
   * Config + credential checks, then a fresh access token (memory only, G-D5a).
   * Config problems → "unknown"; credential problems → "auth".
   */
  async function session(
    ctx: ProviderContext<GoogleCredential>,
    operation: ProviderOperation,
    client: GoogleAdsClient,
  ): Promise<Session> {
    if (
      !version.valid ||
      !isValidGoogleClientId(options.clientId) ||
      !isValidGoogleClientSecret(options.clientSecret)
    ) {
      throw googleError(
        "unknown",
        operation,
        GOOGLE_CONFIG_INVALID,
        "Google Ads configuration is missing or invalid",
      );
    }
    const credential: unknown = ctx.credential;
    if (!isGoogleCredential(credential)) {
      throw googleError(
        "auth",
        operation,
        "credential_invalid",
        "Stored credential is not a Google credential",
      );
    }
    if (credential.clientId !== options.clientId) {
      throw googleError(
        "auth",
        operation,
        "client_id_mismatch",
        "Credential belongs to a different OAuth client",
      );
    }
    const result = await client.token({
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: options.clientId,
      client_secret: options.clientSecret,
    });
    if (!result.ok) throw googleProviderError(classifyGoogleFailure(result.failure), operation);
    const token = parseRaw(rawTokenResponse, result.body, operation, "token");
    return { client, auth: { accessToken: token.access_token } };
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
      throw googleError("data", operation, "normalize", `Could not normalize a Google ${kind}`);
    }
    assertValidRecord(kind, record, "google_ads", operation);
    return record;
  }

  function encode(
    operation: ProviderOperation,
    fp: string,
    position: GoogleCursorPosition | undefined,
  ): string | undefined {
    if (position === undefined) return undefined;
    try {
      return encodeGoogleCursor(fp, position);
    } catch (error) {
      if (error instanceof CursorTooLargeError) {
        throw googleError(
          "data",
          operation,
          "cursor_limit",
          "Too much accumulated state for one request",
        );
      }
      throw error;
    }
  }

  /**
   * One provider page of a GAQL stage: the Google page for `pageToken` (re-retrieved for
   * every slice; G-D16) and rows [offset, offset + limit). Deterministic ORDER BY in every
   * query keeps offsets stable.
   */
  async function fetchSlice(
    operation: ProviderOperation,
    s: Session,
    customerId: string,
    route: string,
    query: string,
    position: GoogleCursorPosition,
    limit: number,
  ): Promise<{ rows: unknown[]; next?: Pick<GoogleCursorPosition, "pageToken" | "offset"> }> {
    const result = await s.client.search(
      { ...s.auth, ...(route !== customerId ? { loginCustomerId: route } : {}) },
      customerId,
      query,
      position.pageToken,
    );
    if (!result.ok) throw googleProviderError(classifyGoogleFailure(result.failure), operation);
    const page = parseRaw(rawSearchResponse, result.body, operation, "search page");
    const rows = page.results ?? [];
    const offset = position.offset ?? 0;
    if (offset > 0 && offset >= rows.length) throw invalidCursor(operation);
    const end = offset + limit;
    if (end < rows.length) {
      return {
        rows: rows.slice(offset, end),
        next: {
          ...(position.pageToken !== undefined ? { pageToken: position.pageToken } : {}),
          offset: end,
        },
      };
    }
    return {
      rows: rows.slice(offset),
      ...(page.nextPageToken !== undefined ? { next: { pageToken: page.nextPageToken } } : {}),
    };
  }

  function pageLimit(request: PageRequest): number {
    return clampPageSize(request.pageSize, caps.defaultPageSize, caps.maxPageSize);
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  async function directCustomer(
    s: Session,
    customerId: string,
    operation: ProviderOperation,
  ): Promise<ProviderAdAccount | undefined> {
    const result = await s.client.search(s.auth, customerId, CUSTOMER_QUERY);
    if (!result.ok) {
      const classification = classifyGoogleFailure(result.failure);
      if (classification.kind === "permission" || classification.kind === "not_found") {
        return undefined;
      }
      throw googleProviderError(classification, operation);
    }
    const row = parseRaw(rawSearchResponse, result.body, operation, "search page").results?.[0];
    if (row === undefined) return undefined;
    const record = normalizeOne("adAccount", operation, () =>
      normalizeCustomer(parseRaw(rawCustomerRow, row, operation, "customer")),
    );
    if (record.externalId !== customerId) {
      throw googleError("data", operation, "account_mismatch", "Google returned another customer");
    }
    return record;
  }

  /**
   * Discovery (G-D17): accessible customers in sorted order; each listed on its own, and for
   * managers their flattened hierarchy (level ≥ 1, ordered by id). Pages are filled up to
   * the page size with at most MAX_DISCOVERY_CALLS_PER_PAGE searches; the cursor carries the
   * position and the ids already listed (each account is listed once).
   */
  async function listAccounts(
    ctx: ProviderContext<GoogleCredential>,
    request: PageRequest,
  ): Promise<ProviderPage<ProviderAdAccount>> {
    const operation = "listAccounts";
    const s = await session(ctx, operation, discoveryClient);
    const accessible = await accessibleCustomers(s, operation);
    const accessibleSet = new Set(accessible);
    const fp = fingerprint([operation, version.version, accessible, HIERARCHY_QUERY]);
    const position: GoogleCursorPosition =
      request.cursor !== undefined
        ? decodeGoogleCursor(request.cursor, fp, operation)
        : { stage: 0 };
    if (
      position.stage !== 0 ||
      position.flush !== undefined ||
      position.carry !== undefined ||
      position.route !== undefined
    ) {
      throw invalidCursor(operation);
    }
    const limit = pageLimit(request);
    const seen = new Set(position.seen ?? []);
    let index = position.index ?? 0;
    let hierarchy = position.hierarchy === true;
    let pageToken = position.pageToken;
    let offset = position.offset ?? 0;
    if (index > accessible.length) throw invalidCursor(operation);

    const items: ProviderAdAccount[] = [];
    const list = (record: ProviderAdAccount) => {
      if (seen.size >= MAX_HIERARCHY_ACCOUNTS) {
        throw googleError(
          "unknown",
          operation,
          "google_hierarchy_limit",
          "Too many accounts in the manager hierarchy",
        );
      }
      seen.add(record.externalId);
      items.push(record);
    };
    const nextCustomer = () => {
      index += 1;
      hierarchy = false;
      pageToken = undefined;
      offset = 0;
    };

    let calls = 0;
    while (
      index < accessible.length &&
      items.length < limit &&
      calls < MAX_DISCOVERY_CALLS_PER_PAGE
    ) {
      const customer = accessible[index]!;
      calls += 1;
      if (!hierarchy) {
        const record = await directCustomer(s, customer, operation);
        if (record === undefined) {
          // Not readable (for example cancelled): nothing to describe it with.
          nextCustomer();
          continue;
        }
        if (!seen.has(customer)) list(record);
        if (record.isManager) hierarchy = true;
        else nextCustomer();
        continue;
      }
      const result = await s.client.search(
        { ...s.auth, loginCustomerId: customer },
        customer,
        HIERARCHY_QUERY,
        pageToken,
      );
      if (!result.ok) {
        const classification = classifyGoogleFailure(result.failure);
        if (classification.kind === "permission" || classification.kind === "not_found") {
          nextCustomer();
          continue;
        }
        throw googleProviderError(classification, operation);
      }
      const page = parseRaw(rawSearchResponse, result.body, operation, "search page");
      const rows = page.results ?? [];
      if (offset > 0 && offset >= rows.length) throw invalidCursor(operation);
      let i = offset;
      for (; i < rows.length && items.length < limit; i++) {
        const row = parseRaw(rawCustomerClientRow, rows[i], operation, "customer client");
        if (row.customerClient.hidden === true) continue;
        if (accessibleSet.has(row.customerClient.id) || seen.has(row.customerClient.id)) continue;
        list(normalizeOne("adAccount", operation, () => normalizeCustomerClient(row, customer)));
      }
      if (i < rows.length) {
        offset = i;
        break;
      }
      if (page.nextPageToken !== undefined) {
        pageToken = page.nextPageToken;
        offset = 0;
      } else {
        nextCustomer();
      }
    }

    const next: GoogleCursorPosition | undefined =
      index >= accessible.length
        ? undefined
        : {
            stage: 0,
            ...(index > 0 ? { index } : {}),
            ...(hierarchy ? { hierarchy: true as const } : {}),
            ...(pageToken !== undefined ? { pageToken } : {}),
            ...(offset > 0 ? { offset } : {}),
            ...(seen.size > 0 ? { seen: [...seen] } : {}),
          };
    const nextCursor = encode(operation, fp, next);
    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  /** The account by id: direct access, else the routing manager's customer_client row. */
  async function getAccount(
    ctx: ProviderContext<GoogleCredential>,
    request: AccountLookupRequest,
  ): Promise<ProviderAdAccount> {
    const operation = "getAccount";
    assertCustomerId(request.accountExternalId, operation);
    const s = await session(ctx, operation, syncClient);
    const { route, managed } = await resolveRoute(s, request.accountExternalId, operation);
    if (managed === undefined) {
      const record = await directCustomer(s, route, operation);
      if (record === undefined) {
        throw googleError("permission", operation, "CUSTOMER_NOT_ENABLED", "Customer not readable");
      }
      return record;
    }
    const record = normalizeOne("adAccount", operation, () =>
      normalizeCustomerClient(managed, route),
    );
    if (record.externalId !== request.accountExternalId) {
      throw googleError("data", operation, "account_mismatch", "Google returned another customer");
    }
    return record;
  }

  // -------------------------------------------------------------------------
  // Structure and insights (mapping-driven; fail closed without a mapping)
  // -------------------------------------------------------------------------

  function plainPosition(position: GoogleCursorPosition): boolean {
    return (
      position.flush === undefined &&
      position.carry === undefined &&
      position.lookup === undefined &&
      position.index === undefined &&
      position.hierarchy === undefined &&
      position.seen === undefined
    );
  }

  function listEntities<K extends "campaign" | "adGroup" | "ad" | "creative">(
    kind: K,
    operation: ProviderOperation,
    supported: boolean,
    entry: GoogleEntityMapping<ProviderRecordByKind[K]> | undefined,
  ) {
    return (ctx: ProviderContext<GoogleCredential>, request: EntityRequest) =>
      run(operation, async (): Promise<ProviderPage<ProviderRecordByKind[K]>> => {
        assertCapability(supported, "google_ads", operation, `${kind} listing`);
        assertCustomerId(request.accountExternalId, operation);
        if (entry === undefined) pending(operation);
        const stages = entry
          .stages({ accountExternalId: request.accountExternalId })
          .map((query) => buildGaql(query));
        const fp = fingerprint([operation, version.version, request.accountExternalId, stages]);
        const position: GoogleCursorPosition =
          request.cursor !== undefined
            ? decodeGoogleCursor(request.cursor, fp, operation)
            : { stage: 0 };
        const query = stages[position.stage];
        if (query === undefined || !plainPosition(position)) throw invalidCursor(operation);
        const s = await session(ctx, operation, syncClient);
        const route =
          position.route ?? (await resolveRoute(s, request.accountExternalId, operation)).route;
        const slice = await fetchSlice(
          operation,
          s,
          request.accountExternalId,
          route,
          query,
          position,
          pageLimit(request),
        );
        const items = slice.rows.map((row) =>
          normalizeOne(kind, operation, () =>
            entry.normalize(row, {
              accountExternalId: request.accountExternalId,
              stage: position.stage,
            }),
          ),
        );
        const next: GoogleCursorPosition | undefined =
          slice.next !== undefined
            ? { stage: position.stage, ...slice.next, route }
            : position.stage + 1 < stages.length
              ? { stage: position.stage + 1, route }
              : undefined;
        const nextCursor = encode(operation, fp, next);
        return nextCursor === undefined ? { items } : { items, nextCursor };
      });
  }

  function validateMetricsRequest(request: MetricsRequest, operation: ProviderOperation) {
    assertCapability(
      caps.metricLevels.includes(request.level),
      "google_ads",
      operation,
      `level "${request.level}"`,
    );
    assertCapability(
      request.breakdown === "none" || caps.placementBreakdown,
      "google_ads",
      operation,
      "placement breakdown",
    );
    assertCustomerId(request.accountExternalId, operation);
    const invalid = (message: string) =>
      googleError("invalid_request", operation, "range", message);
    if (!isDateKey(request.from) || !isDateKey(request.to)) {
      throw invalid("from/to must be YYYY-MM-DD");
    }
    const span = diffDays(request.from, request.to);
    if (span < 0) throw invalid("from must not be after to");
    if (span + 1 > caps.maxMetricsRangeDays) {
      throw invalid(`Range exceeds ${caps.maxMetricsRangeDays} days`);
    }
  }

  /**
   * Reads a request lookup (every Google page, at most MAX_LOOKUP_ENTRIES rows) on the first
   * page of a request. Rows are id → flag; ids without a reported flag are left out.
   */
  async function readLookup(
    operation: ProviderOperation,
    s: Session,
    customerId: string,
    route: string,
    spec: GoogleLookupSpec,
    query: string,
  ): Promise<GoogleCursorLookup> {
    const limit = () => googleError("data", operation, "lookup_limit", "Too many reference rows");
    const included: string[] = [];
    const excluded: string[] = [];
    const seen = new Set<string>();
    const tokens = new Set<string>();
    let pageToken: string | undefined;
    // Every Google page of the lookup, within this one provider call (bounded; fail closed).
    do {
      const result = await s.client.search(
        { ...s.auth, ...(route !== customerId ? { loginCustomerId: route } : {}) },
        customerId,
        query,
        pageToken,
      );
      if (!result.ok) throw googleProviderError(classifyGoogleFailure(result.failure), operation);
      const page = parseRaw(rawSearchResponse, result.body, operation, "search page");
      for (const row of page.results ?? []) {
        let entry: [string, boolean | undefined];
        try {
          entry = spec.entry(row);
        } catch (error) {
          if (error instanceof ProviderError) throw error;
          throw googleError("data", operation, "normalize", "Could not read Google reference rows");
        }
        const [id, flag] = entry;
        if (!/^\d{1,20}$/.test(id) || seen.has(id)) {
          throw googleError("data", operation, "normalize", "Inconsistent Google reference rows");
        }
        seen.add(id);
        if (seen.size > MAX_LOOKUP_ENTRIES) throw limit();
        if (flag === true) included.push(id);
        else if (flag === false) excluded.push(id);
      }
      pageToken = page.nextPageToken;
      if (pageToken !== undefined) {
        if (tokens.has(pageToken) || tokens.size >= MAX_LOOKUP_PAGES) throw limit();
        tokens.add(pageToken);
      }
    } while (pageToken !== undefined);
    return { included, excluded };
  }

  /**
   * Staged insights: the mapping's GAQL stages are paged in order, each Google page sliced
   * into provider pages; records whose key collects several rows are carried across pages
   * and emitted on flush pages at the end of the stage. A mapping lookup is read once, on
   * the first page, and travels in the cursor.
   */
  function insights<K extends "metricRow" | "actionRow">(
    kind: K,
    operation: "fetchDailyMetrics" | "fetchActionMetrics",
    supported: boolean,
    entry: GoogleInsightsMapping<ProviderRecordByKind[K]> | undefined,
  ) {
    return (ctx: ProviderContext<GoogleCredential>, request: MetricsRequest) =>
      run(operation, async (): Promise<ProviderPage<ProviderRecordByKind[K]>> => {
        assertCapability(supported, "google_ads", operation, "action metrics");
        validateMetricsRequest(request, operation);
        if (entry === undefined) pending(operation);
        const stages = entry.stages(request).map((query) => buildGaql(query));
        const lookupQuery = entry.lookup !== undefined ? buildGaql(entry.lookup.query) : null;
        const fp = fingerprint([
          operation,
          version.version,
          request.accountExternalId,
          request.level,
          request.from,
          request.to,
          request.breakdown,
          stages,
          lookupQuery,
        ]);
        const position: GoogleCursorPosition =
          request.cursor !== undefined
            ? decodeGoogleCursor(request.cursor, fp, operation)
            : { stage: 0 };
        if (
          stages[position.stage] === undefined ||
          position.index !== undefined ||
          position.hierarchy !== undefined ||
          position.seen !== undefined ||
          // A lookup exists exactly on the later pages of a request whose mapping has one.
          (position.lookup !== undefined) !== (lookupQuery !== null && request.cursor !== undefined)
        ) {
          throw invalidCursor(operation);
        }
        let carry: Carry;
        try {
          carry = decodeCarry(position.carry, entry.carry, {
            platform: "google_ads",
            accountExternalId: request.accountExternalId,
            level: request.level,
          });
        } catch {
          throw invalidCursor(operation);
        }
        const limit = pageLimit(request);
        const s = position.flush ? undefined : await session(ctx, operation, syncClient);
        const route =
          position.route ??
          (s !== undefined
            ? (await resolveRoute(s, request.accountExternalId, operation)).route
            : undefined);
        if (route === undefined) throw invalidCursor(operation);
        let lookup = position.lookup;
        if (lookup === undefined && entry.lookup !== undefined && lookupQuery !== null) {
          if (s === undefined) throw invalidCursor(operation);
          lookup = await readLookup(
            operation,
            s,
            request.accountExternalId,
            route,
            entry.lookup,
            lookupQuery,
          );
        }
        const lookupMap = new Map<string, boolean>([
          ...(lookup?.included ?? []).map((id): [string, boolean] => [id, true]),
          ...(lookup?.excluded ?? []).map((id): [string, boolean] => [id, false]),
        ]);
        const carried = lookup !== undefined ? { lookup } : {};
        const nextStage = (): GoogleCursorPosition | undefined =>
          position.stage + 1 < stages.length
            ? { stage: position.stage + 1, route, ...carried }
            : undefined;

        let items: ProviderRecordByKind[K][];
        let next: GoogleCursorPosition | undefined;
        if (position.flush || s === undefined) {
          items = takeFromCarry(carry, limit) as ProviderRecordByKind[K][];
          next =
            carry.size > 0
              ? {
                  stage: position.stage,
                  flush: true,
                  carry: encodeCarry(carry, entry.carry),
                  route,
                  ...carried,
                }
              : nextStage();
        } else {
          const slice = await fetchSlice(
            operation,
            s,
            request.accountExternalId,
            route,
            stages[position.stage]!,
            position,
            limit,
          );
          let records: ProviderRecordByKind[K][];
          try {
            records = entry.normalizePage(slice.rows, {
              request,
              stage: position.stage,
              lookup: lookupMap,
            });
          } catch (error) {
            if (error instanceof ProviderError) throw error;
            throw googleError("data", operation, "normalize", "Could not normalize Google rows");
          }
          for (const record of records) assertValidRecord(kind, record, "google_ads", operation);
          items = [];
          const keys = new Set<string>();
          try {
            for (const record of records) {
              if (entry.carry.accumulates(record)) {
                addToCarry(carry, record, entry.carry);
                continue;
              }
              const key = entry.carry.key(record);
              if (keys.has(key)) throw new Error("duplicate row");
              keys.add(key);
              items.push(record);
            }
          } catch {
            throw googleError("data", operation, "normalize", "Inconsistent Google rows");
          }
          const withCarry = carry.size > 0 ? { carry: encodeCarry(carry, entry.carry) } : {};
          next =
            slice.next !== undefined
              ? { stage: position.stage, ...slice.next, route, ...withCarry, ...carried }
              : carry.size > 0
                ? { stage: position.stage, flush: true, route, ...withCarry, ...carried }
                : nextStage();
        }
        for (const record of items) assertValidRecord(kind, record, "google_ads", operation);
        const nextCursor = encode(operation, fp, next);
        return nextCursor === undefined ? { items } : { items, nextCursor };
      });
  }

  return Object.freeze({
    platform: "google_ads" as const,
    providerId: googleProviderId(version),
    capabilities: caps,

    listAccounts: (ctx: ProviderContext<GoogleCredential>, request: PageRequest) =>
      run("listAccounts", () => listAccounts(ctx, request)),
    getAccount: (ctx: ProviderContext<GoogleCredential>, request: AccountLookupRequest) =>
      run("getAccount", () => getAccount(ctx, request)),

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
