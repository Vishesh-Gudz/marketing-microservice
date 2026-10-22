import type { Id } from "../_generated/dataModel";
import type { DatabaseWriter } from "../_generated/server";
import type { AuditChanges } from "./validation";

export const AUDIT_ACTIONS = {
  orgProvisioned: "org.provisioned",
  orgSettingsUpdated: "org.settings.updated",
  // Standalone SaaS (Clerk): the name follows the verified org_name claim.
  orgRenamed: "org.renamed",
  // Phase 4: connections. Entries carry ids/statuses/counts only, never secrets.
  connectionOAuthStarted: "connection.oauth_started",
  connectionOAuthFailed: "connection.oauth_failed",
  connectionConnected: "connection.connected",
  connectionReconnected: "connection.reconnected",
  connectionAssetsDiscovered: "connection.assets_discovered",
  connectionDisconnected: "connection.disconnected",
  connectionNeedsReauth: "connection.needs_reauth",
  credentialDeleted: "credential.deleted",
  // S2: a consented grant waits for its initiator; a claim by anyone else invalidates it.
  connectionOAuthGranted: "connection.oauth_granted",
  connectionClaimRejected: "connection.claim_rejected",
  connectionGrantExpired: "connection.grant_expired",
  adAccountLinked: "adAccount.linked",
  adAccountRelinked: "adAccount.relinked",
  adAccountUnlinked: "adAccount.unlinked",
  // Phase 10: organic social accounts and Instagram token refresh.
  socialAccountLinked: "socialAccount.linked",
  socialAccountRelinked: "socialAccount.relinked",
  socialAccountUnlinked: "socialAccount.unlinked",
  connectionTokenRefreshed: "connection.token_refreshed",
  // Phase 5: sync. Routine runs are NOT audited (see syncRuns); only account-level
  // state changes are. Entries carry ids/kinds/counts only, never payloads.
  syncAccountBlocked: "sync.account_blocked",
  syncAccountUnblocked: "sync.account_unblocked",
  syncAccountAttributesChanged: "sync.account_attributes_changed",
  syncRemovalSkipped: "sync.removal_skipped",
  // WhatsApp inbox (ADR 0013): phone-number routing changes. Inbound messages and webhook
  // events are routine and NOT audited. Entries carry ids/statuses only, never content.
  whatsappNumberRegistered: "whatsapp.number_registered",
  whatsappNumberDisconnected: "whatsapp.number_disconnected",
} as const;

/** Actor used for audit entries written by scheduled system jobs. */
export const SYSTEM_SWEEP_SUBJECT = "system:connection-sweep";

/** Actor used for audit entries written by the daily token refresh job (Phase 10). */
export const SYSTEM_TOKEN_REFRESH_SUBJECT = "system:token-refresh";

/** Actor used for audit entries written by the sync engine (Phase 5). */
export const SYSTEM_SYNC_SUBJECT = "system:sync";

export type AuditEntryInput = {
  action: string;
  targetType?: string;
  targetId?: string;
  changes?: AuditChanges;
};

type AuditActor = { orgId: Id<"organizations">; issuer: string; subject: string };

/**
 * Records a successful state change. Must be called inside the mutation that
 * makes the change so both commit (or roll back) together.
 */
export async function writeAudit(
  db: DatabaseWriter,
  actor: AuditActor,
  entry: AuditEntryInput,
): Promise<Id<"auditLog">> {
  return await db.insert("auditLog", {
    orgId: actor.orgId,
    issuer: actor.issuer,
    subject: actor.subject,
    action: entry.action,
    ...(entry.targetType !== undefined ? { targetType: entry.targetType } : {}),
    ...(entry.targetId !== undefined ? { targetId: entry.targetId } : {}),
    ...(entry.changes !== undefined ? { changes: entry.changes } : {}),
    at: Date.now(),
  });
}
