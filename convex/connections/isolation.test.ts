import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { credentialAad, decryptJson, DecryptionError, loadKeyRing } from "../lib/crypto";
import { orgScopeFromOrganization } from "../mapping/scope";
import {
  as,
  claimCodeOf,
  claimResult,
  expectMarketingError,
  followCallback,
  ISSUER_CRM,
  ISSUER_ERP,
  newBackend,
  redirectParams,
  registerAppWithReturnUrls,
  RETURN_URL,
  type Backend,
} from "../test.helpers";

const ERP = { issuer: ISSUER_ERP, org: "42", sub: "erp-admin" };
const CRM = { issuer: ISSUER_CRM, org: "42", sub: "crm-admin" };

async function setup() {
  const t = newBackend();
  await registerAppWithReturnUrls(t, ISSUER_ERP, "erp");
  await registerAppWithReturnUrls(t, ISSUER_CRM, "crm");
  await as(t, ERP).mutation(api.v1.orgs.ensure, {});
  await as(t, CRM).mutation(api.v1.orgs.ensure, {});
  return t;
}

async function connectAs(t: Backend, who: typeof ERP, provider: "meta" | "google_ads" = "meta") {
  const { authorizeUrl } = await as(t, who).action(api.v1.connections.beginConnect, {
    provider,
    returnUrl: RETURN_URL,
  });
  const response = await followCallback(t, authorizeUrl);
  const params = await claimResult(t, redirectParams(response), who);
  return { connectionId: params.get("connection")!, authorizeUrl, response };
}

