import type { UserIdentity } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseClaims, requireClaims } from "./auth";
import { assertDevIssuerAllowed, DEV_ISSUER, parseAuthIssuers } from "./authIssuers";
import { isMarketingError } from "./errors";
import { normalizeRoleClaim } from "./validation";

// Standalone SaaS with Clerk (S1): role mapping (D2), Clerk-shaped claims, and the dev issuer
// never being trusted by a cloud deployment.

const CLERK_ISSUER = "https://example-app.clerk.accounts.test";
const clerkIdentity = {
  issuer: CLERK_ISSUER,
  subject: "user_2abcDEF123",
  tokenIdentifier: `${CLERK_ISSUER}|user_2abcDEF123`,
} satisfies UserIdentity;

function errorData(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    return isMarketingError(error) ? error.data : error;
  }
  throw new Error("expected an error");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeRoleClaim (D2)", () => {
  it.each([
    ["viewer", "viewer"],
    ["editor", "editor"],
    ["admin", "admin"],
    ["org:viewer", "viewer"],
    ["org:editor", "editor"],
    ["org:admin", "admin"],
  ])("maps %s to %s", (claim, role) => {
    expect(normalizeRoleClaim(claim)).toBe(role);
  });

  it.each([
    "org:member",
    "member",
    "org:billing",
    "Admin",
    "ORG:ADMIN",
    " admin",
    "org:admin ",
    "org:",
    "org:org:admin",
    "constructor",
    "toString",
    "__proto__",
    "",
  ])("refuses %j", (claim) => {
    expect(normalizeRoleClaim(claim)).toBeNull();
  });

  it.each([null, undefined, 1, true, {}, ["admin"]])("refuses non-strings (%j)", (claim) => {
    expect(normalizeRoleClaim(claim)).toBeNull();
  });
});

describe("parseClaims with Clerk-shaped tokens", () => {
  it("accepts a Clerk organization id and a prefixed role", () => {
    expect(
      parseClaims({
        ...clerkIdentity,
        org_id: "org_2abcDEFghi456",
        org_role: "org:admin",
        org_name: "Acme Inc",
      }),
    ).toEqual({
      issuer: CLERK_ISSUER,
      subject: "user_2abcDEF123",
      tokenIdentifier: clerkIdentity.tokenIdentifier,
      externalOrgId: "org_2abcDEFghi456",
      role: "admin",
      orgName: "Acme Inc",
    });
  });

  it("ignores an org_name that rendered as null", () => {
    const claims = parseClaims({
      ...clerkIdentity,
      org_id: "org_2abc",
      org_role: "org:viewer",
      org_name: null,
    } as unknown as UserIdentity);
    expect(claims.role).toBe("viewer");
    expect(claims.orgName).toBeUndefined();
  });

  it.each([
    ["Clerk's default member role", { org_id: "org_2abc", org_role: "org:member" }, "org_role"],
    ["a custom role", { org_id: "org_2abc", org_role: "org:billing" }, "org_role"],
    ["no active organization (null id)", { org_id: null, org_role: null }, "org_id"],
    ["no active organization (no claims)", {}, "org_id"],
  ])("refuses %s", (_label, claims, claim) => {
    expect(
      errorData(() => parseClaims({ ...clerkIdentity, ...claims } as unknown as UserIdentity)),
    ).toMatchObject({ code: "INVALID_TOKEN_CLAIMS", details: { claim } });
  });
});

describe("the dev issuer is never trusted by a cloud deployment", () => {
  const devEntry = JSON.stringify([
    { issuer: DEV_ISSUER, jwks: "data:text/plain;base64,e30=", applicationID: "marketing-service" },
  ]);
  const clerkEntry = JSON.stringify([
    {
      issuer: CLERK_ISSUER,
      jwks: `${CLERK_ISSUER}/.well-known/jwks.json`,
      applicationID: "convex",
    },
  ]);

  it("refuses AUTH_ISSUERS with the dev issuer on a cloud deployment (deploy time)", () => {
    expect(() =>
      assertDevIssuerAllowed(parseAuthIssuers(devEntry), "https://happy-otter-123.convex.cloud"),
    ).toThrow(/dev issuer/);
  });

  it.each([
    ["the local backend", "http://127.0.0.1:3210"],
    ["an in-process test (no URL)", undefined],
  ])("allows it on %s", (_label, url) => {
    expect(() => assertDevIssuerAllowed(parseAuthIssuers(devEntry), url)).not.toThrow();
  });

  it("allows a cloud deployment that trusts only Clerk", () => {
    expect(() =>
      assertDevIssuerAllowed(parseAuthIssuers(clerkEntry), "https://happy-otter-123.convex.cloud"),
    ).not.toThrow();
  });

  function ctxWith(identity: UserIdentity) {
    return { auth: { getUserIdentity: async () => identity } } as Parameters<
      typeof requireClaims
    >[0];
  }
  const devIdentity = {
    issuer: DEV_ISSUER,
    subject: "dev-user",
    tokenIdentifier: `${DEV_ISSUER}|dev-user`,
    org_id: "dev-org",
    org_role: "admin",
  } as unknown as UserIdentity;

  it("refuses a verified dev-issuer token at runtime on a cloud deployment", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-otter-123.convex.cloud");
    let caught: unknown;
    try {
      await requireClaims(ctxWith(devIdentity));
    } catch (error) {
      caught = error;
    }
    expect(isMarketingError(caught) && caught.data.code).toBe("UNAUTHENTICATED");
  });

  it("accepts it on the local backend, and accepts Clerk tokens on cloud", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
    await expect(requireClaims(ctxWith(devIdentity))).resolves.toMatchObject({ role: "admin" });
    vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-otter-123.convex.cloud");
    await expect(
      requireClaims(
        ctxWith({
          ...clerkIdentity,
          org_id: "org_2abc",
          org_role: "org:editor",
        } as unknown as UserIdentity),
      ),
    ).resolves.toMatchObject({ role: "editor", externalOrgId: "org_2abc" });
  });
});
