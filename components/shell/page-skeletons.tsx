import type { ReactNode } from "react";
import { RouteProgress } from "@/components/brand/gudz-loader";
import { Skeleton } from "@/components/ui/skeleton";

// Route loading states (`loading.tsx`), shaped like the page that is coming so nothing jumps
// when it arrives, with the progress bar at the top of the window. Shown inside the shell,
// which stays interactive.

function Frame({ children }: { children: ReactNode }) {
  return (
    <div role="status" aria-label="Loading page" aria-busy="true" className="flex flex-col gap-4">
      <RouteProgress />
      {children}
    </div>
  );
}

function Heading({ crumb = false }: { crumb?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {crumb && <Skeleton className="h-4 w-40" />}
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80 max-w-full" />
    </div>
  );
}

function KpiRow() {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-24 rounded-[14px]" />
      ))}
    </div>
  );
}

/** Analytics and organic pages: heading, filters, KPI tiles, a chart or table. */
export function WorkspaceSkeleton() {
  return (
    <Frame>
      <Heading />
      <Skeleton className="h-24 rounded-[14px]" />
      <KpiRow />
      <Skeleton className="h-72 rounded-[14px]" />
    </Frame>
  );
}

/** A campaign, ad group or post: breadcrumb, heading, KPI tiles, chart. */
export function RecordSkeleton() {
  return (
    <Frame>
      <Heading crumb />
      <KpiRow />
      <Skeleton className="h-72 rounded-[14px]" />
    </Frame>
  );
}

/** Saved replies and template libraries: heading, an action, a list of items. */
export function LibrarySkeleton() {
  return (
    <Frame>
      <Heading crumb />
      <Skeleton className="h-9 w-40 rounded-[10px]" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20 rounded-[14px]" />
        ))}
      </div>
    </Frame>
  );
}

/** One conversation: breadcrumb, heading, messages, the reply box. */
export function ConversationSkeleton() {
  return (
    <Frame>
      <Heading crumb />
      <div className="flex flex-col gap-3 rounded-[14px] border border-line p-4">
        <Skeleton className="h-12 w-2/3 rounded-[12px]" />
        <Skeleton className="ml-auto h-12 w-1/2 rounded-[12px]" />
        <Skeleton className="h-12 w-3/5 rounded-[12px]" />
      </div>
      <Skeleton className="h-28 rounded-[14px]" />
    </Frame>
  );
}
