import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  apiClient,
  assertLocalSetup,
  cleanupE2EOrg,
  connectMockFixture,
  devOrgSnapshot,
  E2E_META_ORG,
  E2E_META_ORG_NAME,
  e2eToken,
  isLoopbackUrl,
  requestAccountSync,
  syncRunStatus,
} from "../../scripts/e2e-connections.mjs";
import { anyApi } from "convex/server";
import type { api as GeneratedApi } from "../../convex/_generated/api";
import { expectNoSeriousA11yViolations, localDevAuthConfigured } from "./support";

// The Meta Ads Connections journey, end to end in a real browser against the LOCAL Convex
// backend in mock provider mode, as the throwaway org "e2e-meta-ads":
//   Connect Meta Ads → (mock consent =) OAuth callback → discovery (Meta columns and words) →
//   link one ad account → sync of that one account → coverage → analytics filtered to it →
//   Disconnect Meta Ads (with confirmation).
// The org also gets a mock Google Ads and a mock Instagram connection (through the API, not
// the browser), so the journey can prove that the Meta disconnect leaves them alone and that
// the analytics filter keeps Google data out. dev-org is only read (snapshot before / after).
//
// Same harness as the Google Ads journey (connections-journey.spec.mts): run with the
// dedicated config only (port 3000, own server, one worker, no traces):
//   E2E_CONNECTIONS_JOURNEY=1 npx playwright test -c playwright.connections.config.mts meta-ads-journey
// The dashboard server is built with the developer's dev-org token; this spec swaps it, in
// memory, for a throwaway-org token on the Convex WebSocket, and acts only after the org badge
// proves the swap. Residual rows stay in the throwaway org (docs/dashboard.md "Tests").

/** The typed public API (runtime: anyApi; the generated module is imported for types only). */
const api = anyApi as unknown as typeof GeneratedApi;

test.skip(
  process.env.E2E_CONNECTIONS_JOURNEY !== "1" || !localDevAuthConfigured(),
  "local-only: E2E_CONNECTIONS_JOURNEY=1 with the connections config",
);
test.describe.configure({ mode: "serial" });

/** Mock Meta ad accounts (convex/providers/mock/meta.ts). */
const META_ACCOUNT = { externalId: "1001", name: "Acme Retail US", business: "5550001" };
const DISABLED_ACCOUNT = { externalId: "1003", name: "Empty sandbox" };
/** A mock Google Ads client account, linked as a fixture. */
const GOOGLE_CLIENT = "1112223333";
const RESULT_PARAMS = ["status", "connection", "warning", "error", "connect", "code", "state"];

type Api = Awaited<ReturnType<typeof apiClient>>;
type Connection = { id: string; provider: string; status: string };
type AdAccount = {
  id: string;
  platform: string;
  externalId: string;
  linked: boolean;
  connectionId?: string;
  sync?: {
    lastRunStatus?: string;
    lastSuccessAt?: string;
    coveredFrom?: string;
    coveredThrough?: string;
  };
};
type SocialAccount = { id: string; linked: boolean; connectionId?: string };

let urls: { backendUrl: string; siteOrigin: string };
let admin: Api;
let devOrgBefore: Awaited<ReturnType<typeof devOrgSnapshot>>;
let context: BrowserContext;
let page: Page;
let authSwaps = 0;
const blockedHosts: string[] = [];
const blockedSockets: string[] = [];
const fixtures = { google: "", googleAccount: "", instagram: "", socialAccount: "" };
let metaConnectionId = "";
let metaAccountId = "";

async function connectionsOf(client: Api, provider: string): Promise<Connection[]> {
  const all: Connection[] = await client.query(api.v1.connections.list, {});
  return all.filter((c) => c.provider === provider && c.status !== "revoked");
}

async function account(client: Api, id: string): Promise<AdAccount | undefined> {
  const all: AdAccount[] = await client.query(api.v1.adAccounts.list, {});
  return all.find((a) => a.id === id);
}

