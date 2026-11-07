import { cn } from "@/lib/utils";
import { Logo } from "./logo";

/**
 * "Gudz Marketing": the Gudz wordmark in the logo blue, then the product name. Its own module
 * (no client code), so the public pages that show it do not load the dashboard navigation.
 */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <Logo className={cn("w-auto", compact ? "h-[11px]" : "h-[18px]")} />
      <span className="sr-only">Gudz</span>
      <span
        className={cn("text-[15px] font-medium tracking-[-0.01em] text-ink", compact && "sr-only")}
      >
        Marketing
      </span>
    </span>
  );
}
