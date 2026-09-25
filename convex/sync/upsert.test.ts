import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { accountScopeFromDoc, orgScopeFromOrganization } from "../mapping/scope";
import type {
  ProviderAdAccount,
  ProviderAdGroup,
  ProviderCampaign,
  ProviderMetricRow,
} from "../providers/types";
import { ISSUER_CRM, newBackend, seedOrg, type Backend } from "../test.helpers";
import {
  accountDrift,
  pruneMetricsBatch,
  refreshAdAccount,
  type PruneCursor,
  upsertLinkedAdAccount,
  writeEntityPage,
  writeMetricPage,
} from "./upsert";

// The single canonical write path, exercised directly against the real schema.

const NOW = Date.parse("2026-04-10T12:00:00Z");

const accountRecord: ProviderAdAccount = {
  platform: "meta",
  externalId: "1001",
  name: "Acme",
  currency: "USD",
  timezone: "America/New_York",
  status: "active",
  isManager: false,
};

const campaign = (overrides: Partial<ProviderCampaign> = {}): ProviderCampaign => ({
  platform: "meta",
  accountExternalId: "1001",
  externalId: "111",
  name: "Campaign",
  status: "active",
  objective: "sales",
  budgetType: "daily",
  budgetMicros: 50_000_000n,
  budgetLevel: "campaign",
  ...overrides,
});

const metric = (overrides: Partial<ProviderMetricRow> = {}): ProviderMetricRow => ({
  platform: "meta",
  accountExternalId: "1001",
  entityExternalId: "1001",
  level: "account",
  date: "2026-04-05",
  placement: "all",
  currency: "USD",
  spendMicros: 1_000_000n,
  impressions: 0,
  ...overrides,
});

async function linkedAccount(t: Backend, issuer?: string, record = accountRecord) {
  const orgId = await seedOrg(t, issuer);
  return await t.run(async (ctx) => {
    const org = (await ctx.db.get(orgId))!;
    const connectionId = await ctx.db.insert("connections", {
      orgId,
      provider: record.platform,
      externalUserId: "u",
      status: "active",
      grantedScopes: [],
      credentialVersion: 1,
      connectedBySubject: "s",
      connectedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const { adAccountId } = await upsertLinkedAdAccount(
      ctx.db,
      orgScopeFromOrganization(org),
      record,
      connectionId,
      NOW,
    );
    return { orgId, connectionId, account: (await ctx.db.get(adAccountId))! };
  });
}

const scopeOf = (account: Doc<"adAccounts">) => accountScopeFromDoc(account);

describe("entities", () => {
  it("inserts, then replaces provider-owned fields and preserves createdAt", async () => {
    const t = newBackend();
    const { account } = await linkedAccount(t);
    await t.run((ctx) =>
      writeEntityPage(ctx.db, { kind: "campaign", items: [campaign()] }, scopeOf(account), NOW),
    );
    const later = NOW + 60_000;
    const counts = await t.run((ctx) =>
      writeEntityPage(
        ctx.db,
        // The platform stopped reporting the budget: the field must disappear (replace, not patch).
        { kind: "campaign", items: [campaign({ name: "Renamed", budgetMicros: undefined })] },
        scopeOf(account),
        later,
      ),
    );
    expect(counts).toMatchObject({ inserted: 0, updated: 1 });
    const [row] = await t.run((ctx) => ctx.db.query("campaigns").collect());
    expect(row).toMatchObject({
      name: "Renamed",
      createdAt: NOW,
      updatedAt: later,
      lastSeenAt: later,
    });
    expect(row).not.toHaveProperty("budgetMicros");
  });

  it("clears removedAt when a removed entity reappears", async () => {
    const t = newBackend();
    const { account } = await linkedAccount(t);
    await t.run((ctx) =>
      writeEntityPage(ctx.db, { kind: "campaign", items: [campaign()] }, scopeOf(account), NOW),
    );
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("campaigns").collect();
      await ctx.db.patch(row!._id, { removedAt: NOW });
    });
    const counts = await t.run((ctx) =>
      writeEntityPage(ctx.db, { kind: "campaign", items: [campaign()] }, scopeOf(account), NOW + 1),
    );
    expect(counts.reappeared).toBe(1);
    const [row] = await t.run((ctx) => ctx.db.query("campaigns").collect());
    expect(row!.removedAt).toBeUndefined();
  });

  it("enforces natural-key uniqueness and repairs duplicates (keeps the oldest)", async () => {
    const t = newBackend();
    const { account } = await linkedAccount(t);
    const scope = scopeOf(account);
    await t.run((ctx) =>
      writeEntityPage(ctx.db, { kind: "campaign", items: [campaign()] }, scope, NOW),
    );
    const [original] = await t.run((ctx) => ctx.db.query("campaigns").collect());
    // Simulate a duplicate that could only come from a bypassed write path.
    await t.run(async (ctx) => {
      const { _id: _i, _creationTime: _c, ...copy } = original!;
      await ctx.db.insert("campaigns", copy);
    });
    const counts = await t.run((ctx) =>
      writeEntityPage(ctx.db, { kind: "campaign", items: [campaign()] }, scope, NOW + 1),
    );
    expect(counts.duplicatesRepaired).toBe(1);
    const rows = await t.run((ctx) => ctx.db.query("campaigns").collect());
    expect(rows.map((r) => r._id)).toEqual([original!._id]);
  });

  it("never writes dangling references: unresolved parents are skipped and counted", async () => {
    const t = newBackend();
    const { account } = await linkedAccount(t);
    const group: ProviderAdGroup = {
      platform: "meta",
      accountExternalId: "1001",
      campaignExternalId: "999",
      externalId: "222",
      name: "Group",
      kind: "ad_set",
      status: "active",
    };
    const counts = await t.run((ctx) =>
      writeEntityPage(ctx.db, { kind: "adGroup", items: [group] }, scopeOf(account), NOW),
    );
    expect(counts).toMatchObject({ unresolved: 1, inserted: 0 });
    expect(await t.run((ctx) => ctx.db.query("adGroups").collect())).toHaveLength(0);
  });

  it("caps oversized attributes", async () => {
    const t = newBackend();
    const { account } = await linkedAccount(t);
    const attributes = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`a${i}`, "x"]));
    const counts = await t.run((ctx) =>
      writeEntityPage(
        ctx.db,
        { kind: "campaign", items: [campaign({ attributes })] },
        scopeOf(account),
        NOW,
      ),
    );
    expect(counts.truncated).toBe(20);
    const [row] = await t.run((ctx) => ctx.db.query("campaigns").collect());
    expect(Object.keys(row!.attributes!)).toHaveLength(50);
  });
});