async function socialAccount(client: Api, id: string): Promise<SocialAccount | undefined> {
  const { page: all } = (await client.query(api.v1.socialAccounts.list, {
    paginationOpts: { cursor: null, numItems: 100 },
  })) as { page: SocialAccount[] };
  return all.find((s) => s.id === id);
}

/**
 * Syncs ONE account and waits, by state, for the run the backend assigned to the request.
 * requestSync answers "started" with a new run, or "busy" with the run that already covers the
 * request: an active run, or a run of the same kind and window that already ran in the current
 * 15-minute planner slot (convex/sync/runs.ts), e.g. when the journey is rerun within minutes.
 * That run must succeed (a failed, partial or cancelled run fails at once), and the account
 * must report it: a successful last run whose coverage reaches the run's window. A new run must
 * also have finished after the request.
 */
async function syncAndExpectSuccess(id: string) {
  const requestedAt = Date.now();
  const request = requestAccountSync(id) as { status: string; runId?: string };
  expect(["started", "busy"]).toContain(request.status);
  const runId = request.runId!;
  await expect
    .poll(() => syncRunStatus(runId)?.status ?? "missing", {
      timeout: 120_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .toMatch(/^(succeeded|partial|failed|cancelled|missing)$/);
  const run = syncRunStatus(runId) as { status: string; window?: { to: string } } | null;
  expect(run?.status).toBe("succeeded");

  const state = (await account(admin, id))?.sync;
  expect(state?.lastRunStatus).toBe("succeeded");
  expect(state?.lastSuccessAt).toBeDefined();
  expect(state?.coveredThrough).toBeDefined();
  if (run?.window) expect(state!.coveredThrough! >= run.window.to).toBe(true);
  if (request.status === "started") {
    expect(Date.parse(state!.lastSuccessAt!)).toBeGreaterThanOrEqual(requestedAt - 1_000);
  }
}

/** The Meta Ads section of /connections (every Meta assertion is scoped to it). */
const metaSection = () => page.getByRole("region", { name: "Meta Ads" });
const googleSection = () => page.getByRole("region", { name: "Google Ads" });

test.beforeAll(async ({ browser, baseURL }) => {
  urls = await assertLocalSetup();
  expect(isLoopbackUrl(baseURL ?? "")).toBe(true);
  // Self-healing start: an interrupted earlier run may have left the test org connected.
  await cleanupE2EOrg(urls.backendUrl, E2E_META_ORG);
  admin = await apiClient(urls.backendUrl, { org: E2E_META_ORG, role: "admin" });
  devOrgBefore = await devOrgSnapshot(urls.backendUrl);

  // Fixtures in the same throwaway org (mock consent through the API, no browser): a Google
  // Ads connection with one linked, synced client account, and an Instagram connection with
  // its linked account. Their state must survive the Meta journey unchanged.
  fixtures.google = await connectMockFixture(urls.backendUrl, E2E_META_ORG, "google_ads");
  const [google] = (await admin.mutation(api.v1.connections.linkAdAccounts, {
    connectionId: fixtures.google,
    externalIds: [GOOGLE_CLIENT],
  })) as AdAccount[];
  fixtures.googleAccount = google!.id;
  await syncAndExpectSuccess(fixtures.googleAccount);

  fixtures.instagram = await connectMockFixture(urls.backendUrl, E2E_META_ORG, "instagram");
  const discovered = (await admin.query(api.v1.connections.listDiscoveredSocialAccounts, {
    connectionId: fixtures.instagram,
  })) as { externalId: string }[];
  const [social] = (await admin.mutation(api.v1.connections.linkSocialAccounts, {
    connectionId: fixtures.instagram,
    externalIds: [discovered[0]!.externalId],
  })) as SocialAccount[];
  fixtures.socialAccount = social!.id;

  const browserToken = await e2eToken({ org: E2E_META_ORG, role: "admin" });
  context = await browser.newContext();
  // Nothing may leave the machine; facebook.com in particular is never reached.
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
  // Always leave the test org disconnected (Meta and the fixtures), then prove dev-org was
  // never touched.
  await cleanupE2EOrg(urls.backendUrl, E2E_META_ORG);
  expect(await devOrgSnapshot(urls.backendUrl)).toEqual(devOrgBefore);
  expect(blockedHosts).toEqual([]);
  expect(blockedSockets).toEqual([]);
});

test("connects Meta Ads, discovers ad accounts in Meta words, links one, syncs it and opens its analytics", async () => {
  await page.goto("/connections");
  // Identity guard: nothing is clicked unless the dashboard acts as the throwaway org.
  const badge = page.getByTestId("org-badge");
  await expect(badge).toContainText(E2E_META_ORG_NAME, { timeout: 30_000 });
  await expect(badge).toContainText("admin");
  expect(authSwaps).toBeGreaterThan(0);
  const meta = metaSection();
  await expect(meta.getByText("Meta Ads is not connected.")).toBeVisible();
  // The Google Ads fixture is shown on its own card.
  await expect(googleSection().getByText("Google Ads is connected.")).toBeVisible();

  // Connect: the mock consent sends the browser straight to the local OAuth callback.
  const callback = page.waitForRequest((r) => r.url().startsWith(`${urls.siteOrigin}/oauth/`));
  await meta.getByRole("button", { name: "Connect Meta Ads", exact: true }).click();
  expect((await callback).url().startsWith(`${urls.siteOrigin}/oauth/callback?`)).toBe(true);

  // Back on /connections: the Meta notice, result parameters and provider hint removed.
  await expect(page.getByLabel("Meta Ads connected")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return url.pathname === "/connections" && !RESULT_PARAMS.some((p) => url.searchParams.has(p));
    })
    .toBe(true);

  // Discovery: Meta columns (no account type or test status), Meta ids and business, Meta words.
  const table = meta.getByRole("table", { name: "Discovered Meta Ads accounts" });
  await expect(table).toBeVisible({ timeout: 30_000 });
  await expect(table.getByRole("columnheader")).toHaveText([
    "Select",
    "Account",
    "Currency / time zone",
    "Status",
    "Business",
    "Availability",
  ]);
  const accountRow = table.getByRole("row").filter({ hasText: META_ACCOUNT.name });
  await expect(accountRow).toContainText(META_ACCOUNT.externalId);
  await expect(accountRow).toContainText(META_ACCOUNT.business);
  await expect(accountRow).toContainText("USD · America/New_York");
  await expect(table.getByRole("row").filter({ hasText: DISABLED_ACCOUNT.name })).toContainText(
    "Disabled",
  );
  await expect(meta.getByText("Select one ad account.")).toBeVisible();
  await expect(meta).not.toContainText("Google");

  // Link exactly one ad account.
  const radio = meta.getByRole("radio", { name: new RegExp(META_ACCOUNT.name) });
  await expect(radio).toBeEnabled();
  await radio.check();
  await meta.getByRole("button", { name: "Link selected account" }).click();
  await expect(meta.getByLabel("Account linked")).toContainText(
    `${META_ACCOUNT.name} (${META_ACCOUNT.externalId}) is linked`,
  );

  // Server state: one active Meta connection, exactly one linked Meta ad account.
  const connections = await connectionsOf(admin, "meta");
  expect(connections).toHaveLength(1);
  metaConnectionId = connections[0]!.id;
  const accounts: AdAccount[] = await admin.query(api.v1.adAccounts.list, {});
  const linked = accounts.filter((a) => a.platform === "meta" && a.linked);
  expect(linked.map((a) => a.externalId)).toEqual([META_ACCOUNT.externalId]);
  expect(linked[0]!.connectionId).toBe(metaConnectionId);
  metaAccountId = linked[0]!.id;

  const row = meta
    .getByRole("table", { name: /Linked Meta Ads accounts/ })
    .getByRole("row")
    .filter({ hasText: META_ACCOUNT.name });
  await expect(row).toBeVisible();

  // Sync exactly this account (never the org-wide planner); its run must succeed and set coverage.
  await syncAndExpectSuccess(metaAccountId);
  const synced = (await account(admin, metaAccountId))?.sync;
  expect(synced?.coveredFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(synced?.coveredThrough).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(synced!.coveredFrom! <= synced!.coveredThrough!).toBe(true);
  await expect(row).toContainText("Up to date", { timeout: 30_000 });
  await expect(row).toContainText(`Data through ${synced!.coveredThrough}.`);
  await expectNoSeriousA11yViolations(page);

  // Analytics: the Overview filtered to this Meta account shows Meta data only.
  await row.getByRole("link", { name: `View analytics for ${META_ACCOUNT.name}` }).click();
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return url.pathname === "/" && url.searchParams.get("accounts") === metaAccountId;
    })
    .toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accounts 1 account" })).toBeVisible();
  await expect(page.getByTestId("overview-totals")).toBeVisible({ timeout: 30_000 });
  const split = page.getByRole("region", { name: "Spend by platform" });
  await expect(split).toContainText("Meta", { timeout: 30_000 });
  await expect(split).not.toContainText("Google Ads");
  // Without the filter, the org's synced Google Ads fixture appears too: the filter did it.
  await page.goto("/");
  await expect(page.getByTestId("org-badge")).toContainText(E2E_META_ORG_NAME, {
    timeout: 30_000,
  });
  await expect(split).toContainText("Google Ads", { timeout: 30_000 });
  await expect(split).toContainText("Meta");
});

