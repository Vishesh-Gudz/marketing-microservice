/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

// Contract guard for the public API. Loads every Convex module and inspects the
// registered functions' exported validators (the same JSON Convex serves to clients).

type RegisteredFn = {
  isPublic?: boolean;
  isInternal?: boolean;
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  exportArgs: () => string;
  exportReturns: () => string;
};

const allModules = import.meta.glob(
  ["/convex/**/*.ts", "!/convex/**/*.*.ts", "!/convex/_generated/**"],
  {
    eager: true,
  },
) as Record<string, Record<string, unknown>>;

function isRegistered(value: unknown): value is RegisteredFn {
  return (
    typeof value === "function" &&
    ("isQuery" in value || "isMutation" in value || "isAction" in value) &&
    "exportArgs" in value
  );
}

function functionName(path: string, exportName: string) {
  return `${path.replace(/^\/convex\//, "").replace(/\.ts$/, "")}:${exportName}`;
}

const registered = Object.entries(allModules).flatMap(([path, mod]) =>
  Object.entries(mod)
    .filter(([, value]) => isRegistered(value))
    .map(([exportName, fn]) => ({ name: functionName(path, exportName), fn: fn as RegisteredFn })),
);

const publicFns = registered.filter((r) => r.fn.isPublic);
const v1Fns = registered.filter((r) => r.name.startsWith("v1/"));

/** Collects every object field name declared anywhere in a Convex validator JSON tree. */
function fieldNames(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((n) => fieldNames(n, out));
  } else if (typeof node === "object" && node !== null) {
    const rec = node as Record<string, unknown>;
    if (rec.type === "object" && typeof rec.value === "object" && rec.value !== null) {
      out.push(...Object.keys(rec.value));
    }
    Object.values(rec).forEach((n) => fieldNames(n, out));
  }
  return out;
}

const FORBIDDEN_ARG_NAMES = new Set([
  "orgid",
  "organizationid",
  "organization",
  "org",
  "tenantid",
  "tenant",
  "issuer",
  "externalorgid",
]);

describe("public API contract", () => {
  it("exposes the expected v1 surface", () => {
    expect(v1Fns.map((r) => r.name).sort()).toEqual([
      "v1/adAccounts:list",
      "v1/analytics:actions",
      "v1/analytics:breakdown",
      "v1/analytics:overview",
      "v1/analytics:performance",
      "v1/analytics:timeSeries",
      "v1/audit:list",
      "v1/connections:beginConnect",
      "v1/connections:disconnect",
      "v1/connections:get",
      "v1/connections:linkAdAccounts",
      "v1/connections:linkSocialAccounts",
      "v1/connections:list",
      "v1/connections:listDiscoveredAssets",
      "v1/connections:listDiscoveredSocialAccounts",
      "v1/connections:refreshAssets",
      "v1/connections:unlinkAdAccount",
      "v1/connections:unlinkSocialAccount",
      "v1/orgs:ensure",
      "v1/orgs:me",
      "v1/orgs:updateSettings",
    ]);
  });

  it("has no public functions outside v1 except health.ping", () => {
    const outside = publicFns.map((r) => r.name).filter((name) => !name.startsWith("v1/"));
    expect(outside).toEqual(["health:ping"]);
  });

  it.each(v1Fns.map((r) => [r.name, r.fn] as const))("%s is public", (_name, fn) => {
    expect(fn.isPublic).toBe(true);
  });

  it.each(v1Fns.map((r) => [r.name, r.fn] as const))(
    "%s declares explicit args and returns validators",
    (_name, fn) => {
      const args = JSON.parse(fn.exportArgs());
      const returns = JSON.parse(fn.exportReturns());
      expect(args.type).toBe("object");
      expect(returns).not.toBeNull();
      expect(returns.type).not.toBe("any");
    },
  );

  it.each(v1Fns.map((r) => [r.name, r.fn] as const))(
    "%s accepts no tenant-identifying arguments",
    (_name, fn) => {
      const names = fieldNames(JSON.parse(fn.exportArgs())).map((n) =>
        n.toLowerCase().replace(/[_-]/g, ""),
      );
      expect(names.filter((n) => FORBIDDEN_ARG_NAMES.has(n))).toEqual([]);
    },
  );

  it("never returns or accepts secret-like fields in v1", () => {
    // Exact names (normalized) and substrings that indicate credential/OAuth material.
    const exact = new Set([
      "token",
      "accesstoken",
      "refreshtoken",
      "code",
      "iv",
      "credential",
      "credentials",
      "state",
      "authorizationcode",
    ]);
    const fragments = ["secret", "cipher", "verifier", "nonce", "password"];
    for (const { name, fn } of v1Fns) {
      for (const json of [fn.exportArgs(), fn.exportReturns()]) {
        for (const field of fieldNames(JSON.parse(json)).map((n) =>
          n.toLowerCase().replace(/[_-]/g, ""),
        )) {
          expect(exact.has(field), `${name}: ${field}`).toBe(false);
          expect(
            fragments.some((f) => field.includes(f)),
            `${name}: ${field}`,
          ).toBe(false);
        }
      }
    }
  });

  it("never returns internal document fields from v1", () => {
    for (const { name, fn } of v1Fns) {
      const names = fieldNames(JSON.parse(fn.exportReturns()));
      expect(names, name).not.toContain("_id");
      expect(names, name).not.toContain("_creationTime");
      expect(names, name).not.toContain("orgId");
    }
  });
});
