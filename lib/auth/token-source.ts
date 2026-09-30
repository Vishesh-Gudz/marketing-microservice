/**
 * Where the dashboard gets the parent application's signed JWT from.
 * The service has no login of its own; it only forwards a token it was given.
 *
 * - "dev":    a token minted by scripts/dev-auth.mjs (development only).
 * - "parent": (Phase 15) a token handed over by the embedding parent app.
 */
export type TokenSource = {
  readonly kind: "dev" | "parent";
  getToken(options: { forceRefreshToken: boolean }): Promise<string | null>;
};

/**
 * Dev token from NEXT_PUBLIC_DEV_AUTH_TOKEN. Returns null in production builds
 * so a dev token can never authenticate a deployed dashboard.
 */
export function createDevTokenSource(
  token: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): TokenSource | null {
  if (nodeEnv === "production" || !token) return null;
  return { kind: "dev", getToken: async () => token };
}