describe("ad accounts", () => {
  it("refresh replaces provider fields and preserves connection linkage and createdAt", async () => {
    const t = newBackend();
    const { account, orgId, connectionId } = await linkedAccount(t);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(orgId))!;
      await refreshAdAccount(
        ctx.db,
        account,
        { ...accountRecord, name: "New name", status: "disabled", rawStatus: "2" },
        orgScopeFromOrganization(org),
        NOW + 5,
      );
    });
    const row = await t.run((ctx) => ctx.db.get(account._id));
    expect(row).toMatchObject({
      name: "New name",
      status: "disabled",
      connectionId,
      linkedAt: account.linkedAt,
      createdAt: account.createdAt,
      updatedAt: NOW + 5,
    });
  });

  it("detects currency, timezone and manager drift", () => {
    const account = { currency: "USD", timezone: "America/New_York" } as Doc<"adAccounts">;
    expect(accountDrift(account, accountRecord)).toBeUndefined();
    expect(accountDrift(account, { ...accountRecord, currency: "EUR" })).toBe("currency");
    expect(accountDrift(account, { ...accountRecord, timezone: "UTC" })).toBe("timezone");
    expect(accountDrift(account, { ...accountRecord, isManager: true })).toBe("manager");
  });

  it("keeps two orgs' copies of the same external account independent", async () => {
    const t = newBackend();
    const a = await linkedAccount(t);
    const b = await linkedAccount(t, ISSUER_CRM);
    expect(a.account._id).not.toBe(b.account._id);
    await t.run((ctx) =>
      writeEntityPage(ctx.db, { kind: "campaign", items: [campaign()] }, scopeOf(a.account), NOW),
    );
    await t.run((ctx) =>
      writeEntityPage(ctx.db, { kind: "campaign", items: [campaign()] }, scopeOf(b.account), NOW),
    );
    const rows = await t.run((ctx) => ctx.db.query("campaigns").collect());
    expect(rows.map((r) => r.orgId).sort()).toEqual([a.orgId, b.orgId].sort());
  });

  it("keeps Meta and Google accounts with the same external id apart", async () => {
    const t = newBackend();
    const orgId = await seedOrg(t);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(orgId))!;
      const connectionId = await ctx.db.insert("connections", {
        orgId,
        provider: "meta",
        externalUserId: "u",
        status: "active",
        grantedScopes: [],
        credentialVersion: 1,
        connectedBySubject: "s",
        connectedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const scope = orgScopeFromOrganization(org);
      await upsertLinkedAdAccount(
        ctx.db,
        scope,
        { ...accountRecord, externalId: "1234567890" },
        connectionId,
        NOW,
      );
      await upsertLinkedAdAccount(
        ctx.db,
        scope,
        { ...accountRecord, platform: "google_ads", externalId: "1234567890" },
        connectionId,
        NOW,
      );
    });
    expect(await t.run((ctx) => ctx.db.query("adAccounts").collect())).toHaveLength(2);
  });
});

