import { ClerkLoading } from "@clerk/nextjs";
import { Check } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Brand } from "@/components/dashboard/nav";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { AUTH_MODE } from "@/lib/auth/config";
import { LEGAL } from "@/lib/legal/company";

// What the product does today (no plans or claims): the three areas the dashboard covers.
const AREAS = [
  "Google Ads and Meta Ads results in your reporting currency",
  "Instagram and YouTube organic performance",
  "WhatsApp and Instagram conversations in one inbox",
];

function LegalLinks() {
  return (
    <nav
      aria-label="Legal"
      className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
    >
      <Link href="/privacy" className="hover:text-ink hover:underline">
        Privacy policy
      </Link>
      <Link href="/data-deletion" className="hover:text-ink hover:underline">
        Data deletion
      </Link>
    </nav>
  );
}

/**
 * Layout of the Clerk sign-in, sign-up and session-task pages (outside the dashboard shell):
 * on large screens a brand panel on a dot grid next to the form; on small ones the brand above
 * it. The form area keeps the Clerk card's size while Clerk loads, so nothing moves.
 */
export function AuthPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="gudz-dot-grid relative hidden flex-col justify-between border-r border-line bg-canvas p-10 lg:flex">
        <Brand />
        <div className="flex max-w-md flex-col gap-6">
          <p className="text-[28px] leading-[1.15] font-medium tracking-[-0.02em] text-ink">
            Ads, organic and messaging, in one place.
          </p>
          <ul className="flex flex-col gap-3">
            {AREAS.map((area) => (
              <li key={area} className="flex items-start gap-3 text-sm text-ink-2">
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-blue-50 text-blue-deep">
                  <Check className="size-3" aria-hidden="true" />
                </span>
                {area}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2">
          <LegalLinks />
          <p className="text-xs text-muted-foreground">{LEGAL.companyName}</p>
        </div>
      </aside>
      <main
        id="main-content"
        className="flex flex-col items-center justify-center gap-8 px-4 py-10"
      >
        <span className="lg:hidden">
          <Brand />
        </span>
        <div className="flex min-h-[33rem] w-full max-w-[26rem] items-center justify-center">
          {children}
        </div>
        <span className="lg:hidden">
          <LegalLinks />
        </span>
      </main>
    </div>
  );
}

/**
 * Stands in for the Clerk card until Clerk has loaded (Clerk mode only), at the card's size.
 */
export function ClerkCardPlaceholder() {
  return (
    <ClerkLoading>
      <div
        role="status"
        aria-label="Loading sign-in"
        className="flex w-full flex-col gap-4 rounded-[14px] border border-line bg-paper p-8 shadow-soft"
      >
        <Skeleton className="mx-auto h-6 w-48" />
        <Skeleton className="mx-auto h-4 w-56" />
        <Skeleton className="mt-4 h-10 w-full rounded-[10px]" />
        <Skeleton className="h-10 w-full rounded-[10px]" />
        <Skeleton className="mt-2 h-10 w-full rounded-[10px]" />
      </div>
    </ClerkLoading>
  );
}

/** Shown on Clerk pages when this build does not sign in with Clerk. */
export function ClerkUnavailable() {
  return AUTH_MODE === "dev" ? (
    <EmptyState level={1} title="Sign-in is not used in local development">
      This build signs in with the local dev token. Run <code>npm run dev:auth setup</code> (see
      docs/setup.md), or remove <code>NEXT_PUBLIC_DEV_AUTH_TOKEN</code> and set the Clerk keys to
      sign in with Clerk.
    </EmptyState>
  ) : (
    <EmptyState level={1} title="Sign-in is not configured">
      This deployment has no Clerk publishable key, so nobody can sign in.
    </EmptyState>
  );
}
