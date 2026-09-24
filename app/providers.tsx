"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { type ReactNode } from "react";
import { readConvexUrl } from "@/lib/env";

const convex = new ConvexReactClient(readConvexUrl());

// Phase 0: unauthenticated client. Phase 1 swaps this for
// ConvexProviderWithAuth fed by the parent application's signed JWT.
export function Providers({ children }: { children: ReactNode }) {
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}
