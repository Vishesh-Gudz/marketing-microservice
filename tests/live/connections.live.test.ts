import { ConvexHttpClient } from "convex/browser";
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import { isMarketingError } from "../../convex/lib/errors";
import { DEV_RETURN_URLS, mintToken } from "../../scripts/dev-auth.mjs";
import { liveConvexUrl } from "./local-backend";
import { assertLocalMockDeployment } from "../../scripts/e2e-connections.mjs";

// Opt-in (`npm run test:live`): the Phase 4 connection flow over REAL HTTP —
// real JWT verification, public actions (beginConnect, completeConnect), the real
// /oauth/callback HTTP route, real AES-GCM encryption with the deployment's
// TOKEN_ENCRYPTION_KEYS. S2: the callback returns a one-time claim code that only the
// initiating user, in the initiating org, can redeem.
// Prerequisites: `npm run dev:backend` running and `npm run dev:auth setup` done.

// Local backend only (loopback): the live tests never reach a cloud or production deployment.
const url = liveConvexUrl();
const run = Date.now().toString(36);
const returnUrl = `${DEV_RETURN_URLS[0]}settings/connections`;

async function client(org: string, role = "admin", sub = `${role}-${org}`) {
  const c = new ConvexHttpClient(url);
  c.setAuth(await mintToken({ org, role, sub }));
  await c.mutation(api.v1.orgs.ensure, {});
  return c;
}

/** Follows the mock consent (the callback) and returns its pending claim code. */
async function consent(authorizeUrl: string): Promise<string> {
  const callback = await fetch(authorizeUrl, { redirect: "manual" });
  const location = new URL(callback.headers.get("location")!);
  expect(location.searchParams.get("status")).toBe("pending");
  return location.searchParams.get("claim")!;
}

beforeAll(() => {
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL not found. Run `npm run dev:backend`.");
  // These flows follow the authorization URL. Only a local MOCK deployment answers it locally;
  // in live mode it would be a real Meta/Google sign-in URL. Refuse before connecting anything.
  assertLocalMockDeployment();
});

describe("live connection flow (mock instant consent)", () => {
  it("connects, discovers, links and disconnects over HTTP", async () => {
    const admin = await client(`live-conn-${run}`);
    const { authorizeUrl } = await admin.action(api.v1.connections.beginConnect, {
      provider: "meta",
      returnUrl,
    });
    expect(new URL(authorizeUrl).pathname).toBe("/oauth/callback");

    const callback = await fetch(authorizeUrl, { redirect: "manual" });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("cache-control")).toBe("no-store");
    const location = new URL(callback.headers.get("location")!);
    expect(location.href.startsWith(returnUrl)).toBe(true);
    expect(location.searchParams.get("status")).toBe("pending");
    const claim = location.searchParams.get("claim")!;
    expect(claim).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { connectionId, discoveryFailed } = await admin.action(
      api.v1.connections.completeConnect,
      { claim },
    );
    expect(discoveryFailed).toBe(false);

    const replay = await fetch(authorizeUrl, { redirect: "manual" });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("location")).toBeNull();

    const [connection] = await admin.query(api.v1.connections.list, {});
    expect(connection).toMatchObject({ id: connectionId, status: "active", provider: "meta" });
    const assets = await admin.query(api.v1.connections.listDiscoveredAssets, { connectionId });
    expect(assets.map((a) => a.externalId).sort()).toEqual(["1001", "1002", "1003"]);

    const [linked] = await admin.mutation(api.v1.connections.linkAdAccounts, {
      connectionId,
      externalIds: ["1001"],
    });
    expect(linked).toMatchObject({ linked: true, connectionId });

    const serialized = JSON.stringify([
      connection,
      assets,
      linked,
      callback.headers.get("location"),
    ]);
    expect(serialized).not.toContain("mock-token");
    expect(serialized).not.toContain(new URL(authorizeUrl).searchParams.get("state")!);
    expect(JSON.stringify([connection, assets, linked])).not.toContain(claim);

    const disconnected = await admin.mutation(api.v1.connections.disconnect, { connectionId });
    expect(disconnected.status).toBe("revoked");
    expect((await admin.query(api.v1.adAccounts.list, {}))[0]).toMatchObject({ linked: false });
  });

  it("rejects non-allowlisted return URLs and non-admin callers", async () => {
    const admin = await client(`live-conn-b-${run}`);
    const error = await admin
      .action(api.v1.connections.beginConnect, {
        provider: "google_ads",
        returnUrl: "https://evil.example/",
      })
      .catch((e: unknown) => e);
    expect(isMarketingError(error) && error.data.code).toBe("INVALID_ARGUMENT");

    const viewer = await client(`live-conn-b-${run}`, "viewer");
    const forbidden = await viewer
      .action(api.v1.connections.beginConnect, { provider: "meta", returnUrl })
      .catch((e: unknown) => e);
    expect(isMarketingError(forbidden) && forbidden.data.code).toBe("FORBIDDEN");
  });

  it("only the initiating user can claim a consent, once (S2 ownership)", async () => {
    const org = `live-claim-${run}`;
    const initiator = await client(org);
    const otherUser = await client(org, "admin", `other-admin-${org}`);
    const otherOrg = await client(`live-claim-other-${run}`, "admin", `admin-${org}`);
    const begin = () =>
      initiator.action(api.v1.connections.beginConnect, { provider: "meta", returnUrl });
    const refused = async (c: ConvexHttpClient, claim: string) => {
      const error = await c
        .action(api.v1.connections.completeConnect, { claim })
        .catch((e: unknown) => e);
      expect(isMarketingError(error) && error.data.details?.reason).toBe("invalid_claim");
    };

    // Another admin of the same org, then the same user id in another org: refused, and
    // the grant is invalidated (the initiator cannot use it afterwards either).
    for (const intruder of [otherUser, otherOrg]) {
      const claim = await consent((await begin()).authorizeUrl);
      await refused(intruder, claim);
      await refused(initiator, claim);
    }
    expect(await initiator.query(api.v1.connections.list, {})).toEqual([]);
    expect(await otherOrg.query(api.v1.connections.list, {})).toEqual([]);

    // The initiator claims once; a replay is refused.
    const claim = await consent((await begin()).authorizeUrl);
    const { connectionId } = await initiator.action(api.v1.connections.completeConnect, {
      claim,
    });
    await refused(initiator, claim);
    expect((await initiator.query(api.v1.connections.list, {})).map((c) => c.id)).toEqual([
      connectionId,
    ]);
  });

  it("keeps tenants apart over HTTP", async () => {
    const a = await client(`live-iso-a-${run}`);
    const b = await client(`live-iso-b-${run}`);
    const { authorizeUrl } = await a.action(api.v1.connections.beginConnect, {
      provider: "google_ads",
      returnUrl,
    });
    const { connectionId } = await a.action(api.v1.connections.completeConnect, {
      claim: await consent(authorizeUrl),
    });
    const error = await b.query(api.v1.connections.get, { connectionId }).catch((e: unknown) => e);
    expect(isMarketingError(error) && error.data.code).toBe("NOT_FOUND");
    expect(await b.query(api.v1.connections.list, {})).toEqual([]);
  });
});
