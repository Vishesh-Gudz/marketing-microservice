import type { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Base64Url } from "../lib/crypto";
import { isMarketingError, type MarketingErrorCode, type MarketingErrorData } from "../lib/errors";
import { mockAuthorizationCode } from "../providers/mock/oauth";
import {
  as,
  claimCodeOf,
  expectMarketingError,
  followCallback,
  type IdentityInput,
  ISSUER_CRM,
  ISSUER_ERP,
  newBackend,
  redirectParams,
  registerAppWithReturnUrls,
  RETURN_URL,
  type Backend,
} from "../test.helpers";
import { OAUTH_GRANT_TTL_MS } from "./config";

// S2: OAuth ownership. The callback is unauthenticated and whoever completes the platform
// consent may not be the user who started it (a forwarded authorization link). A consent
// therefore only produces a pending grant; it becomes a connection only when the SAME
// issuer + user, in the SAME org, claims it once before it expires.

/** The initiator: admin "admin-a" of ERP org "42". */
const INITIATOR: IdentityInput = { issuer: ISSUER_ERP, org: "42", sub: "admin-a" };
/** Another admin of the same org. */
const OTHER_USER: IdentityInput = { issuer: ISSUER_ERP, org: "42", sub: "admin-b" };
/** The same user id, in another org of the same app. */
const OTHER_ORG: IdentityInput = { issuer: ISSUER_ERP, org: "77", sub: "admin-a" };
/** The same user id and org id, from another integration app (another tenant). */
const OTHER_ISSUER: IdentityInput = { issuer: ISSUER_CRM, org: "42", sub: "admin-a" };

afterEach(() => {
  vi.unstubAllEnvs();
});

async function setup() {
  const t = newBackend();
  await registerAppWithReturnUrls(t, ISSUER_ERP, "erp");
  await registerAppWithReturnUrls(t, ISSUER_CRM, "crm");
  for (const who of [INITIATOR, OTHER_USER, OTHER_ORG, OTHER_ISSUER])
    await as(t, who).mutation(api.v1.orgs.ensure, {});
  return t;
}

/** beginConnect + mock consent + callback. Returns the redirect and its claim code. */
async function consent(
  t: Backend,
  {
    who = INITIATOR,
    provider = "meta",
    user = "1",
    reconnectConnectionId,
  }: {
    who?: IdentityInput;
    provider?: "meta" | "google_ads";
    user?: string;
    reconnectConnectionId?: string;
  } = {},
) {
  const { authorizeUrl } = await as(t, who).action(api.v1.connections.beginConnect, {
    provider,
    returnUrl: RETURN_URL,
    ...(reconnectConnectionId !== undefined ? { reconnectConnectionId } : {}),
  });
  const url = new URL(authorizeUrl);
  url.searchParams.set(
    "code",
    mockAuthorizationCode(provider, url.searchParams.get("code_challenge") ?? undefined, user),
  );
  const response = await followCallback(t, url.toString());
  return { authorizeUrl: url, response };
}

async function consentAndClaimCode(t: Backend, options: Parameters<typeof consent>[1] = {}) {
  return claimCodeOf((await consent(t, options)).response);
}

const complete = (t: Backend, who: IdentityInput, claim: string) =>
  as(t, who).action(api.v1.connections.completeConnect, { claim });

async function expectRefused(
  promise: Promise<unknown>,
  code: MarketingErrorCode,
  reason: "invalid_claim" | "expired_claim" | "identity_mismatch",
) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(isMarketingError(caught), String(caught)).toBe(true);
  const { data } = caught as ConvexError<MarketingErrorData>;
  expect(data.code).toBe(code);
  expect(data.details?.reason).toBe(reason);
}

const rows = (t: Backend) =>
  t.run(async (ctx) => ({
    connections: await ctx.db.query("connections").collect(),
    credentials: await ctx.db.query("credentials").collect(),
    grants: await ctx.db.query("oauthGrants").collect(),
    states: await ctx.db.query("oauthStates").collect(),
    audit: await ctx.db.query("auditLog").collect(),
  }));

const auditOf = async (t: Backend, action: string) =>
  (await rows(t)).audit.filter((entry) => entry.action === action);

