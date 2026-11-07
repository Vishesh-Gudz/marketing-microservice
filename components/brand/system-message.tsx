import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The message of a system page (page not found, an item not found, something went wrong): an
 * icon, the heading, what happened and what to do next, centred on a card. `tone` only tints
 * the icon; the words carry the meaning.
 */
export function SystemMessage({
  icon: Icon,
  eyebrow,
  title,
  children,
  actions,
  tone = "neutral",
  role,
  className,
}: {
  icon: LucideIcon;
  /** A short line above the heading, e.g. "404". */
  eyebrow?: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  tone?: "neutral" | "danger";
  role?: "alert";
  className?: string;
}) {
  return (
    <div
      role={role}
      className={cn(
        "flex w-full max-w-md flex-col items-center gap-3 rounded-[16px] border border-line bg-paper px-6 py-8 text-center shadow-soft sm:px-8",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-11 place-items-center rounded-[12px] border",
          tone === "danger"
            ? "border-danger-line bg-danger-tint text-danger-ink"
            : "border-line bg-canvas text-ink-2",
        )}
      >
        <Icon className="size-5" />
      </span>
      {eyebrow !== undefined && (
        <p className="font-mono text-xs tracking-wide text-muted-foreground">{eyebrow}</p>
      )}
      <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
      {children !== undefined && (
        <div className="max-w-sm text-sm text-muted-foreground">{children}</div>
      )}
      {actions !== undefined && (
        <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div>
      )}
    </div>
  );
}
