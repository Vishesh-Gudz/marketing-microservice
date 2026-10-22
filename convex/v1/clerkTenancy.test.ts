import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { DEV_ISSUER } from "../lib/authIssuers";
import {
  as,
  expectMarketingError,
  ISSUER_ERP,
  newBackend,
  registerApp,
  registerAppWithReturnUrls,
  RETURN_URL,
  setupSyncOrg,
  type Backend,
  type IdentityInput,
} from "../test.helpers";

// Standalone SaaS with Clerk (S1), end to end on convex-test: Clerk-shaped identities through
// the real tenancy wrappers. Convex itself verifies the JWT signature, issuer, audience and
// expiry before any function runs (covered against a real backend by tests/live/auth.live);
// here the verified identity is injected.

const CLERK = "https://example-app.clerk.accounts.test";
const ACME_ADMIN: IdentityInput = {
  issuer: CLERK,
  sub: "user_2alice",
  org: "org_2acme",
  role: "org:admin",
  orgName: "Acme",
};
const GLOBEX_VIEWER: IdentityInput = {
  issuer: CLERK,
  sub: "user_2alice",
  org: "org_2globex",
  role: "org:viewer",
  orgName: "Globex",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

async function clerkBackend(): Promise<Backend> {
  const t = newBackend();
  // Registered with the default allowed return URL (RETURN_URL) for the connection tests.
  await registerAppWithReturnUrls(t, CLERK, "clerk-dev");
  return t;
}

async function orgCount(t: Backend) {
  return await t.run(async (ctx) => (await ctx.db.query("organizations").collect()).length);
}

describe("Clerk organizations as tenants", () => {
  it("provisions a Clerk organization on first use with its name and the mapped role", async () => {
    const t = await clerkBackend();
    const org = await as(t, ACME_ADMIN).mutation(api.v1.orgs.ensure, {});
    expect(org).toMatchObject({
      externalOrgId: "org_2acme",
      issuer: CLERK,
      displayName: "Acme",
      role: "admin",
    });
  });

  it("switching the active organization switches the tenant; data stays isolated", async () => {
    const t = await clerkBackend();
    const acme = await as(t, ACME_ADMIN).mutation(api.v1.orgs.ensure, {});
    await as(t, ACME_ADMIN).mutation(api.v1.orgs.updateSettings, { reportingCurrency: "EUR" });

    // Same Clerk user, other organization: a different tenant with its own settings and role.
    const globex = await as(t, GLOBEX_VIEWER).mutation(api.v1.orgs.ensure, {});
    expect(globex.id).not.toBe(acme.id);
    expect(globex).toMatchObject({
      displayName: "Globex",
      reportingCurrency: "USD",
      role: "viewer",
    });
    expect(await as(t, GLOBEX_VIEWER).query(api.v1.orgs.me, {})).toMatchObject({
      id: globex.id,
      reportingCurrency: "USD",
    });
    expect(await as(t, ACME_ADMIN).query(api.v1.orgs.me, {})).toMatchObject({
      id: acme.id,
      reportingCurrency: "EUR",
      role: "admin",
    });
  });

  it("a viewer cannot perform admin operations", async () => {
    const t = await clerkBackend();
    await setupSyncOrg(t, GLOBEX_VIEWER);
    await expectMarketingError(
      as(t, GLOBEX_VIEWER).mutation(api.v1.orgs.updateSettings, { reportingCurrency: "EUR" }),
      "FORBIDDEN",
    );
    await expectMarketingError(
      as(t, GLOBEX_VIEWER).query(api.v1.audit.list, {
        paginationOpts: { cursor: null, numItems: 10 },
      }),
      "FORBIDDEN",
    );
    await expectMarketingError(
      as(t, GLOBEX_VIEWER).action(api.v1.connections.beginConnect, {
        provider: "meta",
        returnUrl: RETURN_URL,
      }),
      "FORBIDDEN",
    );
  });

  it("an editor is not an admin", async () => {
    const t = await clerkBackend();
    const editor = { ...ACME_ADMIN, role: "org:editor" };
    expect(await as(t, editor).mutation(api.v1.orgs.ensure, {})).toMatchObject({
      role: "editor",
    });
    await expectMarketingError(
      as(t, editor).mutation(api.v1.orgs.updateSettings, { reportingCurrency: "EUR" }),
      "FORBIDDEN",
    );
  });

  it.each([
    ["Clerk's default org:member role", { ...ACME_ADMIN, role: "org:member" }],
    ["a custom Clerk role", { ...ACME_ADMIN, role: "org:billing" }],
    ["a signed-in user without an active organization", { ...ACME_ADMIN, org: null, role: null }],
  ])("refuses %s and provisions nothing", async (_label, identityInput) => {
    const t = await clerkBackend();
    await expectMarketingError(
      as(t, identityInput).mutation(api.v1.orgs.ensure, {}),
      "INVALID_TOKEN_CLAIMS",
    );
    await expectMarketingError(
      as(t, identityInput).query(api.v1.orgs.me, {}),
      "INVALID_TOKEN_CLAIMS",
    );
    expect(await orgCount(t)).toBe(0);
  });

  it("the same organization id under another issuer is a different tenant", async () => {
    const t = await clerkBackend();
    await registerApp(t, ISSUER_ERP, "erp");
    const viaClerk = await as(t, ACME_ADMIN).mutation(api.v1.orgs.ensure, {});
    const viaErp = await as(t, { ...ACME_ADMIN, issuer: ISSUER_ERP, role: "admin" }).mutation(
      api.v1.orgs.ensure,
      {},
    );
    expect(viaErp.id).not.toBe(viaClerk.id);
  });
});

describe("organization name follows Clerk (D6)", () => {
  async function auditActions(t: Backend) {
    const { page } = await as(t, ACME_ADMIN).query(api.v1.audit.list, {
      paginationOpts: { cursor: null, numItems: 20 },
    });
    return page;
  }

  it("a changed org_name renames the organization, audited", async () => {
    const t = await clerkBackend();
    await as(t, ACME_ADMIN).mutation(api.v1.orgs.ensure, {});
    const renamed = await as(t, { ...ACME_ADMIN, orgName: "Acme Inc" }).mutation(
      api.v1.orgs.ensure,
      {},
    );
    expect(renamed.displayName).toBe("Acme Inc");
    const entry = (await auditActions(t)).find((e) => e.action === "org.renamed");
    expect(entry?.changes).toEqual({ displayName: { from: "Acme", to: "Acme Inc" } });
    expect(entry?.subject).toBe("user_2alice");
  });

  it("no claim, an unchanged name or an invalid name changes nothing", async () => {
    const t = await clerkBackend();
    await as(t, ACME_ADMIN).mutation(api.v1.orgs.ensure, {});
    for (const orgName of [undefined, "Acme", "  ", "x".repeat(121)]) {
      const org = await as(t, { ...ACME_ADMIN, orgName }).mutation(api.v1.orgs.ensure, {});
      expect(org.displayName).toBe("Acme");
    }
    expect((await auditActions(t)).filter((e) => e.action === "org.renamed")).toEqual([]);
  });

  it("an in-app rename is replaced by Clerk's name on the next request that carries it", async () => {
    const t = await clerkBackend();
    await as(t, ACME_ADMIN).mutation(api.v1.orgs.ensure, {});
    await as(t, { ...ACME_ADMIN, orgName: undefined }).mutation(api.v1.orgs.updateSettings, {
      displayName: "Local name",
    });
    expect((await as(t, ACME_ADMIN).mutation(api.v1.orgs.ensure, {})).displayName).toBe("Acme");
  });
});

describe("the dev issuer on a cloud deployment", () => {
  const DEV = { issuer: DEV_ISSUER, sub: "dev-user", org: "dev-org", role: "admin" };

  it("is refused even when it is registered", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-otter-123.convex.cloud");
    const t = newBackend();
    await registerApp(t, DEV_ISSUER, "dev");
    await expectMarketingError(as(t, DEV).mutation(api.v1.orgs.ensure, {}), "UNAUTHENTICATED");
    expect(await orgCount(t)).toBe(0);
  });

  it("keeps working on the local backend", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
    const t = newBackend();
    await registerApp(t, DEV_ISSUER, "dev");
    expect(await as(t, DEV).mutation(api.v1.orgs.ensure, {})).toMatchObject({ role: "admin" });
  });
});

