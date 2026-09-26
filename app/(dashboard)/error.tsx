"use client";

import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/analytics/errors";

// Last-resort boundary for the dashboard segment. Data regions have their own
// QueryBoundary; this catches anything else. Only contract error texts are shown.
export default function DashboardError({ error, retry }: { error: Error; retry: () => void }) {
  const described = describeError(error);
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border p-6">
      <h1 className="text-lg font-semibold">{described.title}</h1>
      <p className="text-sm text-muted-foreground">{described.message}</p>
      <Button variant="outline" onClick={() => retry()}>
        Try again
      </Button>
    </div>
  );
}
