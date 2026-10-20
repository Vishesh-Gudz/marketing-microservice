#!/usr/bin/env node
// Google Ads tester (DEV / VALIDATION TOOLING ONLY). Acts as the PARENT APP: it uses only the
// public v1 API with short-lived dev-issuer JWTs minted in this process (never printed), on
// ONE allowlisted validation deployment verified through the Convex CLI (see
// scripts/google-ads-tester/guard.mjs). It never changes deployment settings, never enables
// live mode, never links more than one explicitly confirmed account, and prints sanitized,
// read-only results (T2). Production, local and loopback targets are refused.
//
//   node scripts/google-ads-tester.mjs <command> --deployment <name> [options]
//
//   guard-check                 verify the target (allowlist, CLI identity, role, config)
//   connect                     start Google OAuth (one-time loopback redirect) and wait
//   discover [--connection id]  list discovered accounts with type / relation / test status
//   link --customer <id> [--connection id] [--allow-non-test-account]
//                               link exactly ONE confirmed client (typed confirmation)
//   status                      connection health and per-account sync state
//   report [--days N]           v1 analytics overview, coverage and campaigns (read-only)
//
// Prerequisites: `npm run dev:auth setup` (dev issuer keys), a Convex CLI login with access
// to the project, and `.google-ads-tester.local.json` (git-ignored):
//   { "validationDeployment": "<dev deployment name>", "org": "gads-validation" }
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { DEV_RETURN_URLS, mintToken } from "./dev-auth.mjs";
import {
  accountSyncLines,
  campaignLines,
  connectionLines,
  overviewLines,
} from "./google-ads-tester/format.mjs";
import {
  CONFIG_FILE,
  GuardError,
  parseConfig,
  verifyDeployment,
} from "./google-ads-tester/guard.mjs";
import { startOneTimeRedirect } from "./google-ads-tester/oauth.mjs";
import { createOutput } from "./google-ads-tester/redact.mjs";
import {
  confirmationMatches,
  describeAssetLine,
  formatCustomerId,
  selectForLink,
} from "./google-ads-tester/select.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONVEX_BIN = join(ROOT, "node_modules", "convex", "bin", "main.js");
const TOKEN_TTL_SECONDS = 300;
const WAIT_MS = 10 * 60_000;

export const COMMANDS = ["guard-check", "connect", "discover", "link", "status", "report"];
const VALUE_FLAGS = new Set(["deployment", "customer", "connection", "days", "port"]);
const BOOLEAN_FLAGS = new Set(["allow-non-test-account"]);

export class UsageError extends Error {}

/** Strict argument parsing: known command, known flags, no repeated flags. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) {
    throw new UsageError(`Unknown command. Use one of: ${COMMANDS.join(", ")}.`);
  }
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument "${arg}".`);
    const name = arg.slice(2);
    if (name in flags) throw new UsageError(`--${name} given twice.`);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--"))
        throw new UsageError(`--${name} needs a value.`);
      flags[name] = value;
    } else {
      throw new UsageError(`Unknown option --${name}.`);
    }
  }
  if (flags.days !== undefined && !/^(?:[1-9]|[1-8]\d|90)$/.test(flags.days)) {
    throw new UsageError("--days must be 1-90.");
  }
  if (flags.port !== undefined && !/^\d{4,5}$/.test(flags.port)) {
    throw new UsageError("--port must be a port number.");
  }
  return { command, flags };
}

/** The connection to act on: the given id (Google only), else the newest active Google one. */
export function pickConnection(connections, requestedId) {
  const google = connections.filter((c) => c.provider === "google_ads");
  if (requestedId !== undefined) {
    const found = google.find((c) => c.id === requestedId);
    if (!found) throw new UsageError("No Google Ads connection with that id in this org.");
    return found;
  }
  const active = google
    .filter((c) => c.status === "active")
    .sort((a, b) => (a.connectedAt < b.connectedAt ? 1 : -1));
  if (active.length === 0)
    throw new UsageError("No active Google Ads connection; run `connect` first.");
  return active[0];
}

/**
 * Inherited variables that select, authenticate or resolve a Convex deployment. A deploy key
 * (either name) or a self-hosted URL + admin key take precedence over an explicit
 * `--deployment` in the Convex CLI; a shell CONVEX_DEPLOYMENT would replace the project's
 * `.env.local` value (which resolves `--prod`); CONVEX_PROVISION_HOST replaces the Convex
 * control plane that reports the deployment identity; CONVEX_OVERRIDE_ACCESS_TOKEN replaces
 * the operator's own CLI login. The CLI still reads the project's own `.env.local`.
 */
export const CONVEX_SELECTION_ENV_VARS = [
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_DEPLOYMENT",
  "CONVEX_PROVISION_HOST",
  "CONVEX_OVERRIDE_ACCESS_TOKEN",
];

/**
 * A copy of `env` for the Convex CLI child without deployment-selecting variables (matched
 * case-insensitively: Windows environment names are). `env` itself is never modified.
 */
