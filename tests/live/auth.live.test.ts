import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import { isMarketingError } from "../../convex/lib/errors";
import { DEV_ISSUER, mintToken } from "../../scripts/dev-auth.mjs";
import { liveConvexUrl } from "./local-backend";

// Opt-in: `npm run test:live`. Exercises REAL JWT verification by the Convex
// backend (signature via JWKS, iss, aud, exp) plus our tenancy layer over HTTP.
// Prerequisites: `npm run dev:backend` running and `npm run dev:auth setup` done.

const ROOT = process.cwd();

const url = liveConvexUrl();
const run = Date.now().toString(36);

function client(token?: string) {
  const c = new ConvexHttpClient(url);
  if (token) c.setAuth(token);
  return c;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to be rejected");
}

function setAppStatus(status: "active" | "disabled") {
  const result = spawnSync(
    process.execPath,
    [
      join(ROOT, "node_modules", "convex", "bin", "main.js"),
      "run",
      "admin/integrationApps:setStatus",
      JSON.stringify({ issuer: DEV_ISSUER, status }),
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`setStatus failed: ${result.stderr}`);
}

beforeAll(async () => {
  if (!existsSync(join(ROOT, ".dev-keys", "private.pem"))) {
    throw new Error("Dev keys missing. Run `npm run dev:auth setup` first.");
  }
  try {
    await client().query(api.health.ping, {});
  } catch {
    throw new Error(`Convex backend not reachable at ${url}. Run \`npm run dev:backend\`.`);
  }
});

describe("real JWT verification (Convex auth.config)", () => {
  it("accepts a valid token from the registered dev issuer", async () => {
    const token = await mintToken({ org: `live-${run}`, role: "admin", name: "Live Org" });
    const org = await client(token).mutation(api.v1.orgs.ensure, {});
    expect(org).toMatchObject({ externalOrgId: `live-${run}`, issuer: DEV_ISSUER, role: "admin" });
  });

  it("rejects a token signed with an unknown key", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const token = await mintToken({
      org: `live-${run}`,
      role: "admin",
      privateKeyPem: await exportPKCS8(privateKey),
    });
    const error = await rejection(client(token).query(api.v1.orgs.me, {}));
    expect(String(error)).toMatch(/InvalidAuthHeader/);
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await mintToken({ org: `live-${run}`, role: "admin", audience: "other-service" });
    const error = await rejection(client(token).query(api.v1.orgs.me, {}));
    expect(String(error)).toMatch(/NoAuthProvider/);
  });

  it("rejects an expired token", async () => {
    const token = await mintToken({
      org: `live-${run}`,
      role: "admin",
      issuedAt: Math.floor(Date.now() / 1000) - 3600,
      ttlSeconds: 60,
    });
    const error = await rejection(client(token).query(api.v1.orgs.me, {}));
    expect(String(error)).toMatch(/InvalidAuthHeader.*expired/i);
  });

  it("rejects a token from an unconfigured issuer, even if signed by a trusted key", async () => {
    const token = await mintToken({
      org: `live-${run}`,
      role: "admin",
      issuer: "https://attacker.example.test",
    });
    const error = await rejection(client(token).query(api.v1.orgs.me, {}));
    expect(String(error)).toMatch(/NoAuthProvider/);
  });

  it("returns UNAUTHENTICATED without a token", async () => {
    const error = await rejection(client().query(api.v1.orgs.me, {}));
    expect(isMarketingError(error) && error.data.code).toBe("UNAUTHENTICATED");
  });

  it("returns INVALID_TOKEN_CLAIMS for a verified token without org_id", async () => {
    const token = await mintToken({ org: undefined, role: "admin" });
    const error = await rejection(client(token).mutation(api.v1.orgs.ensure, {}));
    expect(isMarketingError(error) && error.data.code).toBe("INVALID_TOKEN_CLAIMS");
  });
});

describe("tenant isolation over HTTP", () => {
  it("keeps two orgs from the same issuer fully separate", async () => {
    const a = client(await mintToken({ org: `iso-a-${run}`, role: "admin", sub: "alice" }));
    const b = client(await mintToken({ org: `iso-b-${run}`, role: "admin", sub: "bob" }));

    const orgA = await a.mutation(api.v1.orgs.ensure, {});
    const orgB = await b.mutation(api.v1.orgs.ensure, {});
    expect(orgA.id).not.toBe(orgB.id);

    await a.mutation(api.v1.orgs.updateSettings, { displayName: "Alpha" });
    expect((await b.query(api.v1.orgs.me, {})).displayName).toBe(`iso-b-${run}`);

    const bAudit = await b.query(api.v1.audit.list, {
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(bAudit.page.every((entry) => entry.subject === "bob")).toBe(true);
  });

  it("enforces roles from the token", async () => {
    const viewer = client(await mintToken({ org: `iso-a-${run}`, role: "viewer" }));
    const error = await rejection(viewer.mutation(api.v1.orgs.updateSettings, { timezone: "UTC" }));
    expect(isMarketingError(error) && error.data.code).toBe("FORBIDDEN");
  });
});

describe("Clerk-shaped claims (Standalone SaaS, S1)", () => {
  // Same verification path as a Clerk token (customJwt: JWKS signature, iss, aud, exp); only
  // the claim shapes differ: Clerk organization ids and org:-prefixed roles.
  it("accepts a Clerk organization id with a prefixed role", async () => {
    const org = `org_2clerk${run}`;
    const c = client(await mintToken({ org, role: "org:admin", sub: "user_2clerk" }));
    expect(await c.mutation(api.v1.orgs.ensure, {})).toMatchObject({
      externalOrgId: org,
      role: "admin",
    });
  });

  it("refuses Clerk's default org:member role", async () => {
    const c = client(await mintToken({ org: `org_2clerk${run}`, role: "org:member" }));
    const error = await rejection(c.mutation(api.v1.orgs.ensure, {}));
    expect(isMarketingError(error) && error.data.code).toBe("INVALID_TOKEN_CLAIMS");
  });
});

describe("integration app kill switch", () => {
  it("rejects a disabled app and recovers when re-enabled", async () => {
    const c = client(await mintToken({ org: `iso-a-${run}`, role: "admin" }));
    setAppStatus("disabled");
    try {
      const error = await rejection(c.query(api.v1.orgs.me, {}));
      expect(isMarketingError(error) && error.data.code).toBe("APP_DISABLED");
    } finally {
      setAppStatus("active");
    }
    await expect(c.query(api.v1.orgs.me, {})).resolves.toMatchObject({ role: "admin" });
  });
});
