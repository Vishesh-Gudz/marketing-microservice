import type { AuthConfig } from "convex/server";
import { parseAuthIssuers } from "./lib/authIssuers";

// Trusted JWT issuers (parent applications). Convex verifies signature (JWKS),
// `iss`, `aud` (applicationID) and `exp` before any function runs.
// Configure with: npx convex env set AUTH_ISSUERS '<json>'  (see docs/api/auth.md)
export default {
  providers: parseAuthIssuers(process.env.AUTH_ISSUERS),
} satisfies AuthConfig;
