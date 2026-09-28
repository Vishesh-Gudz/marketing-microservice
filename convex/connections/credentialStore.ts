import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type ActionCtx,
  type DatabaseReader,
  type DatabaseWriter,
} from "../_generated/server";
import type { ConnectionProvider } from "../domain/types";
import { AUDIT_ACTIONS, writeAudit } from "../lib/audit";
import {
  CREDENTIAL_ALGORITHM,
  credentialAad,
  decryptJson,
  encryptJson,
  loadKeyRing,
  type EncryptedPayload,
} from "../lib/crypto";

/**
 * THE credential store. The only module that reads or writes the `credentials`
 * table and the only place that decrypts (both ESLint enforced).
 *
 * - Ciphertext only in the database, mutations and queries. Plaintext exists
 *   only inside actions, via `encryptCredential` / `withConnectionCredential`.
 * - AAD = orgId|provider|externalUserId|v1: a ciphertext moved to another
 *   connection or org fails authentication.
 * - Nothing here is public; no function returns plaintext.
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

/**
 * Creates or reconnects the connection named by a CONSUMED OAuth state and
 * stores its encrypted credential, atomically. The org, provider, issuer and
 * initiator all come from the stored state, never from the caller.
 */
export const upsertConnectionWithCredential = internalMutation({
  args: {
    stateId: v.id("oauthStates"),
    identity: v.object({ externalUserId: v.string(), displayName: v.optional(v.string()) }),
    grantedScopes: v.array(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    encrypted: encryptedValidator,
  },
  returns: v.union(
    v.object({ ok: v.literal(true), connectionId: v.id("connections"), reconnected: v.boolean() }),
    v.object({
      ok: v.literal(false),
      reason: v.union(v.literal("identity_mismatch"), v.literal("invalid_state")),
    }),
  ),
  handler: async (ctx, args) => {
    const state = await ctx.db.get(args.stateId);
    if (state === null || state.status !== "consumed")
      return { ok: false as const, reason: "invalid_state" as const };
    const org = await ctx.db.get(state.orgId);
    if (org === null) return { ok: false as const, reason: "invalid_state" as const };

    const now = Date.now();
    const actor = { orgId: state.orgId, issuer: state.issuer, subject: state.initiatedBySubject };

    if (state.reconnectConnectionId !== undefined) {
      const target = await ctx.db.get(state.reconnectConnectionId);
      if (
        target === null ||
        target.orgId !== state.orgId ||
        target.provider !== state.provider ||
        target.externalUserId !== args.identity.externalUserId
      ) {
        return { ok: false as const, reason: "identity_mismatch" as const };
      }
    }

    const existing = await ctx.db
      .query("connections")
      .withIndex("by_org_provider_identity", (q) =>
        q
          .eq("orgId", state.orgId)
          .eq("provider", state.provider)
          .eq("externalUserId", args.identity.externalUserId),
      )
      .unique();

    const fields = {
      displayName: args.identity.displayName,
      status: "active" as const,
      grantedScopes: args.grantedScopes,
      tokenExpiresAt: args.tokenExpiresAt,
      lastError: undefined,
      revokedAt: undefined,
      connectedBySubject: state.initiatedBySubject,
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
        orgId: state.orgId,
        provider: state.provider,
        externalUserId: args.identity.externalUserId,
        ...(args.identity.displayName !== undefined
          ? { displayName: args.identity.displayName }
          : {}),
        status: "active",
        grantedScopes: args.grantedScopes,
        credentialVersion: 1,
        ...(args.tokenExpiresAt !== undefined ? { tokenExpiresAt: args.tokenExpiresAt } : {}),
        connectedBySubject: state.initiatedBySubject,
        connectedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    await writeCredential(ctx.db, state.orgId, connectionId, args.encrypted, now);
    await writeAudit(ctx.db, actor, {
      action: existing ? AUDIT_ACTIONS.connectionReconnected : AUDIT_ACTIONS.connectionConnected,
      targetType: "connection",
      targetId: connectionId,
      changes: { provider: { from: null, to: state.provider } },
    });
    return { ok: true as const, connectionId, reconnected: existing !== null };
  },
});

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
