import { Loader2 } from "lucide-react";

/** Shown while previous data stays on screen and new arguments load (D4). */
export function UpdatingIndicator({ active }: { active: boolean }) {
  return (
    <span
      aria-live="polite"
      className="inline-flex min-h-4 items-center gap-1 text-xs text-muted-foreground"
    >
      {active && (
        <>
          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Updating…
        </>
      )}
    </span>
  );
}
