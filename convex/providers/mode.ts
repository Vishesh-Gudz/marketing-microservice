/**
 * PROVIDER_MODE resolution (Phase 8, D8). FAILS CLOSED:
 *
 *   PROVIDER_MODE  deployment        result
 *   unset          local backend     mock   (CONVEX_CLOUD_URL absent, as in convex-test, or loopback)
 *   unset          cloud (dev/prod)  config error "provider_mode_missing"
 *   "mock"         any               mock
 *   "live"         any               live
 *   anything else  any               config error "provider_mode_invalid" (case-sensitive, "" included)
 *
 * Convex exposes no dev/prod flag to functions; a loopback CONVEX_CLOUD_URL is the only
 * reliable "local" signal, so every cloud deployment must set PROVIDER_MODE explicitly.
 * A configuration error never falls back to mock or live (see createDefaultRegistry).
 */

export const PROVIDER_MODE_CODES = ["provider_mode_missing", "provider_mode_invalid"] as const;
export type ProviderModeCode = (typeof PROVIDER_MODE_CODES)[number];

export type ProviderModeResolution =
  { mode: "mock" } | { mode: "live" } | { mode: "misconfigured"; code: ProviderModeCode };

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** True for the local Convex backend (loopback URL) and for in-process tests (no URL). */
export function isLocalDeployment(cloudUrl: string | undefined): boolean {
  if (cloudUrl === undefined) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(cloudUrl).hostname);
  } catch {
    return false;
  }
}

export function resolveProviderMode(env: {
  PROVIDER_MODE?: string | undefined;
  CONVEX_CLOUD_URL?: string | undefined;
}): ProviderModeResolution {
  const value = env.PROVIDER_MODE;
  if (value === undefined) {
    return isLocalDeployment(env.CONVEX_CLOUD_URL)
      ? { mode: "mock" }
      : { mode: "misconfigured", code: "provider_mode_missing" };
  }
  if (value === "mock") return { mode: "mock" };
  if (value === "live") return { mode: "live" };
  return { mode: "misconfigured", code: "provider_mode_invalid" };
}