export function convexChildEnv(env) {
  const child = { ...env };
  for (const name of Object.keys(child)) {
    if (CONVEX_SELECTION_ENV_VARS.includes(name.toUpperCase())) delete child[name];
  }
  return child;
}

function runConvex(args) {
  // The target is always explicit (--deployment / --prod); nothing inherited may redirect it.
  const result = spawnSync(process.execPath, [CONVEX_BIN, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: convexChildEnv(process.env),
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function loadConfig() {
  const path = join(ROOT, CONFIG_FILE);
  if (!existsSync(path)) {
    throw new GuardError(
      "config",
      `Missing ${CONFIG_FILE}. Create it with {"validationDeployment": "<dev deployment>"}.`,
    );
  }
  return parseConfig(readFileSync(path, "utf8"));
}

/** A v1 client whose every call carries a fresh short-lived JWT for the configured org. */
function apiClient(target, role) {
  const client = new ConvexHttpClient(target.cloudUrl);
  const authed = async () =>
    client.setAuth(
      await mintToken({
        org: target.org,
        role,
        sub: "google-ads-tester",
        name: "Google Ads tester",
        ttlSeconds: TOKEN_TTL_SECONDS,
      }),
    );
  return {
    query: async (fn, args = {}) => (await authed(), client.query(fn, args)),
    mutation: async (fn, args = {}) => (await authed(), client.mutation(fn, args)),
    action: async (fn, args = {}) => (await authed(), client.action(fn, args)),
  };
}

function apiErrorText(error) {
  const data = error?.data;
  if (data && typeof data === "object" && typeof data.code === "string") {
    const reason = data.details?.reason ? ` (${data.details.reason})` : "";
    return `${data.code}${reason}: ${data.message ?? ""}`;
  }
  return "The request failed.";
}

async function askTyped(question) {
  if (!process.stdin.isTTY) {
    throw new UsageError("Linking needs an interactive terminal for the typed confirmation.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function printDiscovery(out, api, connection) {
  const assets = await api.query(anyApi.v1.connections.listDiscoveredAssets, {
    connectionId: connection.id,
  });
  out.line(`Discovered accounts for connection ${connection.id} (${assets.length}):`);
  out.line(
    "  testAccountStatus: test | not_test | unknown (unknown = Google did not report it; never assumed)",
  );
  for (const asset of assets) out.line(`  ${describeAssetLine(asset)}`);
  const unknownType = assets.filter((a) => a.managerStatus === "unknown").length;
  const unknownTest = assets.filter((a) => a.testAccountStatus === "unknown").length;
  out.line(
    `  managers=${assets.filter((a) => a.managerStatus === "manager").length} clients=${assets.filter((a) => a.managerStatus === "client").length} unknownType=${unknownType} unknownTestStatus=${unknownTest}`,
  );
  return assets;
}

async function connect(out, target, flags) {
  if (target.providerMode !== "live") {
    out.line(
      `Live provider mode is not enabled on ${target.deployment} (PROVIDER_MODE=${target.providerMode}). Enabling it is an approved operator step outside this tool.`,
    );
    return 1;
  }
  const api = apiClient(target, "admin");
  const before = new Set((await api.query(anyApi.v1.connections.list)).map((c) => c.id));
  const auditPage = (
    await api.query(anyApi.v1.audit.list, {
      paginationOpts: { numItems: 50, cursor: null },
    })
  ).page;
  const seenAudit = new Set(auditPage.map((a) => a.id));

  const { authorizeUrl } = await api.action(anyApi.v1.connections.beginConnect, {
    provider: "google_ads",
    returnUrl: DEV_RETURN_URLS[0],
  });
  const url = new URL(authorizeUrl);
  const p = url.searchParams;
  const expectedRedirect = `${target.siteUrl}/oauth/callback`;
  if (`${url.origin}${url.pathname}` !== "https://accounts.google.com/o/oauth2/v2/auth") {
    out.line("Refusing: the authorization endpoint is not Google's.");
    return 1;
  }
  if (p.get("redirect_uri") !== expectedRedirect) {
    out.line(`Refusing: redirect_uri does not match ${expectedRedirect}.`);
    return 1;
  }
  out.line(`redirect_uri verified: ${expectedRedirect}`);
  out.line(
    `scope=${p.get("scope")} | access_type=${p.get("access_type")} | prompt=${p.get("prompt")} | PKCE=${p.get("code_challenge_method")}`,
  );

  const redirect = startOneTimeRedirect(authorizeUrl, {
    ...(flags.port !== undefined ? { port: Number(flags.port) } : {}),
  });
  await redirect.listening;
  out.line(`Open ${redirect.startUrl} in the browser you sign in to Google with (single use).`);
  out.line("Waiting up to 10 minutes for the OAuth callback...");

  const deadline = Date.now() + WAIT_MS;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      const connections = (await api.query(anyApi.v1.connections.list)).filter(
        (c) => !before.has(c.id),
      );
      if (connections.length > 0) {
        const connection = connections[0];
        out.line(`Connected: ${connectionLines([connection])[0]}`);
        await printDiscovery(out, api, connection);
        return 0;
      }
      const audits = (
        await api.query(anyApi.v1.audit.list, {
          paginationOpts: { numItems: 50, cursor: null },
        })
      ).page.filter((a) => !seenAudit.has(a.id));
      const failed = audits.find((a) => a.action === "connection.oauth_failed");
      if (failed) {
        const changes = failed.changes ?? {};
        const pick = (k) => (changes[k] ? `${k}=${changes[k].to}` : undefined);
        out.line(
          `OAuth failed: ${["reason", "failureKind", "failureStage", "providerCode"].map(pick).filter(Boolean).join(" | ")}`,
        );
        return 1;
      }
    }
    out.line(
      "Timed out waiting for the OAuth callback (the sign-in request expires after 10 minutes).",
    );
    return 1;
  } finally {
    await redirect.close();
  }
}

async function link(out, target, flags) {
  if (flags.customer === undefined) throw new UsageError("Pass --customer <10-digit customer id>.");
  const api = apiClient(target, "admin");
  const connection = pickConnection(await api.query(anyApi.v1.connections.list), flags.connection);
  const assets = await api.query(anyApi.v1.connections.listDiscoveredAssets, {
    connectionId: connection.id,
  });
  const selection = selectForLink(assets, flags.customer, {
    allowNonTestAccount: flags["allow-non-test-account"] === true,
  });
  if (!selection.ok) {
    out.line(`Not linking: ${selection.message}`);
    return 1;
  }
  out.line("Selected account (exactly one):");
  out.line(`  ${describeAssetLine(selection.asset)}`);
  for (const warning of selection.warnings) out.line(`  WARNING: ${warning}`);
  const typed = await askTyped(
    `Type the customer id ${formatCustomerId(selection.asset.externalId)} to link it (read-only sync follows): `,
  );
  if (!confirmationMatches(typed, selection.asset)) {
    out.line("Confirmation did not match. Nothing was linked.");
    return 1;
  }
  const [linked] = await api.mutation(anyApi.v1.connections.linkAdAccounts, {
    connectionId: connection.id,
    externalIds: [selection.asset.externalId],
  });
  out.line(`Linked ${formatCustomerId(linked.externalId)} "${linked.name}".`);
  out.line(
    "Its initial read-only sync is scheduled automatically (the planner runs every 15 minutes). Use `status` to observe it.",
  );
  return 0;
}

async function status(out, target) {
  const api = apiClient(target, "viewer");
  for (const line of connectionLines(await api.query(anyApi.v1.connections.list))) out.line(line);
  for (const line of accountSyncLines(await api.query(anyApi.v1.adAccounts.list))) out.line(line);
  return 0;
}

function utcDay(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function report(out, target, flags) {
  const api = apiClient(target, "viewer");
  const days = Number(flags.days ?? 30);
  const range = { from: utcDay(-days), to: utcDay(-1) };
  const overview = await api.query(anyApi.v1.analytics.overview, { range });
  for (const line of overviewLines(overview)) out.line(line);
  const accounts = (await api.query(anyApi.v1.adAccounts.list)).filter(
    (a) => a.linked && a.platform === "google_ads",
  );
  for (const account of accounts) {
    const page = await api.query(anyApi.v1.analytics.performance, {
      level: "campaign",
      range,
      parent: { accountId: account.id },
      paginationOpts: { numItems: 25, cursor: null },
    });
    out.line(`Campaigns of ${formatCustomerId(account.externalId)} "${account.name}":`);
    for (const line of campaignLines(page.page)) out.line(`  ${line}`);
  }
  return 0;
}

/** Every command passes the deployment guard before any token, client or loopback server. */
export async function main(argv) {
  const out = createOutput();
  try {
    const { command, flags } = parseArgs(argv);
    const target = verifyDeployment({
      requested: flags.deployment,
      config: loadConfig(),
      runConvex,
    });
    out.line(
      `Target verified: ${target.deployment} (dev; production is ${target.productionDeployment} and refused) | org=${target.org} | PROVIDER_MODE=${target.providerMode}`,
    );
    switch (command) {
      case "guard-check":
        return 0;
      case "connect":
        return await connect(out, target, flags);
      case "discover": {
        const api = apiClient(target, "admin");
        const connection = pickConnection(
          await api.query(anyApi.v1.connections.list),
          flags.connection,
        );
        await printDiscovery(out, api, connection);
        return 0;
      }
      case "link":
        return await link(out, target, flags);
      case "status":
        return await status(out, target);
      case "report":
        return await report(out, target, flags);
    }
    return 1;
  } catch (error) {
    if (error instanceof GuardError) out.line(`Refused (${error.step}): ${error.message}`);
    else if (error instanceof UsageError) out.line(`Usage: ${error.message}`);
    else out.line(`Error: ${apiErrorText(error)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
