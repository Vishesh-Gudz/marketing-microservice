import type { ReactNode } from "react";
import { Brand } from "@/components/dashboard/nav";
import { EmptyState } from "@/components/dashboard/empty-state";
import { AUTH_MODE } from "@/lib/auth/config";

/** Layout of the Clerk sign-in, sign-up and session-task pages (outside the dashboard shell). */
export function AuthPageShell({ children }: { children: ReactNode }) {
  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center gap-6 p-4"
    >
      <Brand />
      {children}
    </main>
  );
}

/** Shown on Clerk pages when this build does not sign in with Clerk. */
export function ClerkUnavailable() {
  return AUTH_MODE === "dev" ? (
    <EmptyState title="Sign-in is not used in local development">
      This build signs in with the local dev token. Run <code>npm run dev:auth setup</code> (see
      docs/setup.md), or remove <code>NEXT_PUBLIC_DEV_AUTH_TOKEN</code> and set the Clerk keys to
      sign in with Clerk.
    </EmptyState>
  ) : (
    <EmptyState title="Sign-in is not configured">
      This deployment has no Clerk publishable key, so nobody can sign in.
    </EmptyState>
  );
}
