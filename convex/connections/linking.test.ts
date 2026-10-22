import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { mockAuthorizationCode } from "../providers/mock/oauth";
import {
  as,
  claimResult,
  expectMarketingError,
  followCallback,
  ISSUER_ERP,
  newBackend,
  redirectParams,
  registerAppWithReturnUrls,
  RETURN_URL,
  type Backend,
} from "../test.helpers";

async function setup() {
  const t = newBackend();
  await registerAppWithReturnUrls(t, ISSUER_ERP, "erp");
  await as(t).mutation(api.v1.orgs.ensure, {});
  return t;
}

async function connect(t: Backend, provider: "meta" | "google_ads" = "meta", user = "1") {
  const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
    provider,
    returnUrl: RETURN_URL,
  });
  const url = new URL(authorizeUrl);
  url.searchParams.set(
    "code",
    mockAuthorizationCode(provider, url.searchParams.get("code_challenge")!, user),
  );
  return (await claimResult(t, redirectParams(await followCallback(t, url.toString())))).get(
    "connection",
  )!;
}

const accountRows = (t: Backend) => t.run((ctx) => ctx.db.query("adAccounts").collect());
const auditActions = async (t: Backend) =>
  (
    await as(t).query(api.v1.audit.list, { paginationOpts: { numItems: 100, cursor: null } })
  ).page.map((e) => e.action);

describe("linking discovered accounts", () => {
  it("links a discovered account into the canonical adAccounts table", async () => {
    const t = await setup();
    const connectionId = await connect(t);
    const [dto] = await as(t).mutation(api.v1.connections.linkAdAccounts, {
      connectionId,
      externalIds: ["1001"],
    });
    expect(dto).toMatchObject({
      platform: "meta",
      externalId: "1001",
      currency: "USD",
      timezone: "America/New_York",
      linked: true,
      connectionId,
    });
    const [row] = await accountRows(t);
    expect(row).toMatchObject({ connectionId, isManager: false, name: "Acme Retail US" });
    expect(row!.linkedAt).toBeDefined();
    expect(await auditActions(t)).toContain("adAccount.linked");

    const assets = await as(t).query(api.v1.connections.listDiscoveredAssets, { connectionId });
    expect(assets.find((a) => a.externalId === "1001")?.linked).toBe(true);
    expect(assets.find((a) => a.externalId === "1002")?.linked).toBe(false);
  });

  it("is idempotent and never duplicates a natural key, even concurrently", async () => {
    const t = await setup();
    const connectionId = await connect(t);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        as(t).mutation(api.v1.connections.linkAdAccounts, {
          connectionId,
          externalIds: ["1001", "1002"],
        }),
      ),
    );
    const rows = await accountRows(t);
    expect(rows.map((r) => r.externalId).sort()).toEqual(["1001", "1002"]);
    expect((await auditActions(t)).filter((a) => a === "adAccount.linked")).toHaveLength(2);
  });

  it("only links ids discovered by that connection, never manager accounts", async () => {
    const t = await setup();
    const metaConnection = await connect(t, "meta");
    const googleConnection = await connect(t, "google_ads");
    await expectMarketingError(
      as(t).mutation(api.v1.connections.linkAdAccounts, {
        connectionId: metaConnection,
        externalIds: ["9999"],
      }),
      "NOT_FOUND",
    );
    // A Google account id is not linkable through the Meta connection.
    await expectMarketingError(
      as(t).mutation(api.v1.connections.linkAdAccounts, {
        connectionId: metaConnection,
        externalIds: ["1112223333"],
      }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      as(t).mutation(api.v1.connections.linkAdAccounts, {
        connectionId: googleConnection,
        externalIds: ["9990001111"],
      }),
      "INVALID_ARGUMENT",
    );
    for (const externalIds of [[], Array.from({ length: 51 }, (_, i) => String(i))]) {
      await expectMarketingError(
        as(t).mutation(api.v1.connections.linkAdAccounts, {
          connectionId: metaConnection,
          externalIds,
        }),
        "INVALID_ARGUMENT",
      );
    }
    expect(await accountRows(t)).toHaveLength(0);
  });

  it("relinks an account to another connection of the same org and audits it", async () => {
    const t = await setup();
    const first = await connect(t, "meta", "1");
    const second = await connect(t, "meta", "2");
    expect(second).not.toBe(first);
    await as(t).mutation(api.v1.connections.linkAdAccounts, {
      connectionId: first,
      externalIds: ["1001"],
    });
    const [relinked] = await as(t).mutation(api.v1.connections.linkAdAccounts, {
      connectionId: second,
      externalIds: ["1001"],
    });
    expect(relinked!.connectionId).toBe(second);
    expect(await accountRows(t)).toHaveLength(1);
    expect(await auditActions(t)).toContain("adAccount.relinked");
  });

  it("unlinks without deleting the account (idempotent)", async () => {
    const t = await setup();
    const connectionId = await connect(t);
    const [linked] = await as(t).mutation(api.v1.connections.linkAdAccounts, {
      connectionId,
      externalIds: ["1001"],
    });
    const unlinked = await as(t).mutation(api.v1.connections.unlinkAdAccount, {
      adAccountId: linked!.id,
    });
    expect(unlinked).toMatchObject({ id: linked!.id, linked: false });
    expect(unlinked).not.toHaveProperty("connectionId");
    expect(
      await as(t).mutation(api.v1.connections.unlinkAdAccount, { adAccountId: linked!.id }),
    ).toMatchObject({ linked: false });
    expect(await accountRows(t)).toHaveLength(1);
    expect((await as(t).query(api.v1.adAccounts.list, {}))[0]).toMatchObject({ linked: false });
  });

  it("refuses linking through a revoked connection", async () => {
    const t = await setup();
    const connectionId = await connect(t);
    await as(t).mutation(api.v1.connections.disconnect, { connectionId });
    await expectMarketingError(
      as(t).mutation(api.v1.connections.linkAdAccounts, { connectionId, externalIds: ["1001"] }),
      "CONFLICT",
    );
  });
});

