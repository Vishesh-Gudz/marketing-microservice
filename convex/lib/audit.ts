import type { Id } from "../_generated/dataModel";
import type { DatabaseWriter } from "../_generated/server";
import type { AuditChanges } from "./validation";

export const AUDIT_ACTIONS = {
  orgProvisioned: "org.provisioned",
  orgSettingsUpdated: "org.settings.updated",
} as const;

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