describe("new connections stay closed on cloud until S2 (D8)", () => {
  async function begin(t: Backend) {
    return await as(t, ACME_ADMIN).action(api.v1.connections.beginConnect, {
      provider: "meta",
      returnUrl: RETURN_URL,
    });
  }
  async function stateCount(t: Backend) {
    return await t.run(async (ctx) => (await ctx.db.query("oauthStates").collect()).length);
  }

  it.each([undefined, "", "TRUE", "1", "yes", " true"])(
    "a cloud deployment refuses beginConnect (OAUTH_CONNECTIONS_ENABLED=%j) before any OAuth state",
    async (flag) => {
      vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-otter-123.convex.cloud");
      vi.stubEnv("PROVIDER_MODE", "mock");
      if (flag !== undefined) vi.stubEnv("OAUTH_CONNECTIONS_ENABLED", flag);
      const t = await clerkBackend();
      await setupSyncOrg(t, ACME_ADMIN);
      let caught: unknown;
      try {
        await begin(t);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        data: {
          code: "INVALID_ARGUMENT",
          details: { field: "provider", reason: "connections_disabled" },
        },
      });
      expect(await stateCount(t)).toBe(0);
    },
  );

  it("a cloud deployment with OAUTH_CONNECTIONS_ENABLED=true starts the connection", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-otter-123.convex.cloud");
    vi.stubEnv("PROVIDER_MODE", "mock");
    vi.stubEnv("OAUTH_CONNECTIONS_ENABLED", "true");
    const t = await clerkBackend();
    await setupSyncOrg(t, ACME_ADMIN);
    expect((await begin(t)).authorizeUrl).toMatch(/^https?:\/\//);
    expect(await stateCount(t)).toBe(1);
  });

  it("the local backend is unaffected", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
    const t = await clerkBackend();
    await setupSyncOrg(t, ACME_ADMIN);
    expect((await begin(t)).authorizeUrl).toMatch(/^https?:\/\//);
  });
});
