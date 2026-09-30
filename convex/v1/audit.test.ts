import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { getOwned } from "../lib/tenancy";
import {
  as,
  expectMarketingError,
  ISSUER_CRM,
  ISSUER_ERP,
  newBackend,
  registerApp,
} from "../test.helpers";

const firstPage = { paginationOpts: { numItems: 50, cursor: null } };

async function setup() {
  const t = newBackend();
  await registerApp(t, ISSUER_ERP, "erp");
  await registerApp(t, ISSUER_CRM, "crm");
  return t;
}

describe("audit log", () => {
  it("records provisioning and settings changes with actor and diff", async () => {
    const t = await setup();
    const admin = as(t, { sub: "alice" });
    await admin.mutation(api.v1.orgs.ensure, {});
    await admin.mutation(api.v1.orgs.updateSettings, { timezone: "Asia/Kolkata" });

    const { page } = await admin.query(api.v1.audit.list, firstPage);
    expect(page.map((e) => e.action)).toEqual(["org.settings.updated", "org.provisioned"]);
    expect(page[0]).toMatchObject({
      subject: "alice",
      targetType: "organization",
      changes: { timezone: { from: "UTC", to: "Asia/Kolkata" } },
    });
    expect(Object.keys(page[0]!)).not.toContain("orgId");
  });

  it("does not write an entry when settings are unchanged", async () => {
    const t = await setup();
    const admin = as(t);
    await admin.mutation(api.v1.orgs.updateSettings, { timezone: "UTC" });
    const { page } = await admin.query(api.v1.audit.list, firstPage);
    expect(page.map((e) => e.action)).toEqual(["org.provisioned"]);
  });

  it("is admin only", async () => {
    const t = await setup();
    await as(t).mutation(api.v1.orgs.ensure, {});
    await expectMarketingError(
      as(t, { role: "editor" }).query(api.v1.audit.list, firstPage),
      "FORBIDDEN",
    );
    await expectMarketingError(
      as(t, { role: "viewer" }).query(api.v1.audit.list, firstPage),
      "FORBIDDEN",
    );
  });

  it("only returns the caller's tenant entries", async () => {
    const t = await setup();
    const erp = as(t, { issuer: ISSUER_ERP, org: "42", sub: "erp-admin" });
    const crm = as(t, { issuer: ISSUER_CRM, org: "42", sub: "crm-admin" });
    await erp.mutation(api.v1.orgs.updateSettings, { timezone: "Europe/Paris" });
    await crm.mutation(api.v1.orgs.ensure, {});

    const erpEntries = (await erp.query(api.v1.audit.list, firstPage)).page;
    const crmEntries = (await crm.query(api.v1.audit.list, firstPage)).page;
    expect(erpEntries.every((e) => e.subject === "erp-admin")).toBe(true);
    expect(crmEntries.every((e) => e.subject === "crm-admin")).toBe(true);
    expect(crmEntries).toHaveLength(1);
  });

  it("paginates and caps page size", async () => {
    const t = await setup();
    const admin = as(t);
    for (const tz of ["Europe/Paris", "Europe/Berlin", "Asia/Tokyo"]) {
      await admin.mutation(api.v1.orgs.updateSettings, { timezone: tz });
    }
    const one = await admin.query(api.v1.audit.list, {
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(one.page).toHaveLength(2);
    expect(one.isDone).toBe(false);
    const two = await admin.query(api.v1.audit.list, {
      paginationOpts: { numItems: 2, cursor: one.continueCursor },
    });
    expect(two.page).toHaveLength(2);

    const huge = await admin.query(api.v1.audit.list, {
      paginationOpts: { numItems: 10_000, cursor: null },
    });
    expect(huge.page.length).toBeLessThanOrEqual(100);
  });
});

describe("getOwned", () => {
  it("returns NOT_FOUND for another tenant's row and for malformed ids", async () => {
    const t = await setup();
    const erp = as(t, { issuer: ISSUER_ERP });
    const crm = as(t, { issuer: ISSUER_CRM });
    await erp.mutation(api.v1.orgs.ensure, {});
    const crmOrg = await crm.mutation(api.v1.orgs.ensure, {});

    const [erpEntryId, erpOrgId] = await t.run(async (ctx) => {
      const erpOrg = (await ctx.db.query("organizations").collect()).find(
        (o) => o.issuer === ISSUER_ERP,
      )!;
      const entry = await ctx.db
        .query("auditLog")
        .withIndex("by_org_at", (q) => q.eq("orgId", erpOrg._id))
        .first();
      return [entry!._id, erpOrg._id] as const;
    });

    const tenantFor = (orgId: string) => ({
      orgId: orgId as never,
      appId: "x" as never,
      issuer: "",
      externalOrgId: "42",
      subject: "s",
      role: "admin" as const,
    });

    await t.run(async (ctx) => {
      const own = await getOwned(
        { db: ctx.db, tenant: tenantFor(erpOrgId) },
        "auditLog",
        erpEntryId,
      );
      expect(own._id).toBe(erpEntryId);
    });
    await expectMarketingError(
      t.run((ctx) =>
        getOwned({ db: ctx.db, tenant: tenantFor(crmOrg.id) }, "auditLog", erpEntryId),
      ),
      "NOT_FOUND",
    );
    await expectMarketingError(
      t.run((ctx) =>
        getOwned({ db: ctx.db, tenant: tenantFor(erpOrgId) }, "auditLog", "not-an-id"),
      ),
      "NOT_FOUND",
    );
  });
});
