"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";

export function ConvexStatus() {
  const health = useQuery(api.health.ping);

  if (health === undefined) {
    return <Badge variant="outline">Connecting to Convex…</Badge>;
  }

  return <Badge variant={health.ok ? "default" : "destructive"}>Convex: {health.service}</Badge>;
}
