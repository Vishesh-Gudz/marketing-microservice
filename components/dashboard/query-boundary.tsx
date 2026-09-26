"use client";

import { catchError, type ErrorInfo } from "next/error";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/analytics/errors";
import { useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import { cn } from "@/lib/utils";

type FallbackProps = {
  title?: string;
  /** NOT_FOUND renders the dashboard's not-found page (entity pages). */
  notFoundAsPage?: boolean;
  className?: string;
};

/** D15: a too-much-data error comes with ways to narrow the view. */
function NarrowRangeActions() {
  const { filters, setFilters } = useDashboardFilters();
  const narrow = (preset: "last_7_days" | "yesterday") =>
    setFilters({ ...filters, preset, from: undefined, to: undefined });
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => narrow("last_7_days")}>
        Show last 7 days
      </Button>
      <Button variant="outline" size="sm" onClick={() => narrow("yesterday")}>
        Show yesterday
      </Button>
    </div>
  );
}

function RouteNotFound(): never {
  notFound();
}

function QueryErrorFallback(props: FallbackProps, { error, reset }: ErrorInfo) {
  const described = describeError(error);
  if (described.kind === "not_found" && props.notFoundAsPage) return <RouteNotFound />;
  return (
    <div
      role="alert"
      data-error-kind={described.kind}
      className={cn(
        "flex flex-col items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm",
        props.className,
      )}
    >
      <p className="font-medium">
        {props.title ? `${props.title}: ` : ""}
        {described.title}
      </p>
      <p className="text-muted-foreground">{described.message}</p>
      {described.kind === "too_many_rows" && <NarrowRangeActions />}
      {described.kind === "not_found" && (
        <Button asChild variant="outline" size="sm">
          <Link href="/">Go to the overview</Link>
        </Button>
      )}
      {described.retryable && (
        <Button variant="outline" size="sm" onClick={() => reset()}>
          Try again
        </Button>
      )}
    </div>
  );
}

const CatchQueryError = catchError(QueryErrorFallback);

/**
 * Error boundary for one data region (Next.js catchError, D4/D15). Convex
 * useQuery throws failed queries during render; the fallback shows the mapped
 * contract error. `resetKey` (the serialized query arguments) clears the error
 * when the user changes filters.
 */
export function QueryBoundary({
  resetKey,
  children,
  ...props
}: FallbackProps & { resetKey: string; children: ReactNode }) {
  return (
    <CatchQueryError key={resetKey} {...props}>
      {children}
    </CatchQueryError>
  );
}
