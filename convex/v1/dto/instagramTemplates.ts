import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { toIso } from "../../lib/dto";
import { templateContentValidator } from "../../instagram/messaging/templates";

/** An Instagram template (ADR 0022): business content only. */
export const instagramTemplateDto = v.object({
  id: v.string(),
  name: v.string(),
  content: templateContentValidator,
  updatedAt: v.string(),
});
export type InstagramTemplateDto = Infer<typeof instagramTemplateDto>;

export function toInstagramTemplateDto(template: Doc<"instagramTemplates">): InstagramTemplateDto {
  return {
    id: template._id,
    name: template.name,
    content: template.content,
    updatedAt: toIso(template.updatedAt),
  };
}
