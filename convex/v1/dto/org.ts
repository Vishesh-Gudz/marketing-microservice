import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { toIso } from "../../lib/dto";
import { roleValidator, type Role } from "../../lib/validation";

export const orgDto = v.object({
  id: v.string(),
  externalOrgId: v.string(),
  issuer: v.string(),
  displayName: v.string(),
  reportingCurrency: v.string(),
  timezone: v.string(),
  /** The caller's role, taken from their token (not stored on the org). */
  role: roleValidator,
  createdAt: v.string(),
  updatedAt: v.string(),
});

export type OrgDto = Infer<typeof orgDto>;

export function toOrgDto(org: Doc<"organizations">, role: Role): OrgDto {
  return {
    id: org._id,
    externalOrgId: org.externalOrgId,
    issuer: org.issuer,
    displayName: org.displayName,
    reportingCurrency: org.reportingCurrency,
    timezone: org.timezone,
    role,
    createdAt: toIso(org.createdAt),
    updatedAt: toIso(org.updatedAt),
  };
}
