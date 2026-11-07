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

/**
 * One conversation, as the inbox workspace shows it (Kinso K3): the header bar, messages at the
 * bottom of the history, the composer card. Fills the pane like the conversation does.
 */
export function ConversationSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading page"
      aria-busy="true"
      data-conversation-pane=""
      className="flex flex-col lg:h-full"
    >
      <RouteProgress />
      <div className="flex items-center gap-3 border-b border-line px-4 py-3 md:px-6">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56 max-w-full" />
        </div>
      </div>
      <div className="flex min-h-64 flex-1 flex-col bg-canvas/50 px-4 py-5 md:px-6">
        <div className="mx-auto mt-auto flex w-full max-w-3xl flex-col gap-3">
          <Skeleton className="h-12 w-3/5 rounded-[16px]" />
          <Skeleton className="ml-auto h-12 w-1/2 rounded-[16px]" />
          <Skeleton className="h-16 w-2/3 rounded-[16px]" />
        </div>
      </div>
      <div className="bg-canvas/50 px-3 pb-3 md:px-6 md:pb-4">
        <Skeleton className="mx-auto h-32 w-full max-w-3xl rounded-[14px]" />
      </div>
    </div>
  );
}
