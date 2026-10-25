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
  // YouTube retention (ADR 0016, Checkpoint 3b): a channel's stored data is hard-deleted. Entries
  // carry the Convex row id, the reason, an allowlisted check outcome and counts only: never a
  // YouTube id, title, handle, token or error message.
  socialAccountPurgeStarted: "socialAccount.purge_started",
  socialAccountPurged: "socialAccount.purged",
  socialAccountAuthorizationInconclusive: "socialAccount.authorization_check_inconclusive",
  // Phase 5: sync. Routine runs are NOT audited (see syncRuns); only account-level
  // state changes are. Entries carry ids/kinds/counts only, never payloads.
  syncAccountBlocked: "sync.account_blocked",
  syncAccountUnblocked: "sync.account_unblocked",
  syncAccountAttributesChanged: "sync.account_attributes_changed",
  syncRemovalSkipped: "sync.removal_skipped",
  // WhatsApp inbox (ADR 0013): phone-number routing changes and admin requeues of failed
  // webhook events. Inbound messages and routine processing are NOT audited. Entries carry
  // ids/statuses only, never content.
  whatsappNumberRegistered: "whatsapp.number_registered",
  whatsappNumberDisconnected: "whatsapp.number_disconnected",
  whatsappEventRequeued: "whatsapp.event_requeued",
  // WhatsApp disconnect (ADR 0014 B4): how the Meta cleanup of a disconnected account ended.
  whatsappOffboardingCompleted: "whatsapp.offboarding_completed",
  whatsappOffboardingFailed: "whatsapp.offboarding_failed",
  // WhatsApp partner removal (ADR 0014 B4b): Meta confirmed our access to the WABA is gone.
  whatsappPartnerRemoved: "whatsapp.partner_removed",
} as const;

/** Actor used for audit entries written by scheduled system jobs. */
export const SYSTEM_SWEEP_SUBJECT = "system:connection-sweep";

/** Actor used for audit entries written by the WhatsApp disconnect cleanup's retries (B4). */
export const SYSTEM_WHATSAPP_OFFBOARDING_SUBJECT = "system:whatsapp-offboarding";

/** Actor used for audit entries written when a WhatsApp webhook confirms a removal (B4b). */
export const SYSTEM_WHATSAPP_WEBHOOK_SUBJECT = "system:whatsapp-webhook";

/** Actor used for audit entries written by the daily token refresh job (Phase 10). */
export const SYSTEM_TOKEN_REFRESH_SUBJECT = "system:token-refresh";

/** Actor used for audit entries written by the sync engine (Phase 5). */
export const SYSTEM_SYNC_SUBJECT = "system:sync";

/** Actor used for audit entries written by the YouTube retention jobs (ADR 0016). */
export const SYSTEM_YOUTUBE_RETENTION_SUBJECT = "system:youtube-retention";

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
