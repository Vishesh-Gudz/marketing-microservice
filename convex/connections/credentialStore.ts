import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type ActionCtx,
  type DatabaseReader,
  type DatabaseWriter,
} from "../_generated/server";
import type { ConnectionProvider, StoredConnectionProvider } from "../domain/types";
import { literalUnion } from "../domain/validators";
import { stopMessagingWithoutPermission } from "../instagram/messaging/accounts";
import { AUDIT_ACTIONS, AUDIT_CODE_PATTERN, SYSTEM_SWEEP_SUBJECT, writeAudit } from "../lib/audit";
import {
  CREDENTIAL_ALGORITHM,
  credentialAad,
  decryptJson,
  encryptJson,
  loadKeyRing,
  type EncryptedPayload,
} from "../lib/crypto";
import type { AuditChanges } from "../lib/validation";
import { PROVIDER_ERROR_KINDS } from "../providers/errors";
import { OAUTH_GRANT_TTL_MS } from "./config";

/**
 * THE credential store. The only module that reads or writes the `credentials`
 * and `oauthGrants` tables and the only place that decrypts (all ESLint enforced).
 *
 * - Ciphertext only in the database, mutations and queries. Plaintext exists
 *   only inside actions, via `encryptCredential` / `withConnectionCredential`.
 * - AAD = orgId|provider|externalUserId|v1: a ciphertext moved to another
 *   connection or org fails authentication.
 * - Nothing here is public; no function returns plaintext.
 * - S2: the OAuth callback never creates a connection. It stores a pending grant
 *   (storeGrant); only the initiating user, in the initiating org, can turn it into a
 *   connection (claimGrant), once, before it expires.
 */

/** Ciphertext bundle from `encryptCredential` (validator for internal mutation arguments). */
export const encryptedValidator = v.object({
  ciphertext: v.bytes(),
  iv: v.bytes(),
  keyVersion: v.number(),
});

export type CredentialBinding = {
  orgId: string;
  provider: StoredConnectionProvider;
  externalUserId: string;
};

