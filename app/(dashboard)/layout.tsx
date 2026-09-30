import { Suspense } from "react";
import { AppShell } from "@/components/dashboard/app-shell";
import { Skeleton } from "@/components/ui/skeleton";

function ShellFallback() {
  return (
    <div className="flex min-h-screen flex-col" aria-busy="true">
      <div className="h-14 border-b" />
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}

// The dashboard is a thin client over the public v1 API (Convex useQuery with the
// parent-issued token). The shell reads URL state (useSearchParams), so it renders
// inside Suspense to keep the rest of the tree prerenderable.
export default function DashboardLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense fallback={<ShellFallback />}>
      <AppShell>{children}</AppShell>
    </Suspense>
  );
}
