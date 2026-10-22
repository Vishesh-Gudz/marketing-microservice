import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertLoopbackUrl } from "../../scripts/local-convex-guard.mjs";

/**
 * The backend the opt-in live tests talk to: NEXT_PUBLIC_CONVEX_URL from the environment, else
 * from `.env.local`. It must be the LOCAL backend (loopback): the live tests create throwaway
 * organizations and must never reach a cloud or production deployment, even if `.env.local`
 * points the dashboard there.
 */
export function liveConvexUrl(): string {
  const envPath = join(process.cwd(), ".env.local");
  const fromFile = existsSync(envPath)
    ? /^NEXT_PUBLIC_CONVEX_URL=(.+)$/m.exec(readFileSync(envPath, "utf8"))?.[1]?.trim()
    : undefined;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL ?? fromFile;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL not found. Run `npm run dev:backend` first.");
  assertLoopbackUrl(url, "NEXT_PUBLIC_CONVEX_URL (live tests)");
  return url;
}