test("disconnecting Meta Ads from the page leaves Google Ads and Instagram unaffected", async () => {
  expect(metaConnectionId && metaAccountId).toBeTruthy();
  await page.goto("/connections");
  const badge = page.getByTestId("org-badge");
  await expect(badge).toContainText(E2E_META_ORG_NAME, { timeout: 30_000 });
  await expect(badge).toContainText("admin");
  const meta = metaSection();

  // Cancel first: nothing changes.
  const disconnectButton = meta.getByRole("button", { name: "Disconnect Meta Ads" });
  const confirmation = meta.getByRole("group", { name: "Disconnect Meta Ads?" });
  await disconnectButton.click();
  await expect(confirmation).toContainText("any Facebook account");
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  expect((await connectionsOf(admin, "meta")).map((c) => c.id)).toEqual([metaConnectionId]);

  // Confirm: the server revokes the Meta connection.
  await disconnectButton.click();
  await confirmation.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(meta.getByLabel("Meta Ads disconnected")).toBeVisible({ timeout: 30_000 });
  await expect(meta.getByText("Meta Ads is not connected.")).toBeVisible();
  await expect(meta.getByText("No Meta Ads account linked yet")).toBeVisible();

  const stored: Connection = await admin.query(api.v1.connections.get, {
    connectionId: metaConnectionId,
  });
  expect(stored.status).toBe("revoked");
  const unlinked = await account(admin, metaAccountId);
  expect(unlinked?.linked).toBe(false);
  expect(unlinked?.connectionId).toBeUndefined();
  expect(
    await admin.query(api.v1.connections.listDiscoveredAssets, { connectionId: metaConnectionId }),
  ).toEqual([]);
  expect(requestAccountSync(metaAccountId)).toMatchObject({
    status: "rejected",
    reason: "account_unlinked",
  });
  expect(await connectionsOf(admin, "meta")).toEqual([]);

  // Google Ads and Instagram (organic) are untouched.
  expect((await connectionsOf(admin, "google_ads")).map((c) => [c.id, c.status])).toEqual([
    [fixtures.google, "active"],
  ]);
  expect(await account(admin, fixtures.googleAccount)).toMatchObject({
    linked: true,
    connectionId: fixtures.google,
  });
  expect((await connectionsOf(admin, "instagram")).map((c) => [c.id, c.status])).toEqual([
    [fixtures.instagram, "active"],
  ]);
  expect(await socialAccount(admin, fixtures.socialAccount)).toMatchObject({
    linked: true,
    connectionId: fixtures.instagram,
  });
  await expect(googleSection().getByText("Google Ads is connected.")).toBeVisible();
  // Instagram never appears on the Connections page.
  await expect(page.getByRole("main")).not.toContainText("Instagram");
});
