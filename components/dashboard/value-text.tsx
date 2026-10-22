"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ValueView } from "@/lib/analytics/values";
import { cn } from "@/lib/utils";
import { PartialMarker } from "./partial-marker";

/**
 * Renders a ValueView (D10/D11): the exact formatted value with a partial-data
 * marker; "Multiple currencies" with a popover listing each native amount; or
 * "—" whose reason is reachable by keyboard and screen readers.
 */
export function ValueText({ view, className }: { view: ValueView; className?: string }) {
  if (view.kind === "unavailable") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "cursor-help text-muted-foreground underline decoration-dotted",
              className,
            )}
          >
            <span aria-hidden="true">{view.text}</span>
            <span className="sr-only">Not available: {view.reason}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>{view.reason}</TooltipContent>
      </Tooltip>
    );
  }
  const partial = view.partial && (
    <PartialMarker className="ml-0.5 text-amber-600 dark:text-amber-400" />
  );
  if (!view.detail) {
    return (
      <span className={cn("tabular-nums", className)}>
        {view.text}
        {partial}
      </span>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn("underline decoration-dotted", className)}
          aria-label={`${view.text}${view.partial ? " (partial data)" : ""}: show amounts per currency`}
        >
          {view.text}
          {partial}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto text-sm">
        <p className="mb-1 text-xs text-muted-foreground">
          Amounts per currency (not added together)
        </p>
        <ul className="tabular-nums">
          {view.detail.map((amount) => (
            <li key={amount}>{amount}</li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
