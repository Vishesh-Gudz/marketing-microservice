import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import { DEV_RETURN_URLS, mintToken } from "../../scripts/dev-auth.mjs";

// Opt-in (`npm run test:live`): a complete mock sync on the REAL Convex runtime
// (scheduler, action/mutation limits, pagination limits) rather than convex-test.
// The public API connects and links; the internal operator functions
// (`sync/admin:*`, reachable only with deployment credentials via the CLI)
// start the sync and report status. Prerequisites: `npm run dev:backend` +
// `npm run dev:auth setup`.

function envLocal(name: string): string | undefined {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return undefined;
  return new RegExp(`^${name}=(.+)$`, "m").exec(readFileSync(path, "utf8"))?.[1]?.trim();
}

const url = process.env.NEXT_PUBLIC_CONVEX_URL ?? envLocal("NEXT_PUBLIC_CONVEX_URL") ?? "";
const run = Date.now().toString(36);
const returnUrl = `${DEV_RETURN_URLS[0]}settings/connections`;
const CONVEX_BIN = join(process.cwd(), "node_modules", "convex", "bin", "main.js");

/** `npx convex run <fn> <args>` (internal functions need deployment credentials). */
function convexRun<T>(fn: string, args: Record<string, unknown>): T {
  const result = spawnSync(process.execPath, [CONVEX_BIN, "run", fn, JSON.stringify(args)], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`convex run ${fn} failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}

type RunStatus = {
  status: string;
  kind: string;
  counts: Record<string, number>;
  tasks: { status: string }[];
} | null;

async function waitForRun(runId: string, timeoutMs = 90_000): Promise<NonNullable<RunStatus>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = convexRun<RunStatus>("sync/admin:runStatus", { runId });
    if (status && !["queued", "running"].includes(status.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`run ${runId} did not finish in ${timeoutMs} ms`);
}

async function client(org: string) {
  const c = new ConvexHttpClient(url);
  c.setAuth(await mintToken({ org, role: "admin", sub: `admin-${org}` }));
  await c.mutation(api.v1.orgs.ensure, {});
  return c;
}

beforeAll(() => {
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL not found. Run `npm run dev:backend`.");
});

describe("live sync (mock providers, real runtime)", () => {
  it.each([
    ["meta", "1001"],
    ["google_ads", "1112223333"],
  ] as const)("syncs %s %s completely and idempotently", async (provider, externalId) => {
    const admin = await client(`live-sync-${provider}-${run}`);
    const { authorizeUrl } = await admin.action(api.v1.connections.beginConnect, {
      provider,
      returnUrl,
    });
    const callback = await fetch(authorizeUrl, { redirect: "manual" });
    const connectionId = new URL(callback.headers.get("location")!).searchParams.get("connection")!;
    const [account] = await admin.mutation(api.v1.connections.linkAdAccounts, {
      connectionId,
      externalIds: [externalId],
    });

    const started = convexRun<{ status: string; runId: string }>("sync/admin:requestSync", {
      adAccountId: account!.id,
    });
    expect(started.status).toBe("started");
    const first = await waitForRun(started.runId);
    expect(first.kind).toBe("initial");
    expect(first.status).toBe("succeeded");
    expect(first.tasks.every((t) => t.status === "succeeded")).toBe(true);
    expect(first.counts.metricRows).toBeGreaterThan(0);
    expect(first.counts.actionRows).toBeGreaterThan(0);
    expect(first.counts.unresolved).toBe(0);

    // Same window again: nothing new is inserted, nothing is pruned.
    const again = convexRun<{ status: string; runId: string }>("sync/admin:requestSync", {
      adAccountId: account!.id,
      kind: "lookback",
    });
    expect(again.status).toBe("started");
    const second = await waitForRun(again.runId);
    expect(second.status).toBe("succeeded");
    expect(second.counts.inserted).toBe(0);
    expect(second.counts.pruned).toBe(0);

    const state = convexRun<{ state: string; coveredFrom?: string; coveredThrough?: string }>(
      "sync/admin:accountState",
      {
        adAccountId: account!.id,
      },
    );
    expect(state.state).toBe("idle");
    expect(state.coveredThrough).toBeDefined();
    expect(JSON.stringify([first, second, state])).not.toContain("mock-token");

    // Phase 6: analytics over real HTTP (real JWT, real runtime, real read limits).
    const range = { from: state.coveredFrom!, to: state.coveredThrough! };
    const overview = await admin.query(api.v1.analytics.overview, {
      range,
      compare: "previous_period",
    });
    expect(overview.accountCount).toBe(1);
    expect(overview.totals.dataState).toBe("reported");
    expect(overview.totals.metrics.impressions).toBeGreaterThan(0);
    expect(overview.totals.metrics.spend?.native).toHaveLength(1);
    expect(typeof overview.totals.kpis.ctr).toBe("number");
    const campaigns = await admin.query(api.v1.analytics.performance, {
      level: "campaign",
      range,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(campaigns.page.length).toBeGreaterThan(0);
    const actions = await admin.query(api.v1.analytics.actions, { range });
    expect(actions.groups.length).toBeGreaterThan(0);
  });
});
