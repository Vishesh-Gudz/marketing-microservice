"use client";

import { TriangleAlert } from "lucide-react";
import { SystemMessage } from "@/components/brand/system-message";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/analytics/errors";

// Last-resort boundary for the dashboard segment. Data regions have their own
// QueryBoundary; this catches anything else. Only contract error texts are shown.
export default function DashboardError({ error, retry }: { error: Error; retry: () => void }) {
  const described = describeError(error);
  return (
    <div className="flex justify-center py-10 md:py-16">
      <SystemMessage
        role="alert"
        icon={TriangleAlert}
        tone="danger"
        title={described.title}
        actions={
          <Button variant="outline" onClick={() => retry()}>
            Try again
          </Button>
        }
      >
        {described.message}
      </SystemMessage>
    </div>
  );
}
