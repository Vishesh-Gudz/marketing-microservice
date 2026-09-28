import type { ProviderOperation } from "../types";
import type { AdsAuth, GoogleAdsClient } from "./client";
import { MAX_ROUTE_CANDIDATES } from "./config";
import { classifyGoogleFailure, googleError, googleProviderError } from "./errors";
import { buildGaql } from "./gaql";
import { customerIdFromResourceName } from "./normalize";
import {
  parseRaw,
  rawAccessibleCustomers,
  rawCustomerClientRow,
  rawSearchResponse,
  type RawCustomerClientRow,
} from "./schemas";

/**
 * login-customer-id routing (G-D3), entirely inside the provider:
 * - a customer the OAuth user can access directly needs no login-customer-id;
 * - otherwise the route is the FIRST accessible customer (sorted by id) whose flattened
 *   customer_client hierarchy lists the account as not hidden — the same rule discovery
 *   uses for `parentExternalId`, so listing and lookup agree;
 * - no route → not_found (the sync blocks the account).
 * The route travels in the request cursor, so it is resolved once per request.
 */

export type Session = { client: GoogleAdsClient; auth: Omit<AdsAuth, "loginCustomerId"> };

export const CUSTOMER_CLIENT_FIELDS = [
  "customer_client.id",
  "customer_client.descriptive_name",
  "customer_client.currency_code",
  "customer_client.time_zone",
  "customer_client.manager",
  "customer_client.status",
  "customer_client.level",
  "customer_client.hidden",
  "customer_client.test_account",
] as const;

/** Sorted, de-duplicated ids of the customers the user can access directly. */
export async function accessibleCustomers(
  s: Session,
  operation: ProviderOperation,
): Promise<string[]> {
  const result = await s.client.listAccessibleCustomers(s.auth);
  if (!result.ok) throw googleProviderError(classifyGoogleFailure(result.failure), operation);
  const raw = parseRaw(rawAccessibleCustomers, result.body, operation, "accessible customers");
  let ids: string[];
  try {
    ids = (raw.resourceNames ?? []).map(customerIdFromResourceName);
  } catch {
    throw googleError("data", operation, "schema", "Unexpected accessible customer name");
  }
  return [...new Set(ids)].sort();
}

export type Route = {
  /** The login-customer-id (equals the account for direct access). */
  route: string;
  /** The routing manager's customer_client row (managed accounts only). */
  managed?: RawCustomerClientRow;
};

function managedQuery(target: string): string {
  return buildGaql({
    from: "customer_client",
    select: CUSTOMER_CLIENT_FIELDS,
    where: [
      { field: "customer_client.id", op: "=", value: { id: target } },
      { field: "customer_client.hidden", op: "=", value: { bool: false } },
    ],
  });
}

export async function resolveRoute(
  s: Session,
  target: string,
  operation: ProviderOperation,
  accessible?: readonly string[],
): Promise<Route> {
  const candidates = accessible ?? (await accessibleCustomers(s, operation));
  if (candidates.includes(target)) return { route: target };
  if (candidates.length > MAX_ROUTE_CANDIDATES) {
    throw googleError(
      "unknown",
      operation,
      "google_route_limit",
      "Too many accessible customers to resolve a route",
    );
  }
  const query = managedQuery(target);
  for (const candidate of candidates) {
    const result = await s.client.search(
      { ...s.auth, loginCustomerId: candidate },
      candidate,
      query,
    );
    if (!result.ok) {
      const classification = classifyGoogleFailure(result.failure);
      // A candidate we cannot read (cancelled, no permission) is simply not a route.
      if (classification.kind === "permission" || classification.kind === "not_found") continue;
      throw googleProviderError(classification, operation);
    }
    const page = parseRaw(rawSearchResponse, result.body, operation, "search page");
    const row = page.results?.[0];
    if (row !== undefined) {
      return {
        route: candidate,
        managed: parseRaw(rawCustomerClientRow, row, operation, "customer client"),
      };
    }
  }
  throw googleError("not_found", operation, "no_route", "Customer is not accessible");
}
