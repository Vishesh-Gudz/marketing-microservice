#!/usr/bin/env node
// Local development stand-in for a JWT issuer (production signs in with Clerk).
// DEV ONLY: keys live in .dev-keys/ (git-ignored) and must never be used in production.
// Every command that writes to a Convex deployment refuses anything but a LOCAL deployment
// (scripts/local-convex-guard.mjs); AUTH_ISSUERS is merged, never replaced.
//
//   node scripts/dev-auth.mjs setup                 keys (if missing) + AUTH_ISSUERS + register app + dashboard token
//   node scripts/dev-auth.mjs keys [--force]        generate RSA key pair + JWKS
//   node scripts/dev-auth.mjs env                   print AUTH_ISSUERS JSON for the dev issuer
//   node scripts/dev-auth.mjs apply                 add/replace the dev issuer in AUTH_ISSUERS (keeps others)
//   node scripts/dev-auth.mjs seed                  register the dev issuer (+ localhost OAuth return URLs)
//   node scripts/dev-auth.mjs encryption-key [--force]  set TOKEN_ENCRYPTION_KEYS in the Convex env (never on disk)
//   node scripts/dev-auth.mjs token --org acme --role admin [--sub user_1] [--name "Acme"]
//                                   [--issuer <iss>] [--aud <aud>] [--ttl 15m|30d|3600]

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, exportPKCS8, generateKeyPair, importPKCS8, SignJWT } from "jose";
import { convexChildEnv } from "./google-ads-tester.mjs";
import { assertLocalConvexTarget, runLocalConvex } from "./local-convex-guard.mjs";

export const DEV_ISSUER = "https://dev-issuer.marketing.local";
export const DEV_AUDIENCE = "marketing-service";
export const DEV_KID = "dev-1";
export const DEV_APP_SLUG = "dev";
export const DEV_RETURN_URLS = ["http://localhost:3000/", "http://127.0.0.1:3000/"];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_DIR = join(ROOT, ".dev-keys");
const PRIVATE_KEY_PATH = join(KEY_DIR, "private.pem");
const JWKS_PATH = join(KEY_DIR, "jwks.json");
const ENV_LOCAL_PATH = join(ROOT, ".env.local");
const CONVEX_BIN = join(ROOT, "node_modules", "convex", "bin", "main.js");

export async function generateKeys({ force = false } = {}) {
  if (existsSync(PRIVATE_KEY_PATH) && !force) {
    console.log(`Keys already exist in ${KEY_DIR} (use --force to rotate).`);
    return;
  }
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: DEV_KID, alg: "RS256", use: "sig" };
  mkdirSync(KEY_DIR, { recursive: true });
  writeFileSync(PRIVATE_KEY_PATH, await exportPKCS8(privateKey));
  writeFileSync(JWKS_PATH, JSON.stringify({ keys: [jwk] }, null, 2));
  console.log(`Wrote dev key pair to ${KEY_DIR}`);
}

function requireKeys() {
  if (!existsSync(PRIVATE_KEY_PATH) || !existsSync(JWKS_PATH)) {
    throw new Error("Dev keys missing. Run: node scripts/dev-auth.mjs keys");
  }
}

/** The dev issuer's AUTH_ISSUERS entry; JWKS inlined as a data: URI (no HTTP fetch). */
export function devIssuerEntry() {
  requireKeys();
  const jwks = readFileSync(JWKS_PATH, "utf8");
  const dataUri = `data:text/plain;charset=utf-8;base64,${Buffer.from(jwks).toString("base64")}`;
  return { issuer: DEV_ISSUER, jwks: dataUri, applicationID: DEV_AUDIENCE, algorithm: "RS256" };
}

/** AUTH_ISSUERS value with only the dev issuer (printed by `env`). */
export function authIssuersJson() {
  return JSON.stringify([devIssuerEntry()]);
}

/**
 * The AUTH_ISSUERS value with the dev issuer's entry added or replaced and every other issuer
 * kept (e.g. the Clerk development instance). An unreadable current value is refused, never
 * overwritten.
 */
export function mergeDevIssuer(currentRaw, devEntry) {
  let current = [];
  if (currentRaw !== undefined && currentRaw.trim() !== "") {
    let parsed;
    try {
      parsed = JSON.parse(currentRaw);
    } catch {
      parsed = undefined;
    }
    if (!Array.isArray(parsed)) {
      throw new Error("AUTH_ISSUERS is not a JSON array; fix it first (it is never overwritten).");
    }
    current = parsed;
  }
  const others = current.filter(
    (entry) => !(entry && typeof entry === "object" && entry.issuer === devEntry.issuer),
  );
  return JSON.stringify([...others, devEntry]);
}

/** The current AUTH_ISSUERS of the local deployment (undefined when unset). Never printed. */
function readAuthIssuers() {
  const result = runLocalConvex(["env", "get", "AUTH_ISSUERS"]);
  if (result.status === 0) return result.stdout.replace(/\r?\n$/, "");
  if (/not found/i.test(`${result.stdout}\n${result.stderr}`)) return undefined;
  throw new Error("Could not read AUTH_ISSUERS from the local deployment.");
}

function convex(args) {
  // No shell: arguments (including JSON) are passed verbatim on every platform.
  const result = spawnSync(process.execPath, [CONVEX_BIN, ...args], {
    cwd: ROOT,
    stdio: "inherit",
    env: convexChildEnv(process.env),
  });
  if (result.status !== 0) throw new Error(`convex ${args[0]} ${args[1] ?? ""} failed`);
}

export function applyAuthIssuers() {
  convex(["env", "set", "AUTH_ISSUERS", mergeDevIssuer(readAuthIssuers(), devIssuerEntry())]);
}

