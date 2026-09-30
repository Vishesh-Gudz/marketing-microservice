import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import {
  as,
  expectMarketingError,
  ISSUER_CRM,
  ISSUER_ERP,
  newBackend,
  registerApp,
} from "../test.helpers";

async function setup() {
  const t = newBackend();
  await registerApp(t, ISSUER_ERP, "erp");
  await registerApp(t, ISSUER_CRM, "crm");
  return t;
}

describe("authentication", () => {
  it("rejects every v1 function without a token", async () => {
    const t = await setup();
    await expectMarketingError(t.mutation(api.v1.orgs.ensure, {}), "UNAUTHENTICATED");
    await expectMarketingError(t.query(api.v1.orgs.me, {}), "UNAUTHENTICATED");
    await expectMarketingError(
      t.mutation(api.v1.orgs.updateSettings, { timezone: "UTC" }),
      "UNAUTHENTICATED",
    );
    await expectMarketingError(
      t.query(api.v1.audit.list, { paginationOpts: { numItems: 10, cursor: null } }),
      "UNAUTHENTICATED",
    );
  });

  it("keeps health.ping public", async () => {
    const t = await setup();
    await expect(t.query(api.health.ping, {})).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ["missing org_id", { org: null }],
    ["invalid org_id", { org: "has spaces" }],
    ["overlong org_id", { org: "x".repeat(129) }],
    ["missing org_role", { role: null }],
    ["unknown org_role", { role: "owner" }],
  ])("rejects tokens with %s", async (_label, input) => {
    const t = await setup();
    await expectMarketingError(
      as(t, input).mutation(api.v1.orgs.ensure, {}),
      "INVALID_TOKEN_CLAIMS",
    );
  });
});

describe("integration app registry", () => {
  it("rejects issuers that are not registered", async () => {
    const t = await setup();
    await expectMarketingError(
      as(t, { issuer: "https://unknown.example.test" }).mutation(api.v1.orgs.ensure, {}),
      "APP_NOT_REGISTERED",
    );
  });

  it("rejects disabled apps and recovers when re-enabled", async () => {
    const t = await setup();
    const erp = as(t, { issuer: ISSUER_ERP });
    await erp.mutation(api.v1.orgs.ensure, {});

    await registerApp(t, ISSUER_ERP, "erp", "disabled");
    await expectMarketingError(erp.query(api.v1.orgs.me, {}), "APP_DISABLED");
    await expectMarketingError(erp.mutation(api.v1.orgs.ensure, {}), "APP_DISABLED");

    const { internal } = await import("../_generated/api");
    await t.mutation(internal.admin.integrationApps.setStatus, {
      issuer: ISSUER_ERP,
      status: "active",
    });
    await expect(erp.query(api.v1.orgs.me, {})).resolves.toMatchObject({ externalOrgId: "42" });
  });
});

describe("provisioning", () => {
  it("requires ensure before org queries", async () => {
    const t = await setup();
    await expectMarketingError(as(t).query(api.v1.orgs.me, {}), "ORG_NOT_PROVISIONED");
  });

  it("is idempotent and uses org_name as the initial display name", async () => {
    const t = await setup();
    const first = await as(t, { orgName: "Acme Retail" }).mutation(api.v1.orgs.ensure, {});
    const second = await as(t, { sub: "user_2", role: "viewer" }).mutation(api.v1.orgs.ensure, {});

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      externalOrgId: "42",
      issuer: ISSUER_ERP,
      displayName: "Acme Retail",
      reportingCurrency: "USD",
      timezone: "UTC",
      role: "admin",
    });
    expect(second.role).toBe("viewer");

    const orgCount = await t.run(
      async (ctx) => (await ctx.db.query("organizations").collect()).length,
    );
    expect(orgCount).toBe(1);
  });

  it("provisions exactly once under concurrent first calls", async () => {
    const t = await setup();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => as(t, { sub: `u${i}` }).mutation(api.v1.orgs.ensure, {})),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    const orgCount = await t.run(
      async (ctx) => (await ctx.db.query("organizations").collect()).length,
    );
    expect(orgCount).toBe(1);
  });

  it("returns DTOs without internal fields", async () => {
    const t = await setup();
    const org = await as(t).mutation(api.v1.orgs.ensure, {});
    expect(Object.keys(org).sort()).toEqual(
      [
        "createdAt",
        "displayName",
        "externalOrgId",
        "id",
        "issuer",
        "reportingCurrency",
        "role",
        "timezone",
        "updatedAt",
      ].sort(),
    );
    expect(org.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("tenant isolation", () => {
  it("treats the same org_id from different issuers as different tenants", async () => {
    const t = await setup();
    const erp = as(t, { issuer: ISSUER_ERP, org: "42" });
    const crm = as(t, { issuer: ISSUER_CRM, org: "42" });

    const erpOrg = await erp.mutation(api.v1.orgs.ensure, {});
    const crmOrg = await crm.mutation(api.v1.orgs.ensure, {});
    expect(erpOrg.id).not.toBe(crmOrg.id);

    await erp.mutation(api.v1.orgs.updateSettings, { displayName: "ERP tenant" });
    expect((await crm.query(api.v1.orgs.me, {})).displayName).toBe("42");
    expect((await erp.query(api.v1.orgs.me, {})).displayName).toBe("ERP tenant");
  });

  it("separates different org_ids from the same issuer", async () => {
    const t = await setup();
    const a = await as(t, { org: "a" }).mutation(api.v1.orgs.ensure, {});
    const b = await as(t, { org: "b" }).mutation(api.v1.orgs.ensure, {});
    expect(a.id).not.toBe(b.id);
  });
});

describe("updateSettings", () => {
  it.each(["viewer", "editor"] as const)("forbids %s", async (role) => {
    const t = await setup();
    await as(t).mutation(api.v1.orgs.ensure, {});
    await expectMarketingError(
      as(t, { role }).mutation(api.v1.orgs.updateSettings, { timezone: "Europe/Berlin" }),
      "FORBIDDEN",
    );
  });

  it("lets admins update settings and returns the new DTO", async () => {
    const t = await setup();
    const updated = await as(t).mutation(api.v1.orgs.updateSettings, {
      displayName: "  Acme  ",
      reportingCurrency: "EUR",
      timezone: "Europe/Berlin",
    });
    expect(updated).toMatchObject({
      displayName: "Acme",
      reportingCurrency: "EUR",
      timezone: "Europe/Berlin",
    });
  });

  it.each([
    [{ reportingCurrency: "usd" }, "reportingCurrency"],
    [{ reportingCurrency: "XYZ" }, "reportingCurrency"],
    [{ timezone: "Mars/Olympus" }, "timezone"],
    [{ displayName: "   " }, "displayName"],
    [{}, undefined],
  ])("rejects invalid input %j", async (args, _field) => {
    const t = await setup();
    await expectMarketingError(
      as(t).mutation(api.v1.orgs.updateSettings, args),
      "INVALID_ARGUMENT",
    );
  });

  it("rejects fields that are not part of the contract (e.g. orgId)", async () => {
    const t = await setup();
    await expect(
      as(t).mutation(api.v1.orgs.updateSettings, {
        timezone: "UTC",
        // @ts-expect-error: tenant identity can never be passed as an argument
        orgId: "someone-else",
      }),
    ).rejects.toThrow();
  });
});
