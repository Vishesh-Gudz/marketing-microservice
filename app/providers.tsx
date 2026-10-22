"use client";

import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { type ReactNode } from "react";
import {
  ClerkAuthUiProvider,
  DevAuthUiProvider,
  UnconfiguredAuthUiProvider,
} from "@/lib/auth/auth-ui";
import { AUTH_MODE, CLERK_ENABLED, DEV_AUTH_TOKEN } from "@/lib/auth/config";
import { createDevTokenSource } from "@/lib/auth/token-source";
import { useClerkConvexAuth } from "@/lib/auth/use-clerk-convex-auth";
import { useTokenAuth } from "@/lib/auth/use-token-auth";
import { readConvexUrl } from "@/lib/env";

const convex = new ConvexReactClient(readConvexUrl());

// Development builds with a dev token (scripts/dev-auth.mjs) use it and never mount Clerk.
// Every other build signs in with Clerk (ClerkProvider is mounted in app/layout.tsx); a
// build without a valid Clerk key stays signed out. AUTH_MODE is a build-time constant, so
// exactly one branch below is ever used.
const devTokenSource = createDevTokenSource(DEV_AUTH_TOKEN);

function useDevAuth() {
  return useTokenAuth(devTokenSource);
}

function useSignedOut() {
  return useTokenAuth(null);
}

export function Providers({ children }: { children: ReactNode }) {
  if (AUTH_MODE === "dev") {
    return (
      <ConvexProviderWithAuth client={convex} useAuth={useDevAuth}>
        <DevAuthUiProvider>{children}</DevAuthUiProvider>
      </ConvexProviderWithAuth>
    );
  }
  if (!CLERK_ENABLED) {
    return (
      <ConvexProviderWithAuth client={convex} useAuth={useSignedOut}>
        <UnconfiguredAuthUiProvider>{children}</UnconfiguredAuthUiProvider>
      </ConvexProviderWithAuth>
    );
  }
  return (
    <ConvexProviderWithAuth client={convex} useAuth={useClerkConvexAuth}>
      <ClerkAuthUiProvider>{children}</ClerkAuthUiProvider>
    </ConvexProviderWithAuth>
  );
}
