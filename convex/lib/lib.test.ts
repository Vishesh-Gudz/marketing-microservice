import type { UserIdentity } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { parseClaims } from "./auth";
import { parseAuthIssuers } from "./authIssuers";
import { clampPagination, mapPage, toIso } from "./dto";
import { apiError, isMarketingError, isMarketingErrorData } from "./errors";
import {
  hasRole,
  isValidCurrency,
  isValidExternalOrgId,
  isValidTimezone,
  normalizeDisplayName,
} from "./validation";

const baseIdentity = {
  issuer: "https://erp.example.test",
  subject: "user_1",
  tokenIdentifier: "https://erp.example.test|user_1",
} satisfies UserIdentity;

function claimsError(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    return isMarketingError(error) ? error.data : error;
  }
  throw new Error("expected an error");
}

describe("errors", () => {
  it("builds ConvexErrors with the standard shape", () => {
    const error = apiError("NOT_FOUND", "missing", { table: "auditLog" });
    expect(error).toBeInstanceOf(ConvexError);
    expect(error.data).toEqual({
      code: "NOT_FOUND",
      message: "missing",
      details: { table: "auditLog" },
    });
    expect(apiError("INTERNAL", "x").data).toEqual({ code: "INTERNAL", message: "x" });
  });

  it("recognizes only well-formed marketing errors", () => {
    expect(isMarketingError(apiError("FORBIDDEN", "no"))).toBe(true);
    expect(isMarketingError(new ConvexError({ code: "NOPE", message: "x" }))).toBe(false);
    expect(isMarketingError(new Error("plain"))).toBe(false);
    expect(isMarketingErrorData({ code: "RATE_LIMITED", message: "slow down" })).toBe(true);
    expect(isMarketingErrorData({ code: "RATE_LIMITED" })).toBe(false);
  });
});

describe("parseClaims", () => {
  it("extracts tenant claims", () => {
    expect(
      parseClaims({ ...baseIdentity, org_id: "42", org_role: "editor", org_name: " Acme " }),
    ).toEqual({
      issuer: baseIdentity.issuer,
      subject: "user_1",
      tokenIdentifier: baseIdentity.tokenIdentifier,
      externalOrgId: "42",
      role: "editor",
      orgName: "Acme",
    });
  });

  it.each([
    [{ org_role: "admin" }, "org_id"],
    [{ org_id: 42, org_role: "admin" }, "org_id"],
    [{ org_id: "a/b", org_role: "admin" }, "org_id"],
    [{ org_id: "42" }, "org_role"],
    [{ org_id: "42", org_role: "superuser" }, "org_role"],
  ])("rejects %j", (claims, claim) => {
    expect(claimsError(() => parseClaims({ ...baseIdentity, ...claims }))).toMatchObject({
      code: "INVALID_TOKEN_CLAIMS",
      details: { claim },
    });
  });
});

describe("validation", () => {
  it("orders roles viewer < editor < admin", () => {
    expect(hasRole("admin", "editor")).toBe(true);
    expect(hasRole("editor", "editor")).toBe(true);
    expect(hasRole("viewer", "editor")).toBe(false);
    expect(hasRole("editor", "admin")).toBe(false);
  });

  it("validates external org ids", () => {
    expect(isValidExternalOrgId("org_42:eu.1-a")).toBe(true);
    expect(isValidExternalOrgId("")).toBe(false);
    expect(isValidExternalOrgId("a b")).toBe(false);
    expect(isValidExternalOrgId("x".repeat(129))).toBe(false);
  });

  it("validates currencies, time zones and display names", () => {
    expect(isValidCurrency("INR")).toBe(true);
    expect(isValidCurrency("inr")).toBe(false);
    expect(isValidCurrency("ABC")).toBe(false);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Nowhere/Land")).toBe(false);
    expect(normalizeDisplayName("  Acme  ")).toBe("Acme");
    expect(normalizeDisplayName(" ")).toBeNull();
    expect(normalizeDisplayName("x".repeat(121))).toBeNull();
  });
});

describe("parseAuthIssuers", () => {
  const entry = {
    issuer: "https://erp.example.test",
    jwks: "https://erp.example.test/.well-known/jwks.json",
    applicationID: "marketing-service",
  };

  it("returns no providers for an empty value", () => {
    expect(parseAuthIssuers("")).toEqual([]);
    expect(parseAuthIssuers("[]")).toEqual([]);
  });

  it("builds customJwt providers with RS256 by default", () => {
    expect(parseAuthIssuers(JSON.stringify([entry]))).toEqual([
      { type: "customJwt", algorithm: "RS256", ...entry },
    ]);
  });

  it("accepts data: URIs for the JWKS", () => {
    const [provider] = parseAuthIssuers(
      JSON.stringify([{ ...entry, jwks: "data:text/plain;base64,e30=" }]),
    );
    expect(provider?.jwks).toMatch(/^data:/);
  });

  it.each([
    ["not json", "{"],
    ["not an array", "{}"],
    ["missing applicationID", JSON.stringify([{ ...entry, applicationID: undefined }])],
    ["bad algorithm", JSON.stringify([{ ...entry, algorithm: "HS256" }])],
    ["bad jwks", JSON.stringify([{ ...entry, jwks: "file:///etc/keys" }])],
    ["duplicate issuer", JSON.stringify([entry, entry])],
  ])("fails loudly on %s", (_label, raw) => {
    expect(() => parseAuthIssuers(raw)).toThrow();
  });
});

describe("dto helpers", () => {
  it("formats instants as ISO-8601 UTC", () => {
    expect(toIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("clamps page sizes to 1..100", () => {
    expect(clampPagination({ numItems: 5000, cursor: null }).numItems).toBe(100);
    expect(clampPagination({ numItems: 0, cursor: null }).numItems).toBe(1);
  });

  it("maps pages to the public shape only", () => {
    const mapped = mapPage(
      { page: [1, 2], isDone: true, continueCursor: "c", splitCursor: "s", pageStatus: null },
      (n) => n * 10,
    );
    expect(mapped).toEqual({ page: [10, 20], isDone: true, continueCursor: "c" });
  });
});