export class CredentialUnavailableError extends Error {
  constructor(readonly reason: "not_found" | "inactive" | "missing") {
    super(`Credential unavailable: ${reason}`);
    this.name = "CredentialUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Action-side helpers (plaintext stays in action memory)
// ---------------------------------------------------------------------------

/** Encrypts a freshly granted credential for storage. Fails closed if keys are not configured. */
export async function encryptCredential(
  binding: CredentialBinding,
  credential: unknown,
): Promise<EncryptedPayload> {
  const ring = await loadKeyRing();
  return await encryptJson(
    ring,
    credential,
    credentialAad(binding.orgId, binding.provider, binding.externalUserId),
  );
}

export type ConnectionBinding = CredentialBinding & {
  connectionId: Id<"connections">;
  /** The credential generation this plaintext belongs to (Phase 10 token refresh). */
  credentialVersion: number;
  /** The connection's status when the credential was loaded. */
  status: Doc<"connections">["status"];
};

/**
 * The ONLY way to use a stored credential: decrypts it, hands it to `handle`,
 * and never returns it. Refuses non-active connections unless `allowRevoked`
 * (used solely to revoke at the platform on disconnect) or `allowNeedsReauth` (used solely by
 * the WhatsApp signup to keep a number's registration PIN across a reconnect, ADR 0014, and by
 * the YouTube authorization check, which must tell a revoked grant from a temporary failure
 * before any purge, ADR 0016).
 */
export async function withConnectionCredential<T>(
  ctx: ActionCtx,
  connectionId: Id<"connections">,
  handle: (credential: unknown, connection: ConnectionBinding) => Promise<T>,
  options: { allowRevoked?: boolean; allowNeedsReauth?: boolean } = {},
): Promise<T> {
  const row = await ctx.runQuery(internal.connections.credentialStore.loadForUse, { connectionId });
  if (row === null) throw new CredentialUnavailableError("not_found");
  const allowed =
    row.status === "active" ||
    (options.allowRevoked === true && row.status === "revoked") ||
    (options.allowNeedsReauth === true && row.status === "needs_reauth");
  if (!allowed) throw new CredentialUnavailableError("inactive");
  if (row.encrypted === null) throw new CredentialUnavailableError("missing");

  const binding: ConnectionBinding = {
    orgId: row.orgId,
    provider: row.provider,
    externalUserId: row.externalUserId,
    connectionId,
    credentialVersion: row.credentialVersion,
    status: row.status,
  };
  const ring = await loadKeyRing();
  const credential = await decryptJson(
    ring,
    row.encrypted,
    credentialAad(binding.orgId, binding.provider, binding.externalUserId),
  );
  return await handle(credential, binding);
}

// ---------------------------------------------------------------------------
// Database helpers (ciphertext only)
// ---------------------------------------------------------------------------

async function findCredential(
  db: DatabaseReader,
  orgId: Id<"organizations">,
  connectionId: Id<"connections">,
) {
  return await db
    .query("credentials")
    .withIndex("by_org_connection", (q) => q.eq("orgId", orgId).eq("connectionId", connectionId))
    .unique();
}

export async function hasCredential(
  db: DatabaseReader,
  orgId: Id<"organizations">,
  connectionId: Id<"connections">,
): Promise<boolean> {
  return (await findCredential(db, orgId, connectionId)) !== null;
}

/** Deletes the stored credential of a connection. Returns true if one existed. */
export async function deleteCredential(
  db: DatabaseWriter,
  orgId: Id<"organizations">,
  connectionId: Id<"connections">,
): Promise<boolean> {
  const existing = await findCredential(db, orgId, connectionId);
  if (existing === null) return false;
  await db.delete(existing._id);
  return true;
}

async function writeCredential(
  db: DatabaseWriter,
  orgId: Id<"organizations">,
  connectionId: Id<"connections">,
  encrypted: EncryptedPayload,
  now: number,
) {
  const existing = await findCredential(db, orgId, connectionId);
  const fields = {
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    keyVersion: encrypted.keyVersion,
    algorithm: CREDENTIAL_ALGORITHM,
    updatedAt: now,
  };
  if (existing) await db.patch(existing._id, fields);
  else await db.insert("credentials", { orgId, connectionId, ...fields, createdAt: now });
}

// ---------------------------------------------------------------------------
// Internal functions
// ---------------------------------------------------------------------------

/** Ciphertext + binding for `withConnectionCredential`. Internal only. */
export const loadForUse = internalQuery({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await ctx.db.get(connectionId);
    if (connection === null) return null;
    const credential = await findCredential(ctx.db, connection.orgId, connection._id);
    return {
      orgId: connection.orgId as string,
      provider: connection.provider,
      externalUserId: connection.externalUserId,
      status: connection.status,
      credentialVersion: connection.credentialVersion,
      encrypted: credential
        ? {
            ciphertext: credential.ciphertext,
            iv: credential.iv,
            keyVersion: credential.keyVersion,
          }
        : null,
    };
  },
});

const identityValidator = v.object({
  externalUserId: v.string(),
  displayName: v.optional(v.string()),
  /** Instagram only (ADR 0017, IM6): kept for the deauthorize / data-deletion callbacks. */
  scopedUserId: v.optional(v.string()),
});

/** The tenant presenting a claim (from the verified JWT, never from arguments). */
const claimantValidator = v.object({
  orgId: v.id("organizations"),
  issuer: v.string(),
  subject: v.string(),
});

/** The reconnect target must be the same platform identity in the same org. */
async function reconnectIdentityMatches(
  db: DatabaseReader,
  target: Id<"connections"> | undefined,
  expected: { orgId: Id<"organizations">; provider: ConnectionProvider; externalUserId: string },
): Promise<boolean> {
  if (target === undefined) return true;
  const connection = await db.get(target);
  return (
    connection !== null &&
    connection.orgId === expected.orgId &&
    connection.provider === expected.provider &&
    connection.externalUserId === expected.externalUserId
  );
}

/**
 * Stores the encrypted credential of a CONSUMED OAuth state as a pending grant (S2). The org,
 * provider, issuer and initiator all come from the stored state, never from the caller. No
 * connection or credential exists until the initiator claims it. A reconnect whose platform
 * identity differs is refused here already (and checked again on claim).
 */
export const storeGrant = internalMutation({
  args: {
    stateId: v.id("oauthStates"),
    identity: identityValidator,
    grantedScopes: v.array(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    encrypted: encryptedValidator,
    claimHash: v.string(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({
      ok: v.literal(false),
      reason: v.union(v.literal("identity_mismatch"), v.literal("invalid_state")),
    }),
  ),
  handler: async (ctx, args) => {
    const state = await ctx.db.get(args.stateId);
    // A grant can only be claimed from the return URL: never store one without it.
    if (state === null || state.status !== "consumed" || state.returnUrl === undefined)
      return { ok: false as const, reason: "invalid_state" as const };
    if ((await ctx.db.get(state.orgId)) === null)
      return { ok: false as const, reason: "invalid_state" as const };
    const binding = {
      orgId: state.orgId,
      provider: state.provider,
      externalUserId: args.identity.externalUserId,
    };
    if (!(await reconnectIdentityMatches(ctx.db, state.reconnectConnectionId, binding)))
      return { ok: false as const, reason: "identity_mismatch" as const };

    const now = Date.now();
    await ctx.db.insert("oauthGrants", {
      orgId: state.orgId,
      stateId: state._id,
      provider: state.provider,
      issuer: state.issuer,
      initiatedBySubject: state.initiatedBySubject,
      ...(state.reconnectConnectionId !== undefined
        ? { reconnectConnectionId: state.reconnectConnectionId }
        : {}),
      externalUserId: args.identity.externalUserId,
      ...(args.identity.displayName !== undefined
        ? { displayName: args.identity.displayName }
        : {}),
      ...(args.identity.scopedUserId !== undefined
        ? { scopedUserId: args.identity.scopedUserId }
        : {}),
      grantedScopes: args.grantedScopes,
      ...(args.tokenExpiresAt !== undefined ? { tokenExpiresAt: args.tokenExpiresAt } : {}),
      ciphertext: args.encrypted.ciphertext,
      iv: args.encrypted.iv,
      keyVersion: args.encrypted.keyVersion,
      algorithm: CREDENTIAL_ALGORITHM,
      claimHash: args.claimHash,
      expiresAt: now + OAUTH_GRANT_TTL_MS,
      createdAt: now,
    });
    await writeAudit(
      ctx.db,
      { orgId: state.orgId, issuer: state.issuer, subject: state.initiatedBySubject },
      {
        action: AUDIT_ACTIONS.connectionOAuthGranted,
        targetType: "oauthState",
        targetId: state._id,
        changes: { provider: { from: null, to: state.provider } },
      },
    );
    return { ok: true as const };
  },
});

type ClaimFailure = "invalid_claim" | "expired_claim" | "identity_mismatch";

/** Deletes a grant that can never be claimed, with an audit entry in the grant's org. */
async function invalidateGrant(
  db: DatabaseWriter,
  grant: Doc<"oauthGrants">,
  reason: "owner_mismatch" | "expired" | "identity_mismatch" | "data_deletion",
  subject: string,
) {
  await db.delete(grant._id);
  await writeAudit(
    db,
    { orgId: grant.orgId, issuer: grant.issuer, subject },
    {
      action:
        reason === "expired"
          ? AUDIT_ACTIONS.connectionGrantExpired
          : AUDIT_ACTIONS.connectionClaimRejected,
      targetType: "oauthState",
      targetId: grant.stateId,
      changes: {
        provider: { from: null, to: grant.provider },
        reason: { from: null, to: reason },
      },
    },
  );
}

/**
 * S2: turns a pending grant into a connection + credential, atomically, for the user who
 * started the connection. The claimant comes from the verified JWT (v1/connections:
 * completeConnect). Any other issuer, user or org, a second use, or an expired grant is
 * refused; a grant presented by anyone else is deleted so it can never be claimed afterwards.
 * Failures are RETURNED (never thrown) so the deletion and its audit entry commit.
 */
export const claimGrant = internalMutation({
  args: { claimHash: v.string(), claimant: claimantValidator },
  returns: v.union(
    v.object({ ok: v.literal(true), connectionId: v.id("connections"), reconnected: v.boolean() }),
    v.object({
      ok: v.literal(false),
      reason: v.union(
        v.literal("invalid_claim"),
        v.literal("expired_claim"),
        v.literal("identity_mismatch"),
      ),
    }),
  ),
  handler: async (ctx, { claimHash, claimant }) => {
    const failure = (reason: ClaimFailure) => ({ ok: false as const, reason });
    const grant = await ctx.db
      .query("oauthGrants")
      .withIndex("by_claim_hash", (q) => q.eq("claimHash", claimHash))
      .unique();
    // Unknown, already claimed or already invalidated: indistinguishable.
    if (grant === null) return failure("invalid_claim");

    if (
      grant.orgId !== claimant.orgId ||
      grant.issuer !== claimant.issuer ||
      grant.initiatedBySubject !== claimant.subject
    ) {
      // Audited in the initiator's org only, as the initiator: the presenting party's
      // identity is never copied into this org's audit log.
      await invalidateGrant(ctx.db, grant, "owner_mismatch", grant.initiatedBySubject);
      return failure("invalid_claim");
    }

    const now = Date.now();
    if (grant.expiresAt <= now) {
      await invalidateGrant(ctx.db, grant, "expired", claimant.subject);
      return failure("expired_claim");
    }
    if ((await ctx.db.get(grant.orgId)) === null) {
      await ctx.db.delete(grant._id);
      return failure("invalid_claim");
    }
    if (
      !(await reconnectIdentityMatches(ctx.db, grant.reconnectConnectionId, {
        orgId: grant.orgId,
        provider: grant.provider,
        externalUserId: grant.externalUserId,
      }))
    ) {
      await invalidateGrant(ctx.db, grant, "identity_mismatch", claimant.subject);
      return failure("identity_mismatch");
    }

    const existing = await ctx.db
      .query("connections")
      .withIndex("by_org_provider_identity", (q) =>
        q
          .eq("orgId", grant.orgId)
          .eq("provider", grant.provider)
          .eq("externalUserId", grant.externalUserId),
      )
      .unique();

    const fields = {
      displayName: grant.displayName,
      ...(grant.scopedUserId !== undefined ? { scopedUserId: grant.scopedUserId } : {}),
      // IM7.0: when this authorization was given (a Meta callback issued before it is stale).
      authorizedAt: now,
      status: "active" as const,
      grantedScopes: grant.grantedScopes,
      tokenExpiresAt: grant.tokenExpiresAt,
      lastError: undefined,
      revokedAt: undefined,
      connectedBySubject: grant.initiatedBySubject,
      updatedAt: now,
    };

    let connectionId: Id<"connections">;
    if (existing) {
      connectionId = existing._id;
      await ctx.db.patch(existing._id, {
        ...fields,
        credentialVersion: existing.credentialVersion + 1,
      });
    } else {
      connectionId = await ctx.db.insert("connections", {
        orgId: grant.orgId,
        provider: grant.provider,
        externalUserId: grant.externalUserId,
        ...(grant.displayName !== undefined ? { displayName: grant.displayName } : {}),
        ...(grant.scopedUserId !== undefined ? { scopedUserId: grant.scopedUserId } : {}),
        authorizedAt: now,
        status: "active",
        grantedScopes: grant.grantedScopes,
        credentialVersion: 1,
        ...(grant.tokenExpiresAt !== undefined ? { tokenExpiresAt: grant.tokenExpiresAt } : {}),
        connectedBySubject: grant.initiatedBySubject,
        connectedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    // Same AAD (orgId|provider|externalUserId) as the grant: the ciphertext moves unchanged.
    await writeCredential(
      ctx.db,
      grant.orgId,
      connectionId,
      { ciphertext: grant.ciphertext, iv: grant.iv, keyVersion: grant.keyVersion },
      now,
    );
    await ctx.db.delete(grant._id);
    await writeAudit(ctx.db, claimant, {
      action: existing ? AUDIT_ACTIONS.connectionReconnected : AUDIT_ACTIONS.connectionConnected,
      targetType: "connection",
      targetId: connectionId,
      changes: { provider: { from: null, to: grant.provider } },
    });
    // ADR 0017: a reconnect without the messaging permission stops Instagram direct messages
    // on this connection in the same transaction (no stale hold).
    if (existing && grant.provider === "instagram") {
      await stopMessagingWithoutPermission(ctx.db, claimant, connectionId, grant.grantedScopes);
    }
    return { ok: true as const, connectionId, reconnected: existing !== null };
  },
});

/**
 * Creates or re-activates a connection and stores its credential, for providers that never use
 * OAuth grants (WhatsApp Embedded Signup, ADR 0014: its action exchanges the code and encrypts
 * the token itself). `encrypted` must be bound to exactly (orgId, provider, externalUserId); a
 * ciphertext bound to anything else fails to decrypt on use. A reconnect replaces the
 * credential and increments `credentialVersion`. The caller authorizes and audits.
 */
export async function upsertDirectConnection(
  db: DatabaseWriter,
  input: {
    orgId: Id<"organizations">;
    /** Never an OAuth provider: those connect only through grants (S2). */
    provider: Exclude<StoredConnectionProvider, ConnectionProvider>;
    externalUserId: string;
    displayName?: string;
    grantedScopes: string[];
    /** Absent = the token does not expire (the expiry sweep skips the connection). */
    tokenExpiresAt?: number;
    connectedBySubject: string;
    encrypted: EncryptedPayload;
    now: number;
  },
): Promise<{ connectionId: Id<"connections">; reconnected: boolean }> {
  const existing = await db
    .query("connections")
    .withIndex("by_org_provider_identity", (q) =>
      q
        .eq("orgId", input.orgId)
        .eq("provider", input.provider)
        .eq("externalUserId", input.externalUserId),
    )
    .unique();

  let connectionId: Id<"connections">;
  if (existing) {
    connectionId = existing._id;
    await db.patch(existing._id, {
      displayName: input.displayName,
      status: "active",
      grantedScopes: input.grantedScopes,
      credentialVersion: existing.credentialVersion + 1,
      tokenExpiresAt: input.tokenExpiresAt,
      lastError: undefined,
      revokedAt: undefined,
      connectedBySubject: input.connectedBySubject,
      updatedAt: input.now,
    });
  } else {
    connectionId = await db.insert("connections", {
      orgId: input.orgId,
      provider: input.provider,
      externalUserId: input.externalUserId,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      status: "active",
      grantedScopes: input.grantedScopes,
      credentialVersion: 1,
      ...(input.tokenExpiresAt !== undefined ? { tokenExpiresAt: input.tokenExpiresAt } : {}),
      connectedBySubject: input.connectedBySubject,
      connectedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
  await writeCredential(db, input.orgId, connectionId, input.encrypted, input.now);
  return { connectionId, reconnected: existing !== null };
}

/** Sweep step (connections/maintenance.ts): deletes unclaimed grants past their expiry. */
export async function deleteExpiredGrants(
  db: DatabaseWriter,
  now: number,
  limit: number,
): Promise<number> {
  const expired = await db
    .query("oauthGrants")
    .withIndex("by_expires", (q) => q.lt("expiresAt", now))
    .take(limit);
  for (const grant of expired) {
    await invalidateGrant(db, grant, "expired", SYSTEM_SWEEP_SUBJECT);
  }
  return expired.length;
}

/**
 * IM7.0 (Meta data-deletion request): deletes the org's unclaimed grants of one platform
 * identity, so an authorization consented before the request can no longer be claimed after
 * it. Grants are short-lived and few per org (at most one per pending OAuth state).
 */
export async function deletePendingGrantsForIdentity(
  db: DatabaseWriter,
  orgId: Id<"organizations">,
  provider: ConnectionProvider,
  externalUserId: string,
  subject: string,
): Promise<number> {
  const grants = await db
    .query("oauthGrants")
    .withIndex("by_org_created", (q) => q.eq("orgId", orgId))
    .take(100);
  let deleted = 0;
  for (const grant of grants) {
    if (grant.provider === provider && grant.externalUserId === externalUserId) {
      await invalidateGrant(db, grant, "data_deletion", subject);
      deleted++;
    }
  }
  return deleted;
}

/**
 * Phase 10 token refresh: replaces the credential of an ACTIVE connection with a freshly
 * refreshed one, atomically with the connection's expiry and credential generation. The
 * write is refused (false) unless the connection is still active AND still on the
 * generation the refresh started from, so a reconnect or disconnect that happened while
 * the refresh was in flight always wins. Ciphertext only; audited without secrets.
 * Granted scopes are left untouched (a refresh does not change them).
 */
export const replaceRefreshedCredential = internalMutation({
  args: {
    connectionId: v.id("connections"),
    expectedCredentialVersion: v.number(),
    tokenExpiresAt: v.optional(v.number()),
    encrypted: encryptedValidator,
    actorSubject: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (
      connection === null ||
      connection.status !== "active" ||
      connection.credentialVersion !== args.expectedCredentialVersion
    ) {
      return false;
    }
    const now = Date.now();
    await writeCredential(ctx.db, connection.orgId, connection._id, args.encrypted, now);
    await ctx.db.patch(connection._id, {
      credentialVersion: connection.credentialVersion + 1,
      tokenExpiresAt: args.tokenExpiresAt,
      lastError: undefined,
      updatedAt: now,
    });
    const org = await ctx.db.get(connection.orgId);
    await writeAudit(
      ctx.db,
      { orgId: connection.orgId, issuer: org?.issuer ?? "", subject: args.actorSubject },
      {
        action: AUDIT_ACTIONS.connectionTokenRefreshed,
        targetType: "connection",
        targetId: connection._id,
        changes: {
          credentialVersion: {
            from: connection.credentialVersion,
            to: connection.credentialVersion + 1,
          },
        },
      },
    );
    return true;
  },
});

/**
 * How the platform side of a disconnect ended (`revokeAtPlatform`):
 * - revoked: the platform accepted the revocation (or already considered the token revoked);
 * - failed: the revocation request failed (failureKind / failureCode say how);
 * - not_attempted: nothing was sent, because the credential or the provider's configuration
 *   could not be used (failureKind credential_unavailable or internal), the connection was
 *   connected again since the disconnect (superseded), or the job predates credential versions
 *   (legacy_job: it never revokes or deletes; the hourly sweep deletes what is left);
 * - not_supported: the provider has no platform revoke (Google Ads G-D6, Meta D7, Instagram).
 */
export const platformRevokeValidator = v.object({
  outcome: literalUnion(["revoked", "failed", "not_attempted", "not_supported"]),
  failureKind: v.optional(v.string()),
  failureCode: v.optional(v.string()),
});
export type PlatformRevoke = Infer<typeof platformRevokeValidator>;

const REVOKE_FAILURE_KINDS: ReadonlySet<string> = new Set([
  ...PROVIDER_ERROR_KINDS,
  "credential_unavailable",
  "internal",
  "superseded",
  "legacy_job",
]);

/** The audited form: allowlisted kind (else internal) and code (else dropped) only. */
function platformRevokeChanges(revoke: PlatformRevoke): AuditChanges {
  const outcome = { outcome: { from: null, to: revoke.outcome } };
  if (revoke.outcome !== "failed" && revoke.outcome !== "not_attempted") return outcome;
  const kind =
    revoke.failureKind !== undefined && REVOKE_FAILURE_KINDS.has(revoke.failureKind)
      ? revoke.failureKind
      : "internal";
  return {
    ...outcome,
    failureKind: { from: null, to: kind },
    ...(revoke.failureCode !== undefined && AUDIT_CODE_PATTERN.test(revoke.failureCode)
      ? { failureCode: { from: null, to: revoke.failureCode } }
      : {}),
  };
}

/**
 * Deletes a disconnected connection's credential (the end of `revokeAtPlatform`) and audits how
 * the platform revoke ended, in the same transaction (`connection.platform_revoke`).
 *
 * Deletes ONLY the credential of the disconnect that scheduled it: the connection must still be
 * `revoked` AND on `credentialVersion` (every credential write increments it, so a reconnect,
 * even one followed by another disconnect, never matches). Checked and deleted in one
 * transaction (Convex mutations are serializable). Without `credentialVersion` (a job scheduled
 * before versions existed) nothing is deleted; the hourly sweep deletes what is left.
 */
export const deleteForConnection = internalMutation({
  args: {
    connectionId: v.id("connections"),
    actorSubject: v.string(),
    platformRevoke: v.optional(platformRevokeValidator),
    credentialVersion: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, { connectionId, actorSubject, platformRevoke, credentialVersion }) => {
    const connection = await ctx.db.get(connectionId);
    if (connection === null) return false;
    const current =
      credentialVersion !== undefined &&
      connection.status === "revoked" &&
      connection.credentialVersion === credentialVersion;
    const deleted = current && (await deleteCredential(ctx.db, connection.orgId, connectionId));
    if (!deleted && platformRevoke === undefined) return false;
    const org = await ctx.db.get(connection.orgId);
    const actor = { orgId: connection.orgId, issuer: org?.issuer ?? "", subject: actorSubject };
    if (platformRevoke !== undefined) {
      await writeAudit(ctx.db, actor, {
        action: AUDIT_ACTIONS.connectionPlatformRevoke,
        targetType: "connection",
        targetId: connectionId,
        changes: platformRevokeChanges(platformRevoke),
      });
    }
    if (deleted) {
      await writeAudit(ctx.db, actor, {
        action: AUDIT_ACTIONS.credentialDeleted,
        targetType: "connection",
        targetId: connectionId,
      });
    }
    return deleted;
  },
});
