import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  apiClient,
  assertLocalSetup,
  cleanupE2EOrg,
  devOrgSnapshot,
  E2E_ORG,
  E2E_ORG_NAME,
  E2E_OTHER_ORG,
  e2eToken,
  isLoopbackUrl,
  requestAccountSync,
} from "../../scripts/e2e-connections.mjs";
import { anyApi } from "convex/server";
import type { api as GeneratedApi } from "../../convex/_generated/api";
import { expectNoSeriousA11yViolations, localDevAuthConfigured } from "./support";

// The Google Ads Connections journey, end to end in a real browser against the LOCAL Convex
// backend in mock provider mode, as the throwaway org "e2e-google-ads":
//   Connect → (mock consent =) OAuth callback → discovery → select one client → link →
//   sync of that one account → analytics, plus callback replay, roles, tenant isolation,
//   accessibility and disconnect cleanup. dev-org is only read (snapshot before / after).
//
// Run with the dedicated config only (port 3000, own server, one worker, no traces):
//   E2E_CONNECTIONS_JOURNEY=1 npm run test:e2e:connections
// The dashboard server is built with the developer's dev-org token; this spec swaps it, in
// memory, for a throwaway-org token on the Convex WebSocket, and acts only after the org badge
// proves the swap. Residual rows stay in the throwaway org (docs/dashboard.md "Tests").

/** The typed public API (runtime: anyApi; the generated module is imported for types only). */
const api = anyApi as unknown as typeof GeneratedApi;

test.skip(
  process.env.E2E_CONNECTIONS_JOURNEY !== "1" || !localDevAuthConfigured(),
  "local-only: E2E_CONNECTIONS_JOURNEY=1 with npm run test:e2e:connections",
);
test.describe.configure({ mode: "serial" });

const CLIENT = { externalId: "1112223333", name: "Acme Search US", shown: "111-222-3333" };
const OTHER_CLIENT_ID = "4445556666";
const RESULT_PARAMS = ["status", "connection", "warning", "error", "code", "state"];

type Api = Awaited<ReturnType<typeof apiClient>>;
type Connection = { id: string; provider: string; status: string };
type AdAccount = {
  id: string;
  platform: string;
  externalId: string;
  linked: boolean;
  connectionId?: string;
  sync?: { lastRunStatus?: string; lastSuccessAt?: string };
};

let urls: { backendUrl: string; siteOrigin: string };
let admin: Api;
let devOrgBefore: Awaited<ReturnType<typeof devOrgSnapshot>>;
let context: BrowserContext;
let page: Page;
let authSwaps = 0;
const blockedHosts: string[] = [];
const blockedSockets: string[] = [];
let callbackUrl = "";
let connectionId = "";
let adAccountId = "";

/** The contract error code of a call, "OK" when it succeeds. */
async function codeOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "OK";
  } catch (error) {
    return (error as { data?: { code?: string } }).data?.code ?? "UNKNOWN";
  }
}

async function googleConnections(client: Api): Promise<Connection[]> {
  const all: Connection[] = await client.query(api.v1.connections.list, {});
  return all.filter((c) => c.provider === "google_ads" && c.status !== "revoked");
}

async function account(client: Api, id: string): Promise<AdAccount | undefined> {
  const all: AdAccount[] = await client.query(api.v1.adAccounts.list, {});
  return all.find((a) => a.id === id);
}

test.beforeAll(async ({ browser, baseURL }) => {
  urls = await assertLocalSetup();
  expect(isLoopbackUrl(baseURL ?? "")).toBe(true);
  // Self-healing start: an interrupted earlier run may have left the test org connected.
  await cleanupE2EOrg(urls.backendUrl);
  admin = await apiClient(urls.backendUrl, { org: E2E_ORG, role: "admin" });
  devOrgBefore = await devOrgSnapshot(urls.backendUrl);
  const browserToken = await e2eToken({ org: E2E_ORG, role: "admin" });

  context = await browser.newContext();
  // Nothing may leave the machine; accounts.google.com in particular is never reached.
  await context.route(
    (url) => !isLoopbackUrl(url.href),
    async (route) => {
      blockedHosts.push(new URL(route.request().url()).hostname);
      await route.abort();
    },
  );
  // WebSockets are not covered by context.route: any non-loopback socket is closed before it
  // connects, and recorded.
  await context.routeWebSocket(
    (url) => !isLoopbackUrl(url.href),
    (ws) => {
      blockedSockets.push(new URL(ws.url()).hostname);
      void ws.close();
    },
  );
  // Swap the dashboard's dev-org identity for the throwaway org on the Convex WebSocket.
  await context.routeWebSocket(
    (url) => isLoopbackUrl(url.href) && url.pathname.endsWith("/sync"),
    (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        // An authentication frame in an unexpected (binary) form is never forwarded.
        if (typeof message !== "string" && message.toString("utf8").includes('"Authenticate"')) {
          void ws.close();
          return;
        }
        if (typeof message === "string" && message.includes('"Authenticate"')) {
          const frame = JSON.parse(message) as {
            type?: string;
            tokenType?: string;
            value?: string;
          };
          if (frame.type === "Authenticate" && frame.tokenType === "User") {
            authSwaps++;
            server.send(JSON.stringify({ ...frame, value: browserToken }));
            return;
          }
          if (frame.type === "Authenticate" && frame.tokenType !== "None") {
            void ws.close();
            return;
          }
        }
        server.send(message);
      });
    },
  );
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  if (urls === undefined) return;
  // Always leave the test org disconnected, then prove dev-org was never touched.
  await cleanupE2EOrg(urls.backendUrl);
  expect(await devOrgSnapshot(urls.backendUrl)).toEqual(devOrgBefore);
  expect(blockedHosts).toEqual([]);
  expect(blockedSockets).toEqual([]);
});

