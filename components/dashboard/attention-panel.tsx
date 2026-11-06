"use client";

import { useId, type ReactNode } from "react";
import { NoticeList } from "./notices";

/**
 * "Needs attention" at the top of a briefing: the page's warnings (Notice components) as rows
 * of one panel instead of a stack of banners. Render it only when there is at least one row.
 */
export function AttentionPanel({ children }: { children: ReactNode }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="overflow-hidden rounded-[14px] border border-amber-line bg-paper shadow-soft"
    >
      <div className="flex items-center gap-2 border-b border-amber-line bg-amber-tint px-4 py-2.5">
        <span className="size-1.5 rounded-full bg-amber" aria-hidden="true" />
        <h2 id={id} className="text-[13px] font-medium text-amber-ink">
          Needs attention
        </h2>
      </div>
      <NoticeList>{children}</NoticeList>
    </section>
  );
}