describe("the OAuth callback (S2)", () => {
  it("stores an encrypted pending grant and connects nothing", async () => {
    const t = await setup();
    const before = Date.now();
    const { response } = await consent(t);

    // Back to the allow-listed return URL with exactly status + claim.
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(RETURN_URL);
    const names = location.search
      .slice(1)
      .split("&")
      .map((pair) => pair.split("=")[0]);
    expect(names.sort()).toEqual(["claim", "status"]);
    expect(location.searchParams.get("status")).toBe("pending");
    const claim = location.searchParams.get("claim")!;
    expect(claim).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = await rows(t);
    expect(stored.connections).toHaveLength(0);
    expect(stored.credentials).toHaveLength(0);
    expect(stored.grants).toHaveLength(1);
    const [grant] = stored.grants;
    expect(grant).toMatchObject({
      provider: "meta",
      issuer: ISSUER_ERP,
      initiatedBySubject: "admin-a",
      algorithm: "AES-256-GCM",
      claimHash: await sha256Base64Url(claim),
    });
    expect(grant!.expiresAt - before).toBeGreaterThanOrEqual(OAUTH_GRANT_TTL_MS - 1_000);
    expect(grant!.expiresAt - before).toBeLessThanOrEqual(OAUTH_GRANT_TTL_MS + 60_000);
    // The raw claim code and the plaintext token are never stored.
    expect(JSON.stringify(stored)).not.toContain(claim);
    expect(new TextDecoder("latin1").decode(grant!.ciphertext)).not.toContain("mock-token");

    const actions = stored.audit.map((entry) => entry.action);
    expect(actions).toContain("connection.oauth_granted");
    expect(actions).not.toContain("connection.connected");
  });
});

