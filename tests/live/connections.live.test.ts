import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import { isMarketingError } from "../../convex/lib/errors";
import { DEV_RETURN_URLS, mintToken } from "../../scripts/dev-auth.mjs";

// Opt-in (`npm run test:live`): the Phase 4 connection flow over REAL HTTP —
// real JWT verification, a public action (beginConnect), the real /oauth/callback
// HTTP route, real AES-GCM encryption with the deployment's TOKEN_ENCRYPTION_KEYS.
// Prerequisites: `npm run dev:backend` running and `npm run dev:auth setup` done.

function envLocal(name: string): string | undefined {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return undefined;
  return new RegExp(`^${name}=(.+)$`, "m").exec(readFileSync(path, "utf8"))?.[1]?.trim();
}

const url = process.env.NEXT_PUBLIC_CONVEX_URL ?? envLocal("NEXT_PUBLIC_CONVEX_URL") ?? "";
const run = Date.now().toString(36);
const returnUrl = `${DEV_RETURN_URLS[0]}settings/connections`;

async function client(org: string, role = "admin") {
  const c = new ConvexHttpClient(url);
  c.setAuth(await mintToken({ org, role, sub: `${role}-${org}` }));
  await c.mutation(api.v1.orgs.ensure, {});
  return c;
}

beforeAll(() => {
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL not found. Run `npm run dev:backend`.");
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
    expect(location.searchParams.get("status")).toBe("connected");
    const connectionId = location.searchParams.get("connection")!;

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
      .action(api.v1.connections.beginConnect, { provider: "meta" })
      .catch((e: unknown) => e);
    expect(isMarketingError(forbidden) && forbidden.data.code).toBe("FORBIDDEN");
  });

  it("keeps tenants apart over HTTP", async () => {
    const a = await client(`live-iso-a-${run}`);
    const b = await client(`live-iso-b-${run}`);
    const { authorizeUrl } = await a.action(api.v1.connections.beginConnect, {
      provider: "google_ads",
      returnUrl,
    });
    const connectionId = new URL(
      (await fetch(authorizeUrl, { redirect: "manual" })).headers.get("location")!,
    ).searchParams.get("connection")!;
    const error = await b.query(api.v1.connections.get, { connectionId }).catch((e: unknown) => e);
    expect(isMarketingError(error) && error.data.code).toBe("NOT_FOUND");
    expect(await b.query(api.v1.connections.list, {})).toEqual([]);
  });
});
