/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { UserIdentity } from "convex/server";
import { expect } from "vitest";
import { internal } from "./_generated/api";
import { isMarketingError, type MarketingErrorCode } from "./lib/errors";
import type { Role } from "./lib/validation";
import schema from "./schema";
import { modules } from "./test.setup";

// Test-only helpers (two dots in the filename => never deployed by Convex).
// convex-test's `withIdentity` stands in for a JWT that Convex has already
// verified; real signature/iss/aud/exp verification is covered by tests/live.

export const ISSUER_ERP = "https://erp.example.test";
export const ISSUER_CRM = "https://crm.example.test";

export function newBackend() {
  return convexTest(schema, modules);
}

export type Backend = ReturnType<typeof newBackend>;

export async function registerApp(
  t: Backend,
  issuer: string,
  slug: string,
  status: "active" | "disabled" = "active",
) {
  await t.mutation(internal.admin.integrationApps.register, { issuer, slug, name: slug });
  if (status === "disabled") {
    await t.mutation(internal.admin.integrationApps.setStatus, { issuer, status });
  }
}

export type IdentityInput = {
  issuer?: string;
  sub?: string;
  org?: string | null;
  role?: Role | string | null;
  orgName?: string;
};

/** Builds the identity Convex would derive from a verified JWT. */
export function identity({
  issuer = ISSUER_ERP,
  sub = "user_1",
  org = "42",
  role = "admin",
  orgName,
}: IdentityInput = {}): Partial<UserIdentity> {
  return {
    issuer,
    subject: sub,
    tokenIdentifier: `${issuer}|${sub}`,
    ...(org !== null ? { org_id: org } : {}),
    ...(role !== null ? { org_role: role } : {}),
    ...(orgName ? { org_name: orgName } : {}),
  };
}

export function as(t: Backend, input: IdentityInput = {}) {
  return t.withIdentity(identity(input));
}

export async function expectMarketingError(
  promise: Promise<unknown>,
  code: MarketingErrorCode,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${code} error`).toBeDefined();
  expect(isMarketingError(caught), `expected MarketingError, got: ${String(caught)}`).toBe(true);
  expect((caught as { data: { code: string } }).data.code).toBe(code);
}
