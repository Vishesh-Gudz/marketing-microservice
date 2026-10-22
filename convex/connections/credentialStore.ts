import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type ActionCtx,
  type DatabaseReader,
  type DatabaseWriter,
} from "../_generated/server";
import type { ConnectionProvider } from "../domain/types";
import { AUDIT_ACTIONS, SYSTEM_SWEEP_SUBJECT, writeAudit } from "../lib/audit";
import {
  CREDENTIAL_ALGORITHM,
  credentialAad,
  decryptJson,
  encryptJson,
  loadKeyRing,
  type EncryptedPayload,
} from "../lib/crypto";
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

const encryptedValidator = v.object({
  ciphertext: v.bytes(),
  iv: v.bytes(),
  keyVersion: v.number(),
});

export type CredentialBinding = {
  orgId: string;
  provider: ConnectionProvider;
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
};

/**
 * The ONLY way to use a stored credential: decrypts it, hands it to `handle`,
 * and never returns it. Refuses non-active connections unless `allowRevoked`
 * (used solely to revoke at the platform on disconnect).
 */
export async function withConnectionCredential<T>(
  ctx: ActionCtx,
  connectionId: Id<"connections">,
  handle: (credential: unknown, connection: ConnectionBinding) => Promise<T>,
  options: { allowRevoked?: boolean } = {},
): Promise<T> {
  const row = await ctx.runQuery(internal.connections.credentialStore.loadForUse, { connectionId });
  if (row === null) throw new CredentialUnavailableError("not_found");
  if (row.status !== "active" && !(options.allowRevoked && row.status === "revoked")) {
    throw new CredentialUnavailableError("inactive");
  }
  if (row.encrypted === null) throw new CredentialUnavailableError("missing");

  const binding: ConnectionBinding = {
    orgId: row.orgId,
    provider: row.provider,
    externalUserId: row.externalUserId,
    connectionId,
    credentialVersion: row.credentialVersion,
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
  reason: "owner_mismatch" | "expired" | "identity_mismatch",
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
    return { ok: true as const, connectionId, reconnected: existing !== null };
  },
});

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

/** Deletes a connection's credential (disconnect / sweep backstop). */
export const deleteForConnection = internalMutation({
  args: { connectionId: v.id("connections"), actorSubject: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { connectionId, actorSubject }) => {
    const connection = await ctx.db.get(connectionId);
    if (connection === null) return false;
    const deleted = await deleteCredential(ctx.db, connection.orgId, connectionId);
    if (deleted) {
      const org = await ctx.db.get(connection.orgId);
      await writeAudit(
        ctx.db,
        { orgId: connection.orgId, issuer: org?.issuer ?? "", subject: actorSubject },
        {
          action: AUDIT_ACTIONS.credentialDeleted,
          targetType: "connection",
          targetId: connectionId,
        },
      );
    }
    return deleted;
  },
});
