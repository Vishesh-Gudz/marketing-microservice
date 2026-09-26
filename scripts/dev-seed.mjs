#!/usr/bin/env node
// Local development data for the dashboard. DEV ONLY (mock providers, dev issuer).
//
//   npm run dev:seed [-- --org dev-org] [-- --resync]
//
// Seeds the org of the dashboard token written by `npm run dev:auth setup` ("dev-org"):
// connects the mock Meta and Google Ads providers and links their accounts through the
// PUBLIC v1 API (exactly like a parent app would), then runs the initial sync of each
// account with the internal operator functions `sync/admin:*` via the Convex CLI (they
// need deployment credentials and are never reachable from the dashboard).
//
// Idempotent: existing active connections and linked accounts are reused, and accounts
// that already have synced coverage are skipped unless --resync is given. Prints no
// tokens, authorization URLs or codes. Prerequisites: `npm run dev:backend` running and
// `npm run dev:auth setup` done once.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { DEV_RETURN_URLS, mintToken } from "./dev-auth.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONVEX_BIN = join(ROOT, "node_modules", "convex", "bin", "main.js");

/** Mock accounts to link (see convex/providers/mock): two currencies per platform. */
const SEED = [
  { provider: "meta", externalIds: ["1001", "1002"] },
  { provider: "google_ads", externalIds: ["1112223333", "4445556666"] },
];

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const next = process.argv[index + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

function convexUrl() {
  if (process.env.NEXT_PUBLIC_CONVEX_URL) return process.env.NEXT_PUBLIC_CONVEX_URL;
  const envPath = join(ROOT, ".env.local");
  const match = existsSync(envPath)
    ? /^NEXT_PUBLIC_CONVEX_URL=(.+)$/m.exec(readFileSync(envPath, "utf8"))
    : null;
  if (!match) throw new Error("NEXT_PUBLIC_CONVEX_URL not found. Run `npm run dev:backend` first.");
  return match[1].trim();
}

/** `convex run` for internal operator functions (deployment credentials, no shell). */
function convexRun(fn, args) {
  const result = spawnSync(process.execPath, [CONVEX_BIN, "run", fn, JSON.stringify(args)], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`convex run ${fn} failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function waitForRun(runId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = convexRun("sync/admin:runStatus", { runId });
    if (status && !["queued", "running"].includes(status.status)) return status;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`Sync run ${runId} did not finish within ${timeoutMs / 1000}s.`);
}

async function connect(client, provider) {
  const { authorizeUrl } = await client.action(anyApi.v1.connections.beginConnect, {
    provider,
    returnUrl: DEV_RETURN_URLS[0],
  });
  // The mock provider's consent screen redirects straight to the Convex callback,
  // which stores the (mock) credential and redirects to the return URL.
  const response = await fetch(authorizeUrl, { redirect: "manual" });
  const location = response.headers.get("location");
  const params = location ? new URL(location).searchParams : undefined;
  const connectionId = params?.get("connection");
  if (!connectionId || params?.get("status") !== "connected") {
    throw new Error(
      `Connecting ${provider} failed (status ${params?.get("status") ?? "unknown"}).`,
    );
  }
  return connectionId;
}

async function main() {
  const org = typeof flag("org") === "string" ? flag("org") : "dev-org";
  const resync = flag("resync") === true;
  const client = new ConvexHttpClient(convexUrl());
  client.setAuth(
    await mintToken({ org, role: "admin", sub: "dev-seed", name: "Dev Organization" }),
  );
  await client.mutation(anyApi.v1.orgs.ensure, {});
  console.log(`Seeding org "${org}"…`);

  const connections = await client.query(anyApi.v1.connections.list, {});
  let accounts = await client.query(anyApi.v1.adAccounts.list, {});

  for (const { provider, externalIds } of SEED) {
    const existing = connections.find((c) => c.provider === provider && c.status === "active");
    const connectionId = existing?.id ?? (await connect(client, provider));
    console.log(`  ${provider}: connection ${existing ? "reused" : "created"}`);
    const linked = new Set(
      accounts.filter((a) => a.platform === provider && a.linked).map((a) => a.externalId),
    );
    const toLink = externalIds.filter((id) => !linked.has(id));
    if (toLink.length > 0) {
      await client.mutation(anyApi.v1.connections.linkAdAccounts, {
        connectionId,
        externalIds: toLink,
      });
      console.log(`  ${provider}: linked ${toLink.join(", ")}`);
    }
  }

  accounts = await client.query(anyApi.v1.adAccounts.list, {});
  const seeded = accounts.filter((a) =>
    SEED.some((s) => s.provider === a.platform && s.externalIds.includes(a.externalId)),
  );
  for (const account of seeded) {
    const state = convexRun("sync/admin:accountState", { adAccountId: account.id });
    if (state?.coveredThrough && !resync && state.activeRunId === undefined) {
      console.log(`  ${account.name}: already synced through ${state.coveredThrough}`);
      continue;
    }
    const started = convexRun("sync/admin:requestSync", {
      adAccountId: account.id,
      ...(state?.coveredThrough ? { kind: "lookback" } : {}),
    });
    if (started.status === "rejected") {
      throw new Error(`${account.name}: sync rejected (${started.reason}).`);
    }
    process.stdout.write(`  ${account.name}: syncing…`);
    const run = await waitForRun(started.runId);
    const after = convexRun("sync/admin:accountState", { adAccountId: account.id });
    console.log(` ${run.status} (${after?.coveredFrom ?? "?"} – ${after?.coveredThrough ?? "?"})`);
    if (run.status !== "succeeded") process.exitCode = 1;
  }
  console.log("Done. Open the dashboard: npm run dev:frontend");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