describe("completeConnect (S2 claim)", () => {
  it("the initiator claims once: connection, credential (moved unchanged) and discovery", async () => {
    const t = await setup();
    const claim = await consentAndClaimCode(t);
    const [grant] = (await rows(t)).grants;

    const result = await complete(t, INITIATOR, claim);
    expect(result.discoveryFailed).toBe(false);

    const stored = await rows(t);
    expect(stored.grants).toHaveLength(0);
    expect(stored.connections).toHaveLength(1);
    expect(stored.connections[0]).toMatchObject({
      _id: result.connectionId,
      status: "active",
      connectedBySubject: "admin-a",
      credentialVersion: 1,
    });
    expect(stored.credentials).toHaveLength(1);
    expect(stored.credentials[0]!.ciphertext).toEqual(grant!.ciphertext);
    expect(stored.credentials[0]!.iv).toEqual(grant!.iv);
    const connection = await as(t, INITIATOR).query(api.v1.connections.get, {
      connectionId: result.connectionId,
    });
    expect(connection.status).toBe("active");
    expect(
      await as(t, INITIATOR).query(api.v1.connections.listDiscoveredAssets, {
        connectionId: result.connectionId,
      }),
    ).toHaveLength(3);
    expect(await auditOf(t, "connection.connected")).toHaveLength(1);
  });

  it("replay: a claim code works exactly once", async () => {
    const t = await setup();
    const claim = await consentAndClaimCode(t);
    await complete(t, INITIATOR, claim);
    await expectRefused(complete(t, INITIATOR, claim), "NOT_FOUND", "invalid_claim");
    const stored = await rows(t);
    expect(stored.connections).toHaveLength(1);
    expect(stored.connections[0]!.credentialVersion).toBe(1);
    expect(stored.credentials).toHaveLength(1);
  });

  it("cross-user: another admin of the same org is refused and the grant is invalidated", async () => {
    const t = await setup();
    const claim = await consentAndClaimCode(t);
    await expectRefused(complete(t, OTHER_USER, claim), "NOT_FOUND", "invalid_claim");
    // Invalidated for good: not even the initiator can use it afterwards.
    await expectRefused(complete(t, INITIATOR, claim), "NOT_FOUND", "invalid_claim");

    const stored = await rows(t);
    expect(stored.grants).toHaveLength(0);
    expect(stored.connections).toHaveLength(0);
    expect(stored.credentials).toHaveLength(0);
    const [rejected] = await auditOf(t, "connection.claim_rejected");
    expect(rejected).toMatchObject({
      subject: "admin-a",
      targetType: "oauthState",
      changes: { reason: { from: null, to: "owner_mismatch" } },
    });
    // The presenting user's identity is not copied into the audit log.
    expect(JSON.stringify(await auditOf(t, "connection.claim_rejected"))).not.toContain("admin-b");
  });

  it("cross-org: the same user id in another org is refused and the grant is invalidated", async () => {
    const t = await setup();
    const claim = await consentAndClaimCode(t);
    await expectRefused(complete(t, OTHER_ORG, claim), "NOT_FOUND", "invalid_claim");
    await expectRefused(complete(t, INITIATOR, claim), "NOT_FOUND", "invalid_claim");
    expect(await as(t, INITIATOR).query(api.v1.connections.list, {})).toHaveLength(0);
    expect(await as(t, OTHER_ORG).query(api.v1.connections.list, {})).toHaveLength(0);
    expect((await rows(t)).grants).toHaveLength(0);
  });

  it("cross-issuer: the same user and org ids from another app are refused", async () => {
    const t = await setup();
    const claim = await consentAndClaimCode(t);
    await expectRefused(complete(t, OTHER_ISSUER, claim), "NOT_FOUND", "invalid_claim");
    expect(await as(t, OTHER_ISSUER).query(api.v1.connections.list, {})).toHaveLength(0);
    const stored = await rows(t);
    expect(stored.grants).toHaveLength(0);
    expect(stored.connections).toHaveLength(0);
  });

  it("expiry: a grant past its 10 minutes is refused and deleted", async () => {
    const t = await setup();
    const claim = await consentAndClaimCode(t);
    await t.run(async (ctx) => {
      for (const grant of await ctx.db.query("oauthGrants").collect())
        await ctx.db.patch(grant._id, { expiresAt: Date.now() - 1 });
    });
    await expectRefused(complete(t, INITIATOR, claim), "CONFLICT", "expired_claim");
    const stored = await rows(t);
    expect(stored.grants).toHaveLength(0);
    expect(stored.connections).toHaveLength(0);
    expect(stored.credentials).toHaveLength(0);
    expect(await auditOf(t, "connection.grant_expired")).toHaveLength(1);
  });

  it.each(["viewer", "editor"] as const)(
    "a %s cannot claim (admin only); the grant stays for the admin",
    async (role) => {
      const t = await setup();
      const claim = await consentAndClaimCode(t);
      // Same user, demoted in the meantime.
      await expectMarketingError(complete(t, { ...INITIATOR, role }, claim), "FORBIDDEN");
      expect((await rows(t)).grants).toHaveLength(1);
      await complete(t, INITIATOR, claim);
      expect((await rows(t)).connections).toHaveLength(1);
    },
  );

  it("requires authentication; the grant is untouched", async () => {
    const t = await setup();
    const claim = await consentAndClaimCode(t);
    await expectMarketingError(
      t.action(api.v1.connections.completeConnect, { claim }),
      "UNAUTHENTICATED",
    );
    expect((await rows(t)).grants).toHaveLength(1);
  });

  it("malformed claim codes are refused without touching the grant", async () => {
    const t = await setup();
    const claim = await consentAndClaimCode(t);
    for (const bad of ["", "x", `${claim}x`, `${claim.slice(0, 42)}!`, claim.toUpperCase()]) {
      if (bad === claim) continue;
      await expectRefused(complete(t, INITIATOR, bad), "NOT_FOUND", "invalid_claim");
    }
    expect((await rows(t)).grants).toHaveLength(1);
    await complete(t, INITIATOR, claim);
  });

  it("grants are independent: invalidating one leaves the others claimable", async () => {
    const t = await setup();
    const meta = await consentAndClaimCode(t, { provider: "meta" });
    const google = await consentAndClaimCode(t, { provider: "google_ads" });
    await expectRefused(complete(t, OTHER_USER, meta), "NOT_FOUND", "invalid_claim");
    const { connectionId } = await complete(t, INITIATOR, google);
    const connections = (await rows(t)).connections;
    expect(connections.map((c) => [c._id, c.provider])).toEqual([[connectionId, "google_ads"]]);
  });

  it("stays closed on a cloud deployment until connections are enabled", async () => {
    const t = await setup();
    const claim = await consentAndClaimCode(t);
    vi.stubEnv("CONVEX_CLOUD_URL", "https://example-123.convex.cloud");
    vi.stubEnv("OAUTH_CONNECTIONS_ENABLED", "");
    await expectMarketingError(complete(t, INITIATOR, claim), "INVALID_ARGUMENT");
    expect((await rows(t)).grants).toHaveLength(1);
    vi.stubEnv("OAUTH_CONNECTIONS_ENABLED", "true");
    await complete(t, INITIATOR, claim);
    expect((await rows(t)).connections).toHaveLength(1);
  });
});

