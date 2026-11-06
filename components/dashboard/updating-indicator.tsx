import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shown while previous data stays on screen and new arguments load (D4). `overlay` floats it
 * over the top of the nearest positioned container (a table or chart surface) instead of
 * taking a line of its own, so an idle indicator leaves no gap.
 */
export function UpdatingIndicator({
  active,
  overlay = false,
}: {
  active: boolean;
  overlay?: boolean;
}) {
  return (
    <span
      aria-live="polite"
      className={cn(
        overlay
          ? "pointer-events-none absolute top-2 left-1/2 z-20 -translate-x-1/2"
          : "inline-flex min-h-4 items-center gap-1 text-xs text-muted-foreground",
      )}
    >
      {active && (
        <span
          className={cn(
            "inline-flex items-center gap-1 text-xs text-muted-foreground",
            overlay && "rounded-full border border-line bg-paper px-2.5 py-1 shadow-soft",
          )}
        >
          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Updating…
        </span>
      )}
    </span>
  );
}
