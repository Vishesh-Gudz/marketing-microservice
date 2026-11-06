import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";

/**
 * The Gudz loader: the wordmark over a thin indeterminate bar (a still bar with reduced
 * motion). A polite live region, so text added inside it later ("Still connecting…") is read
 * out.
 */
export function GudzLoader({
  label,
  children,
  className,
}: {
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className={cn("flex flex-col items-center gap-5 py-24 text-center", className)}
    >
      <Logo width={undefined} height={undefined} className="h-6 w-auto" aria-hidden="true" />
      <div
        aria-hidden="true"
        className="relative h-0.5 w-32 overflow-hidden rounded-full bg-canvas-2"
      >
        <div className="gudz-indeterminate absolute inset-y-0 left-0 w-1/3 rounded-full bg-blue-deep" />
      </div>
      {children}
    </div>
  );
}

/** A 2 px bar across the top of the window while a page loads (route `loading.tsx` files). */
export function RouteProgress() {
  return (
    <div
      aria-hidden="true"
      data-testid="route-progress"
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden"
    >
      <div className="gudz-indeterminate h-full w-1/3 bg-blue-deep" />
    </div>
  );
}