export function seedDevApp() {
  convex([
    "run",
    "admin/integrationApps:register",
    JSON.stringify({ issuer: DEV_ISSUER, slug: DEV_APP_SLUG, name: "Local dev issuer" }),
  ]);
  convex([
    "run",
    "admin/integrationApps:setAllowedReturnUrls",
    JSON.stringify({ issuer: DEV_ISSUER, urls: DEV_RETURN_URLS }),
  ]);
}

/**
 * Credential encryption key for the DEV deployment. Generated here and written
 * straight into the Convex env (never to disk, never printed). Existing keys
 * are kept unless --force (rotating would make stored dev credentials unreadable).
 */
export function ensureEncryptionKey({ force = false } = {}) {
  const current = spawnSync(process.execPath, [CONVEX_BIN, "env", "get", "TOKEN_ENCRYPTION_KEYS"], {
    cwd: ROOT,
    encoding: "utf8",
    env: convexChildEnv(process.env),
  });
  if (!force && current.status === 0 && current.stdout.trim() !== "") {
    console.log("TOKEN_ENCRYPTION_KEYS already set (use --force to replace).");
    return;
  }
  const value = JSON.stringify({ 1: randomBytes(32).toString("base64") });
  const result = spawnSync(
    process.execPath,
    [CONVEX_BIN, "env", "set", "TOKEN_ENCRYPTION_KEYS", value],
    {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "inherit"],
      env: convexChildEnv(process.env),
    },
  );
  if (result.status !== 0) throw new Error("convex env set TOKEN_ENCRYPTION_KEYS failed");
  console.log("TOKEN_ENCRYPTION_KEYS set in the Convex deployment env.");
}

function parseTtl(value) {
  const match = /^(\d+)([smhd]?)$/.exec(value);
  if (!match) throw new Error(`Invalid --ttl "${value}" (e.g. 900, 15m, 12h, 30d)`);
  const unit = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
  return Number(match[1]) * unit;
}

/**
 * Mints a dev JWT. Overrides exist so tests can produce deliberately invalid
 * tokens (wrong audience, expired, foreign issuer).
 *
 * @param {{
 *   org?: string, role: string, sub?: string, name?: string, issuer?: string,
 *   audience?: string, ttlSeconds?: number, issuedAt?: number, privateKeyPem?: string
 * }} options
 * @returns {Promise<string>}
 */
export async function mintToken({
  org,
  role,
  sub = "dev-user",
  name,
  issuer = DEV_ISSUER,
  audience = DEV_AUDIENCE,
  ttlSeconds = 15 * 60,
  issuedAt,
  privateKeyPem,
}) {
  const pem = privateKeyPem ?? (requireKeys(), readFileSync(PRIVATE_KEY_PATH, "utf8"));
  const key = await importPKCS8(pem, "RS256");
  const iat = issuedAt ?? Math.floor(Date.now() / 1000);
  const claims = { org_role: role };
  if (org !== undefined) claims.org_id = org;
  if (name) claims.org_name = name;
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: DEV_KID, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSeconds)
    .sign(key);
}

function upsertEnvLocal(key, value) {
  const lines = existsSync(ENV_LOCAL_PATH)
    ? readFileSync(ENV_LOCAL_PATH, "utf8").split(/\r?\n/)
    : [];
  const entry = `${key}=${value}`;
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index >= 0) lines[index] = entry;
  else
    lines.push(
      "",
      "# Dev-only dashboard token (scripts/dev-auth.mjs). Never set in production.",
      entry,
    );
  writeFileSync(ENV_LOCAL_PATH, lines.join("\n").replace(/\n{3,}/g, "\n\n"));
}

/** Commands that write to a Convex deployment: local deployments only. */
export const DEPLOYMENT_COMMANDS = new Set(["apply", "seed", "encryption-key", "setup"]);

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else flags[key] = argv[++i];
  }
  return flags;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (DEPLOYMENT_COMMANDS.has(command)) assertLocalConvexTarget();

  switch (command) {
    case "keys":
      await generateKeys({ force: flags.force === true });
      break;
    case "env":
      console.log(authIssuersJson());
      break;
    case "apply":
      applyAuthIssuers();
      break;
    case "seed":
      seedDevApp();
      break;
    case "encryption-key":
      ensureEncryptionKey({ force: flags.force === true });
      break;
    case "token": {
      if (!flags.org || !flags.role) throw new Error("token requires --org and --role");
      console.log(
        await mintToken({
          org: String(flags.org),
          role: String(flags.role),
          sub: flags.sub ? String(flags.sub) : undefined,
          name: flags.name ? String(flags.name) : undefined,
          issuer: flags.issuer ? String(flags.issuer) : undefined,
          audience: flags.aud ? String(flags.aud) : undefined,
          ttlSeconds: flags.ttl ? parseTtl(String(flags.ttl)) : undefined,
        }),
      );
      break;
    }
    case "setup": {
      await generateKeys();
      applyAuthIssuers();
      ensureEncryptionKey();
      seedDevApp();
      const org = flags.org ? String(flags.org) : "dev-org";
      const token = await mintToken({
        org,
        role: flags.role ? String(flags.role) : "admin",
        sub: "dev-user",
        name: flags.name ? String(flags.name) : "Dev Organization",
        ttlSeconds: parseTtl("30d"),
      });
      upsertEnvLocal("NEXT_PUBLIC_DEV_AUTH_TOKEN", token);
      console.log(
        `\nDev auth ready. Dashboard token for org "${org}" written to .env.local (30 days).`,
      );
      console.log("Restart `npm run dev:frontend` to pick it up.");
      break;
    }
    default:
      console.log(
        readFileSync(fileURLToPath(import.meta.url), "utf8")
          .split("\n")
          .slice(1, 12)
          .join("\n"),
      );
      process.exitCode = command ? 1 : 0;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
