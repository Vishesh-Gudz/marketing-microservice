import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A page or section with nothing to show yet. The title is a heading (level 2 by default; pass `level={1}` when it is the whole page, or
 * `level={3}` inside a section that already has an h2) so screen readers can jump to it.
 */
export function EmptyState({
  title,
  children,
  action,
  className,
  level = 2,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  level?: 1 | 2 | 3;
}) {
  const Heading = level === 1 ? "h1" : level === 3 ? "h3" : "h2";
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed border-line-strong bg-paper p-8 text-center",
        className,
      )}
    >
      <Heading className="text-[15px] font-medium text-ink">{title}</Heading>
      {children && <div className="max-w-prose text-sm text-muted-foreground">{children}</div>}
      {action}
    </div>
  );
}