test("connects, discovers, links one client account, syncs it and opens its analytics", async () => {
  await page.goto("/connections");
  // Identity guard: nothing is clicked unless the dashboard acts as the throwaway org.
  const badge = page.getByTestId("org-badge");
  await expect(badge).toContainText(E2E_ORG_NAME, { timeout: 30_000 });
  await expect(badge).toContainText("admin");
  expect(authSwaps).toBeGreaterThan(0);
  await expect(page.getByText("Google Ads is not connected.")).toBeVisible();

  // Connect: the mock consent sends the browser straight to the local OAuth callback.
  const callback = page.waitForRequest((r) => r.url().startsWith(`${urls.siteOrigin}/oauth/`));
  await page.getByRole("button", { name: "Connect Google Ads" }).click();
  callbackUrl = (await callback).url(); // kept in memory for the replay test; never printed
  expect(callbackUrl.startsWith(`${urls.siteOrigin}/oauth/callback?`)).toBe(true);

  // Back on /connections: fixed notice, result parameters removed.
  await expect(page.getByLabel("Google Ads connected")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return url.pathname === "/connections" && !RESULT_PARAMS.some((p) => url.searchParams.has(p));
    })
    .toBe(true);

  // Discovery: the manager is not selectable, the client is.
  await expect(page.getByRole("table", { name: "Discovered Google Ads accounts" })).toBeVisible();
  const manager = page.getByRole("radio", { name: /Acme MCC/ });
  await expect(manager).toBeDisabled();
  await expect(manager).toHaveAccessibleDescription(/Manager accounts cannot be linked/);
  const client = page.getByRole("radio", { name: new RegExp(CLIENT.name) });
  await expect(client).toBeEnabled();
  await client.check();
  await page.getByRole("button", { name: "Link selected account" }).click();
  await expect(page.getByLabel("Account linked")).toContainText(
    `${CLIENT.name} (${CLIENT.shown}) is linked`,
  );

  // Server state: one active connection, exactly one linked Google Ads account.
  const connections = await googleConnections(admin);
  expect(connections).toHaveLength(1);
  connectionId = connections[0]!.id;
  const accounts: AdAccount[] = await admin.query(api.v1.adAccounts.list, {});
  const linked = accounts.filter((a) => a.platform === "google_ads" && a.linked);
  expect(linked.map((a) => a.externalId)).toEqual([CLIENT.externalId]);
  expect(linked[0]!.connectionId).toBe(connectionId);
  adAccountId = linked[0]!.id;

  const row = page
    .getByRole("table", { name: /Linked Google Ads accounts/ })
    .getByRole("row")
    .filter({ hasText: CLIENT.name });
  await expect(row).toBeVisible();

  // Sync exactly this account (never the org-wide planner) and wait for its successful run.
  const requestedAt = Date.now();
  const sync = requestAccountSync(adAccountId);
  expect(["started", "busy"]).toContain(sync.status);
  await expect
    .poll(
      async () => {
        const state = (await account(admin, adAccountId))?.sync;
        return (
          state?.lastRunStatus === "succeeded" &&
          state.lastSuccessAt !== undefined &&
          Date.parse(state.lastSuccessAt) >= requestedAt - 1_000
        );
      },
      { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe(true);
  await expect(row).toContainText("Up to date", { timeout: 30_000 });
  await expect(row).toContainText(/Data through \d{4}-\d{2}-\d{2}\./);
  await expectNoSeriousA11yViolations(page);

  // Analytics: the Overview filtered to this one account.
  await row.getByRole("link", { name: `View analytics for ${CLIENT.name}` }).click();
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return url.pathname === "/" && url.searchParams.get("accounts") === adAccountId;
    })
    .toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accounts 1 account" })).toBeVisible();
  await expect(page.getByTestId("overview-totals")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("org-badge")).toContainText(E2E_ORG_NAME);
});

