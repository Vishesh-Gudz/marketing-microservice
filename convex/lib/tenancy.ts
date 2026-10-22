import {
  customAction,
  customCtx,
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
import { makeFunctionReference } from "convex/server";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import {
  action,
  mutation,
  query,
  type ActionCtx,
  type DatabaseReader,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { AUDIT_ACTIONS, writeAudit } from "./audit";
import { requireClaims, type VerifiedClaims } from "./auth";
import { apiError } from "./errors";
import { hasRole, normalizeDisplayName, type Role } from "./validation";

/**
 * Tenant context injected into every `v1` function by the wrappers below.
 * It is derived exclusively from the verified JWT (issuer + org_id) and is the
 * ONLY source of tenant identity. Public functions never accept an org id.
 */
export type Tenant = {
  orgId: Id<"organizations">;
  appId: Id<"integrationApps">;
  issuer: string;
  externalOrgId: string;
  subject: string;
  role: Role;
};

/** Per-function options passed alongside args/returns/handler. */
export type TenantOptions = {
  /** Minimum role required. Defaults: orgQuery "viewer", orgMutation "editor". */
  minRole?: Role;
};

export const ORG_DEFAULTS = { reportingCurrency: "USD", timezone: "UTC" } as const;

// ---------------------------------------------------------------------------
// Resolution steps
// ---------------------------------------------------------------------------

async function requireActiveApp(
  db: DatabaseReader,
  issuer: string,
): Promise<Doc<"integrationApps">> {
  const app = await db
    .query("integrationApps")
    .withIndex("by_issuer", (q) => q.eq("issuer", issuer))
    .unique();
  if (app === null) {
    throw apiError("APP_NOT_REGISTERED", "The token issuer is not a registered integration app.", {
      issuer,
    });
  }
  if (app.status !== "active") {
    throw apiError("APP_DISABLED", "The integration app for this token issuer is disabled.", {
      issuer,
    });
  }
  return app;
}

function requireRole(claims: VerifiedClaims, minRole: Role): void {
  if (!hasRole(claims.role, minRole)) {
    throw apiError("FORBIDDEN", `This operation requires the "${minRole}" role.`, {
      requiredRole: minRole,
      role: claims.role,
    });
  }
}

async function findOrg(
  db: DatabaseReader,
  claims: VerifiedClaims,
): Promise<Doc<"organizations"> | null> {
  return await db
    .query("organizations")
    .withIndex("by_issuer_external", (q) =>
      q.eq("issuer", claims.issuer).eq("externalOrgId", claims.externalOrgId),
    )
    .unique();
}

/**
 * D6: the identity provider (Clerk) owns the organization's name. When the verified token
 * carries a valid `org_name` that differs from the stored one, the stored name follows it
 * (audited). Without the claim, or with an invalid one, nothing changes.
 */
async function syncDisplayName(
  ctx: MutationCtx,
  org: Doc<"organizations">,
  claims: VerifiedClaims,
): Promise<Doc<"organizations">> {
  const name = claims.orgName === undefined ? null : normalizeDisplayName(claims.orgName);
  if (name === null || name === org.displayName) return org;
  const now = Date.now();
  await ctx.db.patch(org._id, { displayName: name, updatedAt: now });
  await writeAudit(
    ctx.db,
    { orgId: org._id, issuer: claims.issuer, subject: claims.subject },
    {
      action: AUDIT_ACTIONS.orgRenamed,
      targetType: "organization",
      targetId: org._id,
      changes: { displayName: { from: org.displayName, to: name } },
    },
  );
  return { ...org, displayName: name, updatedAt: now };
}

/**
 * Idempotent provisioning. Convex mutations are serializable transactions, so
 * two concurrent first calls conflict on the index read and one retries; only
 * one organization row is ever created per (issuer, org_id).
 */
async function ensureOrg(
  ctx: MutationCtx,
  claims: VerifiedClaims,
  app: Doc<"integrationApps">,
): Promise<Doc<"organizations">> {
  const existing = await findOrg(ctx.db, claims);
  if (existing !== null) return await syncDisplayName(ctx, existing, claims);

  const now = Date.now();
  const orgId = await ctx.db.insert("organizations", {
    issuer: claims.issuer,
    externalOrgId: claims.externalOrgId,
    appId: app._id,
    displayName:
      (claims.orgName === undefined ? null : normalizeDisplayName(claims.orgName)) ??
      claims.externalOrgId,
    reportingCurrency: ORG_DEFAULTS.reportingCurrency,
    timezone: ORG_DEFAULTS.timezone,
    createdAt: now,
    updatedAt: now,
  });
  await writeAudit(
    ctx.db,
    { orgId, issuer: claims.issuer, subject: claims.subject },
    { action: AUDIT_ACTIONS.orgProvisioned, targetType: "organization", targetId: orgId },
  );
  const created = await ctx.db.get(orgId);
  if (created === null) throw apiError("INTERNAL", "Organization provisioning failed.");
  return created;
}

function toTenant(org: Doc<"organizations">, claims: VerifiedClaims): Tenant {
  return {
    orgId: org._id,
    appId: org.appId,
    issuer: claims.issuer,
    externalOrgId: claims.externalOrgId,
    subject: claims.subject,
    role: claims.role,
  };
}

/** Resolves the caller's tenant for read-only contexts (queries, and actions via tenancy:resolve). */
export async function resolveForQuery(ctx: QueryCtx, minRole: Role): Promise<Tenant> {
  const claims = await requireClaims(ctx);
  await requireActiveApp(ctx.db, claims.issuer);
  requireRole(claims, minRole);
  const org = await findOrg(ctx.db, claims);
  if (org === null) {
    throw apiError(
      "ORG_NOT_PROVISIONED",
      "This organization has not been provisioned yet. Call v1/orgs:ensure first.",
    );
  }
  return toTenant(org, claims);
}

async function resolveForMutation(ctx: MutationCtx, minRole: Role): Promise<Tenant> {
  const claims = await requireClaims(ctx);
  const app = await requireActiveApp(ctx.db, claims.issuer);
  requireRole(claims, minRole);
  const org = await ensureOrg(ctx, claims, app);
  return toTenant(org, claims);
}

// ---------------------------------------------------------------------------
// Public builders. Only these may be used in convex/v1 (enforced by ESLint).
// ---------------------------------------------------------------------------

/** Read-only tenant function. Default minimum role: viewer. */
export const orgQuery = customQuery(
  query,
  customCtx(async (ctx: QueryCtx, extra: TenantOptions) => ({
    tenant: await resolveForQuery(ctx, extra.minRole ?? "viewer"),
  })),
);

/** Tenant write. Default minimum role: editor. Provisions the org on first use. */
export const orgMutation = customMutation(
  mutation,
  customCtx(async (ctx: MutationCtx, extra: TenantOptions) => ({
    tenant: await resolveForMutation(ctx, extra.minRole ?? "editor"),
  })),
);

/** Tenant write restricted to admins (settings, and later connections/alert rules). */
export const orgAdminMutation = customMutation(
  mutation,
  customCtx(async (ctx: MutationCtx) => ({
    tenant: await resolveForMutation(ctx, "admin"),
  })),
);

/**
 * Any valid token from an active app, any role. Used only for idempotent
 * provisioning (`v1/orgs:ensure`), which is not a privileged change.
 */
export const authedMutation = customMutation(
  mutation,
  customCtx(async (ctx: MutationCtx) => ({
    tenant: await resolveForMutation(ctx, "viewer"),
  })),
);

/**
 * Actions cannot touch the database, so they resolve the tenant through the
 * internal query `tenancy:resolve`, which sees the same verified identity
 * (Convex propagates auth to ctx.runQuery). Actions never provision orgs:
 * an unprovisioned org gets ORG_NOT_PROVISIONED, like queries.
 */
const resolveTenantRef = makeFunctionReference<"query", { minRole: Role }, Tenant>(
  "tenancy:resolve",
);

async function resolveForAction(ctx: ActionCtx, minRole: Role): Promise<Tenant> {
  return await ctx.runQuery(resolveTenantRef, { minRole });
}

/** Tenant action (external I/O, secure randomness). Default minimum role: viewer. */
export const orgAction = customAction(
  action,
  customCtx(async (ctx: ActionCtx, extra: TenantOptions) => ({
    tenant: await resolveForAction(ctx, extra.minRole ?? "viewer"),
  })),
);

/** Tenant action restricted to admins (e.g. starting a platform connection). */
export const orgAdminAction = customAction(
  action,
  customCtx(async (ctx: ActionCtx) => ({
    tenant: await resolveForAction(ctx, "admin"),
  })),
);

// ---------------------------------------------------------------------------
// Row ownership
// ---------------------------------------------------------------------------

/** Tables whose documents carry an `orgId` owner field. */
export type TenantTable = {
  [T in TableNames]: Doc<T> extends { orgId: Id<"organizations"> } ? T : never;
}[TableNames];

/**
 * Loads a tenant-owned document by an untrusted id. Returns NOT_FOUND (never
 * FORBIDDEN) for other tenants' rows so existence is not leaked. All future
 * by-id lookups in `v1` must go through this helper.
 */
export async function getOwned<T extends TenantTable>(
  ctx: { db: DatabaseReader; tenant: Tenant },
  table: T,
  id: string,
): Promise<Doc<T>> {
  const normalized = ctx.db.normalizeId(table, id);
  const doc = normalized === null ? null : await ctx.db.get(normalized);
  const owner = doc === null ? null : (doc as unknown as { orgId: Id<"organizations"> }).orgId;
  if (doc === null || owner !== ctx.tenant.orgId) {
    throw apiError("NOT_FOUND", `No ${table} record with this id.`, { table });
  }
  return doc;
}
