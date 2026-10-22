import type { AuthConfig } from "convex/server";
import { assertDevIssuerAllowed, parseAuthIssuers } from "./lib/authIssuers";

// Trusted JWT issuers (Clerk, and the local dev issuer on local deployments only). Convex
// verifies signature (JWKS), `iss`, `aud` (applicationID) and `exp` before any function runs.
// Configure with: npx convex env set AUTH_ISSUERS '<json>'  (see docs/api/auth.md)
const providers = parseAuthIssuers(process.env.AUTH_ISSUERS);
// Best effort at deploy time; requireClaims refuses dev-issuer tokens on cloud at runtime too.
assertDevIssuerAllowed(providers, process.env.CONVEX_CLOUD_URL);

export default {
  providers,
} satisfies AuthConfig;
