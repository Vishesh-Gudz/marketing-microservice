import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { as, ISSUER_CRM, ISSUER_ERP, newBackend, seedOrg, type Backend } from "../test.helpers";

// C1: the one-time switch of organizations still on the old USD/UTC defaults, never configured,
// to the INR/Asia/Kolkata defaults.

async function settingsOf(t: Backend, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const org = await ctx.db.get(orgId);
    return { reportingCurrency: org!.reportingCurrency, timezone: org!.timezone };
  });
}

async function auditOf(t: Backend, orgId: Id<"organizations">) {
  return await t.run(
    async (ctx) =>
      await ctx.db
        .query("auditLog")
        .withIndex("by_org_at", (q) => q.eq("orgId", orgId))
        .collect(),
  );
}

/** Three organizations: untouched (USD/UTC), deliberately configured back to USD/UTC, other. */
async function threeOrgs() {
  const t = newBackend();
  const untouched = await seedOrg(t, ISSUER_ERP, "untouched");
  const configured = await seedOrg(t, ISSUER_ERP, "configured");
  const other = await seedOrg(t, ISSUER_CRM, "other");
  const admin = as(t, { org: "configured" });
  await admin.mutation(api.v1.orgs.updateSettings, { reportingCurrency: "EUR" });
  await admin.mutation(api.v1.orgs.updateSettings, { reportingCurrency: "USD" });
  await t.run(async (ctx) => {
    await ctx.db.patch(other, { reportingCurrency: "GBP", timezone: "Europe/London" });
  });
  return { t, untouched, configured, other };
}

describe("admin/orgDefaults:switchUntouched", () => {
  it("lists the untouched organizations in a dry run and changes nothing", async () => {
    const { t, untouched, configured } = await threeOrgs();
    const result = await t.mutation(internal.admin.orgDefaults.switchUntouched, { dryRun: true });
    expect(result).toMatchObject({
      dryRun: true,
      checked: 3,
      switched: [{ id: untouched, displayName: "untouched" }],
      keptConfigured: [{ id: configured, displayName: "configured" }],
      isDone: true,
    });
    expect(await settingsOf(t, untouched)).toEqual({ reportingCurrency: "USD", timezone: "UTC" });
    expect(await auditOf(t, untouched)).toEqual([]);
  });

  it("switches only untouched USD/UTC organizations, audited, and only once", async () => {
    const { t, untouched, configured, other } = await threeOrgs();
    const first = await t.mutation(internal.admin.orgDefaults.switchUntouched, { dryRun: false });
    expect(first.switched).toEqual([{ id: untouched, displayName: "untouched" }]);

    expect(await settingsOf(t, untouched)).toEqual({
      reportingCurrency: "INR",
      timezone: "Asia/Kolkata",
    });
    expect(await settingsOf(t, configured)).toEqual({ reportingCurrency: "USD", timezone: "UTC" });
    expect(await settingsOf(t, other)).toEqual({
      reportingCurrency: "GBP",
      timezone: "Europe/London",
    });

    const audit = await auditOf(t, untouched);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "org.settings.updated",
      issuer: ISSUER_ERP,
      subject: "system:org-defaults",
      targetType: "organization",
      targetId: untouched,
      changes: {
        reportingCurrency: { from: "USD", to: "INR" },
        timezone: { from: "UTC", to: "Asia/Kolkata" },
      },
    });

    // The switched organization now has a settings entry and other values: nothing to do.
    const second = await t.mutation(internal.admin.orgDefaults.switchUntouched, { dryRun: false });
    expect(second.switched).toEqual([]);
    expect(await auditOf(t, untouched)).toHaveLength(1);
  });

  it("reads the organizations in pages", async () => {
    const { t, untouched } = await threeOrgs();
    const switched: string[] = [];
    let cursor: string | null = null;
    let calls = 0;
    for (;;) {
      const page: { switched: { id: string }[]; isDone: boolean; continueCursor: string } =
        await t.mutation(internal.admin.orgDefaults.switchUntouched, {
          dryRun: false,
          cursor,
          batch: 1,
        });
      calls++;
      switched.push(...page.switched.map((org) => org.id));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(switched).toEqual([untouched]);
  });

  it.each([0, 201, 1.5])("refuses a batch of %s", async (batch) => {
    const t = newBackend();
    await expect(
      t.mutation(internal.admin.orgDefaults.switchUntouched, { dryRun: true, batch }),
    ).rejects.toThrow(/batch must be an integer from 1 to 200/);
  });
});