test("a replayed callback is refused and the result notice never replays", async () => {
  expect(callbackUrl && connectionId).toBeTruthy();
  const replay = await context.newPage();
  await replay.goto(callbackUrl);
  await expect(replay.getByRole("heading", { name: "Connection failed" })).toBeVisible();
  expect(new URL(replay.url()).origin).toBe(urls.siteOrigin); // no redirect back
  await replay.close();
  expect((await googleConnections(admin)).map((c) => c.id)).toEqual([connectionId]);

  await page.goto("/connections");
  await expect(page.getByTestId("org-badge")).toContainText(E2E_ORG_NAME, { timeout: 30_000 });
  await expect(page.getByRole("table", { name: /Linked Google Ads accounts/ })).toBeVisible();
  await expect(page.getByLabel("Google Ads connected")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("table", { name: /Linked Google Ads accounts/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByLabel("Google Ads connected")).toHaveCount(0);
});

for (const role of ["viewer", "editor"] as const) {
  test(`the ${role} role can read but cannot connect, discover, link, unlink, refresh or disconnect`, async () => {
    const user = await apiClient(urls.backendUrl, { org: E2E_ORG, role });
    const connections: Connection[] = await user.query(api.v1.connections.list, {});
    expect(connections.some((c) => c.id === connectionId)).toBe(true);
    expect((await account(user, adAccountId))?.linked).toBe(true);

    const refused: Record<string, () => Promise<unknown>> = {
      beginConnect: () =>
        user.action(api.v1.connections.beginConnect, {
          provider: "google_ads",
          returnUrl: "http://127.0.0.1:3000/connections",
        }),
      listDiscoveredAssets: () =>
        user.query(api.v1.connections.listDiscoveredAssets, { connectionId }),
      linkAdAccounts: () =>
        user.mutation(api.v1.connections.linkAdAccounts, {
          connectionId,
          externalIds: [OTHER_CLIENT_ID],
        }),
      unlinkAdAccount: () => user.mutation(api.v1.connections.unlinkAdAccount, { adAccountId }),
      refreshAssets: () => user.mutation(api.v1.connections.refreshAssets, { connectionId }),
      disconnect: () => user.mutation(api.v1.connections.disconnect, { connectionId }),
    };
    for (const [name, call] of Object.entries(refused)) {
      expect(`${name}: ${await codeOf(call)}`).toBe(`${name}: FORBIDDEN`);
    }
    // Nothing changed.
    expect((await googleConnections(admin)).map((c) => c.id)).toEqual([connectionId]);
    expect((await account(admin, adAccountId))?.linked).toBe(true);
  });
}

test("another org can neither see nor touch the test connection, account or discovery", async () => {
  const other = await apiClient(urls.backendUrl, { org: E2E_OTHER_ORG, role: "admin" });
  await other.mutation(api.v1.orgs.ensure, {});
  expect(await other.query(api.v1.connections.list, {})).toEqual([]);
  expect(await other.query(api.v1.adAccounts.list, {})).toEqual([]);

  const hidden: Record<string, () => Promise<unknown>> = {
    get: () => other.query(api.v1.connections.get, { connectionId }),
    listDiscoveredAssets: () =>
      other.query(api.v1.connections.listDiscoveredAssets, { connectionId }),
    linkAdAccounts: () =>
      other.mutation(api.v1.connections.linkAdAccounts, {
        connectionId,
        externalIds: [OTHER_CLIENT_ID],
      }),
    unlinkAdAccount: () => other.mutation(api.v1.connections.unlinkAdAccount, { adAccountId }),
    refreshAssets: () => other.mutation(api.v1.connections.refreshAssets, { connectionId }),
    disconnect: () => other.mutation(api.v1.connections.disconnect, { connectionId }),
  };
  for (const [name, call] of Object.entries(hidden)) {
    expect(`${name}: ${await codeOf(call)}`).toBe(`${name}: NOT_FOUND`);
  }
  expect((await googleConnections(admin)).map((c) => c.id)).toEqual([connectionId]);
  expect(await devOrgSnapshot(urls.backendUrl)).toEqual(devOrgBefore);
});

test("disconnecting cleans up: revoked, unlinked, discovery cleared, sync refused", async () => {
  const revoked: Connection = await admin.mutation(api.v1.connections.disconnect, {
    connectionId,
  });
  expect(revoked.status).toBe("revoked");
  const stored: Connection = await admin.query(api.v1.connections.get, { connectionId });
  expect(stored.status).toBe("revoked");
  const unlinked = await account(admin, adAccountId);
  expect(unlinked?.linked).toBe(false);
  expect(unlinked?.connectionId).toBeUndefined();
  expect(await admin.query(api.v1.connections.listDiscoveredAssets, { connectionId })).toEqual([]);
  expect(requestAccountSync(adAccountId)).toMatchObject({
    status: "rejected",
    reason: "account_unlinked",
  });
  expect(await googleConnections(admin)).toEqual([]);

  await page.goto("/connections");
  await expect(page.getByTestId("org-badge")).toContainText(E2E_ORG_NAME, { timeout: 30_000 });
  await expect(page.getByText("Google Ads is not connected.")).toBeVisible();
  await expect(page.getByText("No Google Ads account linked yet")).toBeVisible();
});