describe("reconnect identity (preserved under S2)", () => {
  async function connected(t: Backend) {
    const claim = await consentAndClaimCode(t, { user: "1" });
    return (await complete(t, INITIATOR, claim)).connectionId;
  }

  it("a different platform identity is refused at the callback; no grant is stored", async () => {
    const t = await setup();
    const connectionId = await connected(t);
    const { response } = await consent(t, { user: "2", reconnectConnectionId: connectionId });
    expect(redirectParams(response).toString()).toBe("status=error&error=identity_mismatch");
    const stored = await rows(t);
    expect(stored.grants).toHaveLength(0);
    expect(stored.connections).toHaveLength(1);
  });

  it("the reconnect target is checked again when the grant is claimed", async () => {
    const t = await setup();
    const connectionId = await connected(t);
    const claim = await consentAndClaimCode(t, { user: "1", reconnectConnectionId: connectionId });
    // The target no longer matches between consent and claim.
    await t.run((ctx) => ctx.db.delete(connectionId as Id<"connections">));
    await expectRefused(complete(t, INITIATOR, claim), "CONFLICT", "identity_mismatch");
    const stored = await rows(t);
    expect(stored.grants).toHaveLength(0);
    expect(stored.connections).toHaveLength(0);
    expect(await auditOf(t, "connection.claim_rejected")).toHaveLength(1);
  });

  it("the same identity reconnects the same connection with a new credential generation", async () => {
    const t = await setup();
    const connectionId = await connected(t);
    const claim = await consentAndClaimCode(t, { user: "1", reconnectConnectionId: connectionId });
    expect((await complete(t, INITIATOR, claim)).connectionId).toBe(connectionId);
    const stored = await rows(t);
    expect(stored.connections).toHaveLength(1);
    expect(stored.connections[0]!.credentialVersion).toBe(2);
    expect(stored.credentials).toHaveLength(1);
    expect(await auditOf(t, "connection.reconnected")).toHaveLength(1);
  });
});

describe("cleanup and leaks (S2)", () => {
  it("the sweep deletes expired grants with their ciphertext and keeps fresh ones", async () => {
    const t = await setup();
    const stale = await consentAndClaimCode(t, { provider: "meta" });
    const fresh = await consentAndClaimCode(t, { provider: "google_ads" });
    const staleHash = await sha256Base64Url(stale);
    await t.run(async (ctx) => {
      for (const grant of await ctx.db.query("oauthGrants").collect())
        if (grant.claimHash === staleHash)
          await ctx.db.patch(grant._id, { expiresAt: Date.now() - 1 });
    });
    const result = await t.mutation(internal.connections.maintenance.sweep, {});
    expect(result.grantsDeleted).toBe(1);
    const remaining = (await rows(t)).grants;
    expect(remaining.map((g) => g.provider)).toEqual(["google_ads"]);
    const [expired] = await auditOf(t, "connection.grant_expired");
    expect(expired).toMatchObject({ subject: "system:connection-sweep" });
    await expectRefused(complete(t, INITIATOR, stale), "NOT_FOUND", "invalid_claim");
    await complete(t, INITIATOR, fresh);
  });

  it("no public output or audit entry carries the claim code, its hash or ciphertext", async () => {
    const t = await setup();
    const claim = await consentAndClaimCode(t);
    const claimHash = await sha256Base64Url(claim);
    const result = await complete(t, INITIATOR, claim);
    await expectRefused(complete(t, OTHER_USER, claim), "NOT_FOUND", "invalid_claim");
    const outputs = JSON.stringify([
      result,
      await as(t, INITIATOR).query(api.v1.connections.list, {}),
      await as(t, INITIATOR).query(api.v1.audit.list, {
        paginationOpts: { numItems: 100, cursor: null },
      }),
      (await rows(t)).audit,
    ]);
    for (const secret of [claim, claimHash, "mock-token"])
      expect(outputs, `leaked: ${secret.slice(0, 8)}…`).not.toContain(secret);
    for (const field of ["ciphertext", "claimHash", 'claim"']) expect(outputs).not.toContain(field);
  });
});