describe("cross-tenant isolation", () => {
  it("another tenant cannot read or change a connection (NOT_FOUND everywhere)", async () => {
    const t = await setup();
    const { connectionId } = await connectAs(t, ERP);
    const [account] = await as(t, ERP).mutation(api.v1.connections.linkAdAccounts, {
      connectionId,
      externalIds: ["1001"],
    });
    const crm = as(t, CRM);

    await expectMarketingError(crm.query(api.v1.connections.get, { connectionId }), "NOT_FOUND");
    await expectMarketingError(
      crm.query(api.v1.connections.listDiscoveredAssets, { connectionId }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      crm.mutation(api.v1.connections.linkAdAccounts, { connectionId, externalIds: ["1001"] }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      crm.mutation(api.v1.connections.unlinkAdAccount, { adAccountId: account!.id }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      crm.mutation(api.v1.connections.refreshAssets, { connectionId }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      crm.mutation(api.v1.connections.disconnect, { connectionId }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      crm.action(api.v1.connections.beginConnect, {
        provider: "meta",
        returnUrl: RETURN_URL,
        reconnectConnectionId: connectionId,
      }),
      "NOT_FOUND",
    );
    expect(await crm.query(api.v1.connections.list, {})).toEqual([]);
    expect(await crm.query(api.v1.adAccounts.list, {})).toEqual([]);
    // ERP is untouched.
    expect((await as(t, ERP).query(api.v1.connections.get, { connectionId })).status).toBe(
      "active",
    );
  });

  it("a grant can only become a connection in the org that created the state (S2)", async () => {
    const t = await setup();
    const { authorizeUrl } = await as(t, ERP).action(api.v1.connections.beginConnect, {
      provider: "meta",
      returnUrl: RETURN_URL,
    });
    // Whoever completes the browser flow, nothing is connected until the initiator claims;
    // another tenant presenting the claim code is refused and the grant is invalidated.
    const claim = claimCodeOf(await followCallback(t, authorizeUrl));
    await expectMarketingError(
      as(t, CRM).action(api.v1.connections.completeConnect, { claim }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      as(t, ERP).action(api.v1.connections.completeConnect, { claim }),
      "NOT_FOUND",
    );
    expect(await as(t, ERP).query(api.v1.connections.list, {})).toHaveLength(0);
    expect(await as(t, CRM).query(api.v1.connections.list, {})).toHaveLength(0);
  });

  it("the same platform identity in two orgs gives two connections whose credentials are not interchangeable", async () => {
    const t = await setup();
    const erp = await connectAs(t, ERP);
    const crm = await connectAs(t, CRM);
    expect(erp.connectionId).not.toBe(crm.connectionId);

    const rows = await t.run(async (ctx) => ({
      connections: await ctx.db.query("connections").collect(),
      credentials: await ctx.db.query("credentials").collect(),
    }));
    expect(rows.connections).toHaveLength(2);
    expect(rows.credentials).toHaveLength(2);
    expect(rows.connections[0]!.externalUserId).toBe(rows.connections[1]!.externalUserId);

    const ring = await loadKeyRing();
    const [erpConn, crmConn] = [
      rows.connections.find((c) => c._id === erp.connectionId)!,
      rows.connections.find((c) => c._id === crm.connectionId)!,
    ];
    const erpCredential = rows.credentials.find((c) => c.connectionId === erpConn._id)!;
    // Correct binding decrypts; moving ERP's ciphertext under CRM's binding fails.
    expect(
      await decryptJson(
        ring,
        erpCredential,
        credentialAad(erpConn.orgId, "meta", erpConn.externalUserId),
      ),
    ).toMatchObject({
      kind: "mock",
    });
    await expect(
      decryptJson(
        ring,
        erpCredential,
        credentialAad(crmConn.orgId, "meta", crmConn.externalUserId),
      ),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it("the same external ad account linked by two orgs stays two rows", async () => {
    const t = await setup();
    const erp = await connectAs(t, ERP);
    const crm = await connectAs(t, CRM);
    const [a] = await as(t, ERP).mutation(api.v1.connections.linkAdAccounts, {
      connectionId: erp.connectionId,
      externalIds: ["1001"],
    });
    const [b] = await as(t, CRM).mutation(api.v1.connections.linkAdAccounts, {
      connectionId: crm.connectionId,
      externalIds: ["1001"],
    });
    expect(a!.id).not.toBe(b!.id);
    expect(await as(t, ERP).query(api.v1.adAccounts.list, {})).toHaveLength(1);
    expect(await as(t, CRM).query(api.v1.adAccounts.list, {})).toHaveLength(1);
  });

  it("organization-derived scopes are frozen and carry only the stored org id", async () => {
    const t = await setup();
    const org = (await t.run((ctx) => ctx.db.query("organizations").first()))!;
    const scope = orgScopeFromOrganization(org);
    expect(scope).toEqual({ orgId: org._id });
    expect(Object.isFrozen(scope)).toBe(true);
  });
});

describe("secret-leak prevention", () => {
  it("no public output, audit entry or redirect contains credential material", async () => {
    const t = await setup();
    const { connectionId, authorizeUrl, response } = await connectAs(t, ERP);
    const authorize = new URL(authorizeUrl);
    const secrets = await t.run(async (ctx) => {
      const state = (await ctx.db.query("oauthStates").first())!;
      return [
        "mock-token", // plaintext credential prefix
        authorize.searchParams.get("state")!, // raw nonce
        authorize.searchParams.get("code")!, // authorization code
        state.codeVerifier!, // PKCE verifier
        state.nonceHash, // stored nonce hash
      ];
    });

    const erp = as(t, ERP);
    const [account] = await erp.mutation(api.v1.connections.linkAdAccounts, {
      connectionId,
      externalIds: ["1001"],
    });
    const outputs = [
      await erp.query(api.v1.connections.list, {}),
      await erp.query(api.v1.connections.get, { connectionId }),
      await erp.query(api.v1.connections.listDiscoveredAssets, { connectionId }),
      await erp.query(api.v1.adAccounts.list, {}),
      account,
      await erp.query(api.v1.audit.list, { paginationOpts: { numItems: 100, cursor: null } }),
      await erp.mutation(api.v1.connections.unlinkAdAccount, { adAccountId: account!.id }),
      await erp.mutation(api.v1.connections.disconnect, { connectionId }),
      response.headers.get("location"),
    ];
    const serialized = JSON.stringify(outputs);
    for (const secret of secrets)
      expect(serialized, `leaked: ${secret.slice(0, 12)}…`).not.toContain(secret);
    for (const field of [
      "ciphertext",
      "codeVerifier",
      "nonceHash",
      "accessToken",
      "refreshToken",
    ]) {
      expect(serialized).not.toContain(field);
    }
  });

  it("stores only ciphertext at rest", async () => {
    const t = await setup();
    await connectAs(t, ERP);
    const [credential] = await t.run((ctx) => ctx.db.query("credentials").collect());
    const raw = new TextDecoder("latin1").decode(credential!.ciphertext);
    expect(raw).not.toContain("mock-token");
    expect(raw).not.toContain("mock");
    expect(credential!.iv.byteLength).toBe(12);
  });
});