describe("roles", () => {
  it.each(["viewer", "editor"] as const)("%s cannot change connections", async (role) => {
    const t = await setup();
    const connectionId = await connect(t);
    const [account] = await as(t).mutation(api.v1.connections.linkAdAccounts, {
      connectionId,
      externalIds: ["1001"],
    });
    const user = as(t, { role, sub: `${role}-user` });

    await expectMarketingError(
      user.action(api.v1.connections.beginConnect, { provider: "meta", returnUrl: RETURN_URL }),
      "FORBIDDEN",
    );
    await expectMarketingError(
      user.query(api.v1.connections.listDiscoveredAssets, { connectionId }),
      "FORBIDDEN",
    );
    await expectMarketingError(
      user.mutation(api.v1.connections.linkAdAccounts, { connectionId, externalIds: ["1002"] }),
      "FORBIDDEN",
    );
    await expectMarketingError(
      user.mutation(api.v1.connections.unlinkAdAccount, { adAccountId: account!.id }),
      "FORBIDDEN",
    );
    await expectMarketingError(
      user.mutation(api.v1.connections.refreshAssets, { connectionId }),
      "FORBIDDEN",
    );
    await expectMarketingError(
      user.mutation(api.v1.connections.disconnect, { connectionId }),
      "FORBIDDEN",
    );
  });

  it("viewers can see connections and ad accounts", async () => {
    const t = await setup();
    const connectionId = await connect(t);
    await as(t).mutation(api.v1.connections.linkAdAccounts, {
      connectionId,
      externalIds: ["1001"],
    });
    const viewer = as(t, { role: "viewer", sub: "viewer-user" });
    expect(await viewer.query(api.v1.connections.list, {})).toHaveLength(1);
    expect((await viewer.query(api.v1.connections.get, { connectionId })).id).toBe(connectionId);
    expect(await viewer.query(api.v1.adAccounts.list, {})).toHaveLength(1);
  });

  it("actions require authentication and a provisioned org", async () => {
    const t = await setup();
    await expectMarketingError(
      t.action(api.v1.connections.beginConnect, { provider: "meta", returnUrl: RETURN_URL }),
      "UNAUTHENTICATED",
    );
    await expectMarketingError(
      as(t, { org: "never-provisioned" }).action(api.v1.connections.beginConnect, {
        provider: "meta",
        returnUrl: RETURN_URL,
      }),
      "ORG_NOT_PROVISIONED",
    );
  });
});
