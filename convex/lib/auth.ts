import type { Auth, UserIdentity } from "convex/server";
import { apiError } from "./errors";
import { isRole, isValidExternalOrgId, type Role } from "./validation";

/**
 * JWT claim contract for parent applications (see docs/api/auth.md).
 * `iss`, `aud`, `exp` and the signature are verified by Convex against
 * `auth.config.ts` before any of our code runs; this module validates the
 * custom tenant claims on top of that verified identity.
 */
export const CLAIMS = {
  orgId: "org_id",
  role: "org_role",
  orgName: "org_name",
} as const;

export type VerifiedClaims = {
  issuer: string;
  subject: string;
  tokenIdentifier: string;
  externalOrgId: string;
  role: Role;
  orgName?: string;
};

/** Pure: validates tenant claims on an identity Convex has already verified. */
export function parseClaims(identity: UserIdentity): VerifiedClaims {
  const externalOrgId = identity[CLAIMS.orgId];
  if (!isValidExternalOrgId(externalOrgId)) {
    throw apiError(
      "INVALID_TOKEN_CLAIMS",
      `Token claim "${CLAIMS.orgId}" is missing or invalid (expected 1-128 chars of [A-Za-z0-9._:-]).`,
      { claim: CLAIMS.orgId },
    );
  }

  const role = identity[CLAIMS.role];
  if (!isRole(role)) {
    throw apiError(
      "INVALID_TOKEN_CLAIMS",
      `Token claim "${CLAIMS.role}" is missing or invalid (expected viewer, editor or admin).`,
      { claim: CLAIMS.role },
    );
  }

  if (!identity.subject) {
    throw apiError("INVALID_TOKEN_CLAIMS", 'Token claim "sub" is missing.', { claim: "sub" });
  }

  const rawName = identity[CLAIMS.orgName];
  const orgName = typeof rawName === "string" && rawName.trim() ? rawName.trim() : undefined;

  return {
    issuer: identity.issuer,
    subject: identity.subject,
    tokenIdentifier: identity.tokenIdentifier,
    externalOrgId,
    role,
    ...(orgName ? { orgName } : {}),
  };
}

export async function requireClaims(ctx: { auth: Auth }): Promise<VerifiedClaims> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    throw apiError("UNAUTHENTICATED", "A valid bearer token from a registered issuer is required.");
  }
  return parseClaims(identity);
}
