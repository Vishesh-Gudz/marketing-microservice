"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";

// The badge switches variant (outline → default) as soon as Convex answers. Badge's default
// color transition would fade the text from dark to light over a dark background, and an
// accessibility scan landing mid-fade measures a failing contrast. The status swaps instantly.
const STATUS_BADGE = "transition-none";

export function ConvexStatus() {
  const health = useQuery(api.health.ping);

  if (health === undefined) {
    return (
      <Badge variant="outline" className={STATUS_BADGE}>
        Connecting to Convex…
      </Badge>
    );
  }

  return (
    <Badge variant={health.ok ? "default" : "destructive"} className={STATUS_BADGE}>
      Convex: {health.service}
    </Badge>
  );
}