describe("metrics", () => {
  it("replaces whole rows: missing stays missing, zero stays zero", async () => {
    const t = newBackend();
    const { account } = await linkedAccount(t);
    const scope = scopeOf(account);
    await t.run((ctx) =>
      writeMetricPage(
        ctx.db,
        { kind: "metricRow", items: [metric({ clicks: 7 })] },
        "account",
        scope,
        NOW,
      ),
    );
    // Restated row: clicks no longer reported, impressions still a reported zero.
    await t.run((ctx) =>
      writeMetricPage(ctx.db, { kind: "metricRow", items: [metric()] }, "account", scope, NOW + 1),
    );
    const rows = await t.run((ctx) => ctx.db.query("metricsDaily").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.impressions).toBe(0);
    expect(rows[0]).not.toHaveProperty("clicks");
    expect(rows[0]).not.toHaveProperty("reach");
    expect(rows[0]!.syncedAt).toBe(NOW + 1);
  });

  it("stores money above 2^53 micros exactly", async () => {
    const t = newBackend();
    const { account } = await linkedAccount(t);
    const huge = 2n ** 60n + 123_456_789n;
    await t.run((ctx) =>
      writeMetricPage(
        ctx.db,
        { kind: "metricRow", items: [metric({ spendMicros: huge })] },
        "account",
        scopeOf(account),
        NOW,
      ),
    );
    const [row] = await t.run((ctx) => ctx.db.query("metricsDaily").collect());
    expect(row!.spendMicros).toBe(huge);
  });

  it("counts rows of unknown entities as unresolved instead of writing them", async () => {
    const t = newBackend();
    const { account } = await linkedAccount(t);
    const counts = await t.run((ctx) =>
      writeMetricPage(
        ctx.db,
        { kind: "metricRow", items: [metric({ level: "campaign", entityExternalId: "777" })] },
        "campaign",
        scopeOf(account),
        NOW,
      ),
    );
    expect(counts).toMatchObject({ unresolved: 1, metricRows: 0 });
  });

  it("prunes only stale rows inside the completed scope", async () => {
    const t = newBackend();
    const { account } = await linkedAccount(t);
    const scope = scopeOf(account);
    await t.run((ctx) =>
      writeMetricPage(
        ctx.db,
        {
          kind: "metricRow",
          items: [
            metric({ date: "2026-04-05" }),
            metric({ date: "2026-04-06" }),
            metric({ date: "2026-03-01" }), // outside the pruned window
          ],
        },
        "account",
        scope,
        NOW,
      ),
    );
    // A later request rewrote only 04-05 (04-06 was restated away).
    await t.run((ctx) =>
      writeMetricPage(ctx.db, { kind: "metricRow", items: [metric()] }, "account", scope, NOW + 10),
    );
    let pruned = 0;
    let cursor: PruneCursor | undefined;
    do {
      const result = await t.run((ctx) =>
        pruneMetricsBatch(ctx.db, {
          table: "metricsDaily",
          scope,
          level: "account",
          placements: ["all"],
          from: "2026-04-01",
          to: "2026-04-10",
          before: NOW + 10,
          cursor,
          limit: 1,
        }),
      );
      pruned += result.pruned;
      cursor = result.next;
    } while (cursor !== undefined);
    expect(pruned).toBe(1);
    const dates = (await t.run((ctx) => ctx.db.query("metricsDaily").collect())).map((r) => r.date);
    expect(dates.sort()).toEqual(["2026-03-01", "2026-04-05"]);
  });
});

export type { Id };
