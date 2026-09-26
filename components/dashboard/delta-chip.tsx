import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { deltaView } from "@/lib/analytics/deltas";
import type { MoneyDelta, NumberDelta } from "@/lib/analytics/types";
import { cn } from "@/lib/utils";

const TONE_CLASS = {
  positive: "text-emerald-700 dark:text-emerald-400",
  negative: "text-red-700 dark:text-red-400",
  neutral: "text-muted-foreground",
} as const;

/**
 * Change versus the comparison period (D9): arrow, absolute change and percent.
 * Colour is never the only signal (arrow icon plus spelled-out direction).
 */
export function DeltaChip({
  metric,
  delta,
  className,
}: {
  metric: string;
  delta: NumberDelta | MoneyDelta | undefined;
  className?: string;
}) {
  const view = deltaView(metric, delta);
  if (view.kind === "none") return null;
  if (view.kind === "reason") {
    return (
      <span className={cn("text-xs text-muted-foreground", className)} data-slot="delta">
        {view.text}
        {view.partial && <span aria-label="(partial data)">*</span>}
      </span>
    );
  }
  const Icon =
    view.direction === "up" ? ArrowUpRight : view.direction === "down" ? ArrowDownRight : Minus;
  const word = view.direction === "up" ? "Up" : view.direction === "down" ? "Down" : "No change";
  return (
    <span
      className={cn(
        "inline-flex flex-wrap items-center gap-x-1 text-xs font-medium",
        TONE_CLASS[view.tone],
        className,
      )}
      data-slot="delta"
      data-tone={view.tone}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      <span className="sr-only">{word} </span>
      {view.absoluteText && <span className="tabular-nums">{view.absoluteText}</span>}
      <span className="tabular-nums">{view.absoluteText ? `(${view.text})` : view.text}</span>
      {view.partial && (
        <span aria-label="(partial data)" className="text-amber-600 dark:text-amber-400">
          *
        </span>
      )}
    </span>
  );
}
