import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TOKENS_PATH } from "./support";

// Checks the local prerequisites and mints the role tokens the role journeys use. The tokens
// are signed by the local dev issuer (scripts/dev-auth.mjs, keys in .dev-keys/), live for two
// hours and are written under test-results/ (git-ignored). The admin journey uses the
// dashboard's own dev token from .env.local.

function envLocal(name: string): string | undefined {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim() || undefined;
}

export default async function globalSetup() {
  if (process.env.CI)
    throw new Error("The revamp suite is local-only (it needs a seeded local backend).");
  if (!envLocal("NEXT_PUBLIC_DEV_AUTH_TOKEN")) {
    throw new Error("No dashboard dev token: run `npm run dev:auth setup` first.");
  }
  if (!envLocal("CONVEX_DEPLOYMENT")?.startsWith("local")) {
    throw new Error(
      "CONVEX_DEPLOYMENT is not a local deployment; the revamp suite never runs against a cloud one.",
    );
  }
  const convexUrl = envLocal("NEXT_PUBLIC_CONVEX_URL");
  const ready = await fetch(`${convexUrl}/version`).then(
    (r) => r.ok,
    () => false,
  );
  if (!ready)
    throw new Error(
      `The local Convex backend at ${convexUrl} is not running: start \`npm run dev:backend\`.`,
    );

  const tokens: Record<string, string> = {};
  for (const role of ["viewer", "editor"]) {
    const out = execFileSync(
      process.execPath,
      [
        "scripts/dev-auth.mjs",
        "token",
        "--org",
        "dev-org",
        "--role",
        role,
        "--sub",
        `e2e-${role}`,
        "--name",
        "Dev Organization",
        "--ttl",
        "2h",
      ],
      { encoding: "utf8" },
    );
    tokens[role] = out.trim().split(/\r?\n/).pop() ?? "";
  }
  mkdirSync(dirname(TOKENS_PATH), { recursive: true });
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens));
}
