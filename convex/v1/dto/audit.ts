import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { toIso } from "../../lib/dto";
import { auditChangesValidator } from "../../lib/validation";

export const auditEntryDto = v.object({
  id: v.string(),
  action: v.string(),
  /** JWT `sub` of the actor: a user id or "service:<name>". */
  subject: v.string(),
  targetType: v.optional(v.string()),
  targetId: v.optional(v.string()),
  changes: v.optional(auditChangesValidator),
  at: v.string(),
});

export type AuditEntryDto = Infer<typeof auditEntryDto>;

export function toAuditEntryDto(entry: Doc<"auditLog">): AuditEntryDto {
  return {
    id: entry._id,
    action: entry.action,
    subject: entry.subject,
    ...(entry.targetType !== undefined ? { targetType: entry.targetType } : {}),
    ...(entry.targetId !== undefined ? { targetId: entry.targetId } : {}),
    ...(entry.changes !== undefined ? { changes: entry.changes } : {}),
    at: toIso(entry.at),
  };
}
