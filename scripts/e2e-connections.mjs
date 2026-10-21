#!/usr/bin/env node
// Connections journey test helpers (LOCAL DEVELOPMENT ONLY), shared by
// playwright.connections.config.mts, tests/e2e/connections-journey.spec.mts (Google Ads),
// tests/e2e/meta-ads-journey.spec.mts (Meta Ads) and the manual cleanup command:
//
//   node scripts/e2e-connections.mjs cleanup
//
// Everything happens in the throwaway orgs "e2e-google-ads" and "e2e-meta-ads" on the LOCAL
// Convex deployment in mock provider mode. Guards fail closed: the backend and callback URLs
// must be loopback, the Convex CLI must target a local deployment (the project's local or an
// anonymous local deployment; never a cloud one), PROVIDER_MODE there must be unset (mock on
// loopback) or "mock", and the dashboard's backend must be that same deployment (matching
// `/instance_name`). Tokens are minted in memory with the dev issuer and never printed or
// written anywhere. Only the public v1 API is used, plus `sync/admin:requestSync` for ONE ad
// account of a throwaway org at a time (never the org-wide planner) and the read-only
// `sync/admin:runStatus` for the run it answers with.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { mintToken } from "./dev-auth.mjs";
import { convexChildEnv } from "./google-ads-tester.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONVEX_BIN = join(ROOT, "node_modules", "convex", "bin", "main.js");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const IDENTITY_PROBE = "E2E_CONNECTIONS_IDENTITY_PROBE";
const CONVEX_ID = /^[a-z0-9]{1,64}$/;

export const E2E_ORG = "e2e-google-ads";
export const E2E_OTHER_ORG = "e2e-google-ads-other";
export const E2E_ORG_NAME = "E2E Google Ads";
/** The Meta Ads journey's throwaway org (tests/e2e/meta-ads-journey.spec.mts). */
export const E2E_META_ORG = "e2e-meta-ads";
export const E2E_META_ORG_NAME = "E2E Meta Ads";
export const E2E_PORT = 3000;
export const DEV_ORG = "dev-org";

/**
 * The throwaway orgs the journeys may change (name claim per org); cleanup and fixture
 * connections refuse every other org. Per org, the providers its cleanup disconnects.
 */
const THROWAWAY_ORGS = new Map([
  [E2E_ORG, { name: E2E_ORG_NAME, providers: ["google_ads"] }],
  [E2E_META_ORG, { name: E2E_META_ORG_NAME, providers: ["meta", "google_ads", "instagram"] }],
]);

function throwawayOrg(org) {
  const entry = THROWAWAY_ORGS.get(org);
  if (entry === undefined) throw new E2EGuardError("only the throwaway journey orgs may change.");
  return entry;
}

export class E2EGuardError extends Error {
  constructor(message) {
    super(`E2E guard: ${message}`);
    this.name = "E2EGuardError";
  }
}

