"use client";

import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { type ReactNode } from "react";
import { createDevTokenSource } from "@/lib/auth/token-source";
import { useTokenAuth } from "@/lib/auth/use-token-auth";
import { readConvexUrl } from "@/lib/env";

const convex = new ConvexReactClient(readConvexUrl());

// The parent application owns authentication and hands us a signed JWT.
// In development that token comes from scripts/dev-auth.mjs; the parent
// (postMessage) token source arrives in Phase 15.
// The NODE_ENV guard is resolved at build time, so production bundles never
// even contain the dev token string.
const tokenSource = createDevTokenSource(
  process.env.NODE_ENV === "production" ? undefined : process.env.NEXT_PUBLIC_DEV_AUTH_TOKEN,
);

function useAuth() {
  return useTokenAuth(tokenSource);
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
      {children}
    </ConvexProviderWithAuth>
  );
}
