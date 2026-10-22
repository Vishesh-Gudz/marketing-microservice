// Guard for local-development scripts that write to a Convex deployment (dev-auth, dev-seed).
// They must only ever change the developer's own LOCAL deployment: never a cloud dev, preview or
// production deployment, whatever the shell exports (deploy keys, CONVEX_DEPLOYMENT, ...).

import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { convexChildEnv } from "./google-ads-tester.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONVEX_BIN = join(ROOT, "node_modules", "convex", "bin", "main.js");
const ANSI = /\u001b\[[0-9;]*m/g;
const PROBE = "LOCAL_GUARD_PROBE_UNSET";

/** Deployment types that run on this machine (the project's local backend, or anonymous). */
export const LOCAL_DEPLOYMENT_TYPES = new Set(["local", "anonymous"]);

export class LocalGuardError extends Error {
  constructor(message) {
    super(`Refusing to continue: ${message}`);
    this.name = "LocalGuardError";
  }
}

/** The single "(on <type> deployment <name>)" label the Convex CLI prints, or null. */
export function parseDeploymentLabel(text) {
  const labels = [...text.matchAll(/\(on (\w+) deployment ([\w-]+)\)/g)];
  if (labels.length !== 1) return null;
  return { type: labels[0][1], name: labels[0][2] };
}

/**
 * Runs the Convex CLI against the project's own `.env.local` deployment: inherited deploy keys
 * and deployment selectors are removed (convexChildEnv), so the shell cannot redirect it.
 */
export function runLocalConvex(args, options = {}) {
  const result = spawnSync(process.execPath, [CONVEX_BIN, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...convexChildEnv(process.env), NO_COLOR: "1", FORCE_COLOR: "0" },
    timeout: 120_000,
    ...options,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").replace(ANSI, ""),
    stderr: (result.stderr ?? "").replace(ANSI, ""),
  };
}

/**
 * Throws unless the Convex CLI targets a local or anonymous deployment (probed with
 * `env get` of a variable that does not exist, which prints only the deployment label).
 * Returns the deployment name. `run` is injectable for tests.
 */
export function assertLocalConvexTarget(run = runLocalConvex) {
  const probe = run(["env", "get", PROBE]);
  const label = parseDeploymentLabel(`${probe.stdout}\n${probe.stderr}`);
  if (label === null || !LOCAL_DEPLOYMENT_TYPES.has(label.type)) {
    throw new LocalGuardError(
      "the Convex CLI does not target a local deployment. These scripts only change your local " +
        "development deployment (see docs/setup.md).",
    );
  }
  return label.name;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Throws unless `url` is a loopback http(s) URL (the local backend). */
export function assertLoopbackUrl(url, what = "The Convex URL") {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    host = undefined;
  }
  if (host === undefined || !LOOPBACK_HOSTS.has(host)) {
    throw new LocalGuardError(`${what} is not the local backend (loopback).`);
  }
}