export function isLoopbackUrl(url) {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** A public NEXT_PUBLIC_* value as Next resolves it: process env first, then `.env.local`. */
function publicEnv(name) {
  if (process.env[name]) return process.env[name];
  const path = join(ROOT, ".env.local");
  if (!existsSync(path)) return undefined;
  const match = new RegExp(`^${name}=(.+)$`, "m").exec(readFileSync(path, "utf8"));
  return match ? match[1].trim() : undefined;
}

/** The local backend (client) URL and the local HTTP-actions (OAuth callback) origin; loopback only. */
export function localUrls() {
  const backend = publicEnv("NEXT_PUBLIC_CONVEX_URL");
  const site = publicEnv("NEXT_PUBLIC_CONVEX_SITE_URL");
  for (const [name, value] of [
    ["NEXT_PUBLIC_CONVEX_URL", backend],
    ["NEXT_PUBLIC_CONVEX_SITE_URL", site],
  ]) {
    if (!value || !isLoopbackUrl(value) || new URL(value).protocol !== "http:") {
      throw new E2EGuardError(`${name} must be a loopback http URL (local deployment only).`);
    }
  }
  return { backendUrl: new URL(backend).origin, siteOrigin: new URL(site).origin };
}

/** ANSI color codes (Playwright workers force colors; the CLI bolds its deployment label). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function runConvex(args) {
  const result = spawnSync(process.execPath, [CONVEX_BIN, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...convexChildEnv(process.env), NO_COLOR: "1", FORCE_COLOR: "0" },
    timeout: 120_000,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").replace(ANSI, ""),
    stderr: (result.stderr ?? "").replace(ANSI, ""),
  };
}

/**
 * Deployment types that run on this machine: the project's local deployment and an anonymous
 * local deployment (`CONVEX_AGENT_MODE=anonymous`, docs/setup.md), e.g. a separate mock backend
 * for the journeys. Cloud deployments ("dev", "prod", "preview") are never accepted.
 */
const LOCAL_DEPLOYMENT_TYPES = new Set(["local", "anonymous"]);

/**
 * The Convex CLI must target a LOCAL deployment (an `env get` probe of a variable that does
 * not exist prints only "(on <type> deployment <name>)"), and PROVIDER_MODE there must be unset
 * or "mock". Anything else (cloud, live, unreadable) refuses. Returns the deployment name.
 */
export function assertLocalMockDeployment() {
  const probe = runConvex(["env", "get", IDENTITY_PROBE]);
  const labels = [
    ...`${probe.stdout}\n${probe.stderr}`.matchAll(/\(on (\w+) deployment ([\w-]+)\)/g),
  ];
  if (labels.length !== 1 || !LOCAL_DEPLOYMENT_TYPES.has(labels[0][1])) {
    throw new E2EGuardError("the Convex CLI does not target the local deployment.");
  }
  const mode = runConvex(["env", "get", "PROVIDER_MODE"]);
  const text = `${mode.stdout}\n${mode.stderr}`;
  const unset = /not found/i.test(text) && /\(on (local|anonymous) deployment [\w-]+\)/.test(text);
  const value = mode.stdout.trim();
  if (!unset && value !== "mock") {
    throw new E2EGuardError("PROVIDER_MODE on the local deployment must be unset or mock.");
  }
  return labels[0][2];
}

/**
 * The dashboard's backend (NEXT_PUBLIC_CONVEX_URL) must be the very deployment the Convex CLI
 * targets: its `/instance_name` (public, no credentials) must equal the CLI's local deployment
 * name. Neither value is printed.
 */
export async function assertDashboardUsesCliDeployment(backendUrl, deploymentName) {
  let instance;
  try {
    const response = await fetch(`${backendUrl}/instance_name`, {
      signal: AbortSignal.timeout(10_000),
    });
    instance = response.ok ? (await response.text()).trim() : undefined;
  } catch {
    instance = undefined;
  }
  if (instance === undefined || instance === "" || instance !== deploymentName) {
    throw new E2EGuardError(
      "NEXT_PUBLIC_CONVEX_URL does not point at the local deployment the Convex CLI targets.",
    );
  }
}

/**
 * Every guard of the local setup, in order: loopback dashboard URLs, a local mock deployment
 * behind the Convex CLI, and the dashboard pointing at that same deployment.
 */
export async function assertLocalSetup() {
  const urls = localUrls();
  const deploymentName = assertLocalMockDeployment();
  await assertDashboardUsesCliDeployment(urls.backendUrl, deploymentName);
  return urls;
}

/** A dev-issuer token for (org, role), minted in memory. Never print or store it. */
export async function e2eToken({ org, role, ttlSeconds = 30 * 60 }) {
  return await mintToken({
    org,
    role,
    sub: `e2e-${role}`,
    ...(THROWAWAY_ORGS.has(org) ? { name: THROWAWAY_ORGS.get(org).name } : {}),
    ttlSeconds,
  });
}

/** A public-API client acting as (org, role). */
export async function apiClient(backendUrl, { org, role }) {
  const client = new ConvexHttpClient(backendUrl);
  client.setAuth(await e2eToken({ org, role }));
  return client;
}

/**
 * Disconnects every connection of a THROWAWAY org that is not revoked yet (an earlier run may
 * have been interrupted): Google Ads for "e2e-google-ads"; Meta Ads and its Google Ads and
 * Instagram fixtures for "e2e-meta-ads". Returns the disconnected connection ids. Only a
 * throwaway org can be touched: the token is minted for it here.
 */
export async function cleanupE2EOrg(backendUrl, org = E2E_ORG) {
  const { providers } = throwawayOrg(org);
  const admin = await apiClient(backendUrl, { org, role: "admin" });
  await admin.mutation(anyApi.v1.orgs.ensure, {});
  const connections = await admin.query(anyApi.v1.connections.list, {});
  const open = connections.filter((c) => providers.includes(c.provider) && c.status !== "revoked");
  for (const connection of open) {
    await admin.mutation(anyApi.v1.connections.disconnect, { connectionId: connection.id });
  }
  return open.map((c) => c.id);
}

/**
 * Connects the mock identity of `provider` for a THROWAWAY org through the real connect flow
 * without a browser: beginConnect → the mock consent, which is the local OAuth callback →
 * its result redirect. Only a loopback authorization URL is ever followed (mock mode), so
 * nothing reaches Google or Meta; the URL is never printed. Returns the connection id.
 */
export async function connectMockFixture(backendUrl, org, provider) {
  throwawayOrg(org);
  const admin = await apiClient(backendUrl, { org, role: "admin" });
  const { authorizeUrl } = await admin.action(anyApi.v1.connections.beginConnect, {
    provider,
    returnUrl: `http://127.0.0.1:${E2E_PORT}/connections`,
  });
  if (!isLoopbackUrl(authorizeUrl)) {
    throw new E2EGuardError("the authorization URL is not the local mock consent.");
  }
  const response = await fetch(authorizeUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const location = response.headers.get("location");
  const params = location ? new URL(location).searchParams : undefined;
  const connectionId = params?.get("connection");
  if (params?.get("status") !== "connected" || !connectionId) {
    throw new Error(`The mock ${provider} connection failed.`);
  }
  return connectionId;
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Read-only snapshot of the stable dev-org facts (a viewer token; queries only, no ensure):
 * connection ids, providers and statuses; ad account ids, external ids, link state; Instagram
 * account ids and link state.
 */
export async function devOrgSnapshot(backendUrl) {
  const viewer = await apiClient(backendUrl, { org: DEV_ORG, role: "viewer" });
  const connections = (await viewer.query(anyApi.v1.connections.list, {}))
    .map((c) => ({ id: c.id, provider: c.provider, status: c.status }))
    .sort(byId);
  const accounts = (await viewer.query(anyApi.v1.adAccounts.list, {}))
    .map((a) => ({
      id: a.id,
      platform: a.platform,
      externalId: a.externalId,
      linked: a.linked,
      connectionId: a.connectionId ?? null,
    }))
    .sort(byId);
  const social = (
    await viewer.query(anyApi.v1.socialAccounts.list, {
      paginationOpts: { cursor: null, numItems: 100 },
    })
  ).page
    .map((s) => ({
      id: s.id,
      platform: s.platform,
      linked: s.linked,
      connectionId: s.connectionId ?? null,
    }))
    .sort(byId);
  return { connections, accounts, social };
}

/**
 * Starts a sync of ONE ad account (the operator function `sync/admin:requestSync` on the local
 * deployment). Never the org-wide planner. Returns { status, runId?, reason? }.
 */
export function requestAccountSync(adAccountId) {
  if (!CONVEX_ID.test(adAccountId)) throw new E2EGuardError("invalid ad account id.");
  const result = runConvex(["run", "sync/admin:requestSync", JSON.stringify({ adAccountId })]);
  const start = result.stdout.indexOf("{");
  if (result.status !== 0 || start < 0) throw new Error("requestSync failed.");
  return JSON.parse(result.stdout.slice(start));
}

/**
 * The state of ONE sync run (the read-only operator query `sync/admin:runStatus` on the local
 * deployment; no cursors or leases). Returns { status, kind, window?, ... }, or null for an
 * unknown run.
 */
export function syncRunStatus(runId) {
  if (!CONVEX_ID.test(runId)) throw new E2EGuardError("invalid sync run id.");
  const result = runConvex(["run", "sync/admin:runStatus", JSON.stringify({ runId })]);
  if (result.status !== 0) throw new Error("runStatus failed.");
  const start = result.stdout.indexOf("{");
  return start < 0 ? null : JSON.parse(result.stdout.slice(start));
}

async function main(argv) {
  if (argv[0] !== "cleanup") {
    console.log("Usage: node scripts/e2e-connections.mjs cleanup");
    return 1;
  }
  const { backendUrl } = await assertLocalSetup();
  for (const org of THROWAWAY_ORGS.keys()) {
    const disconnected = await cleanupE2EOrg(backendUrl, org);
    console.log(
      `Disconnected ${disconnected.length} leftover connection(s) of org "${org}" on the local deployment.`,
    );
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof E2EGuardError ? error.message : "Cleanup failed.");
      process.exit(1);
    },
  );
}
