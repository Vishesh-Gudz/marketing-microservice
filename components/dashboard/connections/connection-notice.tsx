import type { Notice as NoticeText } from "@/lib/connections/types";
import { Notice } from "../notices";

/** A fixed-text notice from lib/connections (never raw codes or callback values). */
export function ConnectionNotice({ notice }: { notice: NoticeText }) {
  return (
    <Notice tone={notice.tone} label={notice.title}>
      <p className="font-medium">{notice.title}</p>
      <p>{notice.message}</p>
    </Notice>
  );
}
