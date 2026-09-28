import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import {
  createFakeInstagram,
  FAKE_IG_APP_SECRET,
  FAKE_IG_TOKEN_MARKER,
  type FakeInstagram,
} from "../providers/instagram/fakeInstagram.fixtures";
import {
  connectInstagramFake,
  newBackend,
  setupSyncOrg,
  stubLiveInstagram,
  type Backend,
} from "../test.helpers";

// Phase 10 daily long-lived token refresh: only eligible Instagram tokens, atomic
// replacement through the credential store, fail-closed failure handling, no leaks.

vi.setConfig({ testTimeout: 120_000 });
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-09-01T12:00:00Z").getTime();

let fake: FakeInstagram;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  fake = createFakeInstagram();
  stubLiveInstagram(fake);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function connect(t: Backend) {
  await setupSyncOrg(t);
  const params = await connectInstagramFake(t, fake, "business");
  expect(params.get("status")).toBe("connected");
  return params.get("connection")!;
}

async function snapshot(t: Backend) {
  return await t.run(async (ctx) => ({
    connection: (await ctx.db.query("connections").first())!,
    credential: (await ctx.db.query("credentials").first())!,
    audit: await ctx.db.query("auditLog").collect(),
  }));
}

const refresh = (t: Backend) =>
  t.action(internal.connections.tokenRefresh.refreshExpiringTokens, {});

describe("Instagram token refresh job", () => {
  it("leaves tokens alone until they are within the refresh window", async () => {
    const t = newBackend();
    await connect(t);
    vi.setSystemTime(T0 + 30 * DAY);
    fake.reset();
    expect(await refresh(t)).toEqual({
      refreshed: 0,
      superseded: 0,
      skipped: 0,
      reauth: 0,
      failed: 0,
    });
    expect(fake.requests).toEqual([]);
  });

  it("refreshes an eligible token and replaces the ciphertext atomically", async () => {
    const t = newBackend();
    await connect(t);
    const before = await snapshot(t);
    vi.setSystemTime(T0 + 55 * DAY);
    fake.reset();

    expect(await refresh(t)).toMatchObject({ refreshed: 1, reauth: 0, failed: 0 });
    expect(fake.requests.map((r) => `${r.method} ${r.path} ${r.params.join(",")}`)).toEqual([
      "GET /refresh_access_token access_token,grant_type",
    ]);

    const after = await snapshot(t);
    expect(after.connection.credentialVersion).toBe(before.connection.credentialVersion + 1);
    expect(after.connection.tokenExpiresAt).toBe(T0 + 55 * DAY + 5_184_000_000);
    expect(after.connection.grantedScopes).toEqual(before.connection.grantedScopes); // untouched
    expect(after.connection.status).toBe("active");
    expect(new Uint8Array(after.credential.ciphertext)).not.toEqual(
      new Uint8Array(before.credential.ciphertext),
    );
    expect(new TextDecoder("latin1").decode(after.credential.ciphertext)).not.toContain(
      FAKE_IG_TOKEN_MARKER,
    );
    const entry = after.audit.find((e) => e.action === "connection.token_refreshed");
    expect(entry).toMatchObject({
      subject: "system:token-refresh",
      targetType: "connection",
      changes: { credentialVersion: { from: 1, to: 2 } },
    });
    const { credential: _ciphertext, ...rest } = after;
    const text = JSON.stringify(rest);
    for (const marker of [
      FAKE_IG_TOKEN_MARKER,
      FAKE_IG_APP_SECRET,
      "access_token",
      "graph.instagram",
    ]) {
      expect(text).not.toContain(marker);
    }
  });

  it("skips tokens younger than 24 hours (before any request)", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    // A long-lived token that expires in 5 days, issued just now.
    fake.fail("long_lived_exchange", {
      status: 200,
      body: {
        access_token: fake.issueLongLivedToken("business"),
        token_type: "bearer",
        expires_in: 5 * 86_400,
      },
    });
    await connectInstagramFake(t, fake, "business");
    fake.reset();
    expect(await refresh(t)).toMatchObject({ skipped: 1, refreshed: 0 });
    expect(fake.requests).toEqual([]);
  });

  it("an invalid refresh token moves the connection to needs_reauth (fail closed)", async () => {
    const t = newBackend();
    await connect(t);
    vi.setSystemTime(T0 + 55 * DAY);
    fake.fail("refresh", { status: 400, body: { error: { code: 190, message: "Fake error" } } });
    expect(await refresh(t)).toMatchObject({ reauth: 1, refreshed: 0 });
    const after = await snapshot(t);
    expect(after.connection.status).toBe("needs_reauth");
    expect(after.connection.credentialVersion).toBe(1);
    expect(after.audit.find((e) => e.action === "connection.needs_reauth")?.changes).toMatchObject({
      reason: { to: "token_refresh_failed" },
    });
    expect(JSON.stringify(after.audit)).not.toContain("Fake error");
  });

  it("a transient failure keeps the connection active and records a sanitized error", async () => {
    const t = newBackend();
    await connect(t);
    vi.setSystemTime(T0 + 55 * DAY);
    fake.fail("refresh", { status: 503 });
    expect(await refresh(t)).toMatchObject({ failed: 1 });
    const after = await snapshot(t);
    expect(after.connection.status).toBe("active");
    expect(after.connection.lastError).toMatchObject({
      kind: "transient",
      message: "Token refresh failed",
    });
    expect(after.connection.credentialVersion).toBe(1);
  });

  it("never refreshes other providers' tokens", async () => {
    const t = newBackend();
    const orgId = await (async () => {
      await setupSyncOrg(t);
      return (await t.run((ctx) => ctx.db.query("organizations").first()))!._id;
    })();
    await t.run((ctx) =>
      ctx.db.insert("connections", {
        orgId,
        provider: "meta",
        externalUserId: "10001",
        status: "active",
        grantedScopes: ["ads_read"],
        credentialVersion: 1,
        tokenExpiresAt: T0 + 2 * DAY,
        connectedBySubject: "user_1",
        connectedAt: T0,
        createdAt: T0,
        updatedAt: T0,
      }),
    );
    expect(await t.query(internal.connections.tokenRefresh.refreshCandidates, { now: T0 })).toEqual(
      [],
    );
  });

  it("a replacement is refused when the credential changed meanwhile (reconnect wins)", async () => {
    const t = newBackend();
    const connectionId = await connect(t);
    const before = await snapshot(t);
    const replaced = await t.mutation(
      internal.connections.credentialStore.replaceRefreshedCredential,
      {
        connectionId: connectionId as never,
        expectedCredentialVersion: before.connection.credentialVersion + 1,
        encrypted: {
          ciphertext: new Uint8Array([1, 2, 3]).buffer,
          iv: new Uint8Array(12).buffer,
          keyVersion: 1,
        },
        actorSubject: "system:token-refresh",
      },
    );
    expect(replaced).toBe(false);
    const after = await snapshot(t);
    expect(new Uint8Array(after.credential.ciphertext)).toEqual(
      new Uint8Array(before.credential.ciphertext),
    );
    expect(after.connection.credentialVersion).toBe(before.connection.credentialVersion);
  });
});
