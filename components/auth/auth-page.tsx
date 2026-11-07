import { ClerkLoading } from "@clerk/nextjs";
import { Camera, Inbox, Megaphone } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/brand/logo";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { AUTH_MODE } from "@/lib/auth/config";
import { LEGAL } from "@/lib/legal/company";

// The sign-in frame in the Gudz Control format (apps/control auth-layout): a quiet brand panel
// on a fading dot grid beside the form; on phones the form alone, the wordmark on top. Every
// line says what the product does today (no plans or claims).

/** "GUDZ | Marketing": the wordmark, a hairline, the product name. */
function BrandRow({ size }: { size: "lg" | "sm" }) {
  return (
    <div className="flex items-center gap-3">
      <Logo className={size === "lg" ? "h-[22px] w-auto" : "h-5 w-auto"} />
      <span className="sr-only">Gudz</span>
      <span aria-hidden="true" className="h-4 w-px bg-line-strong" />
      <span className="text-[13px] font-medium tracking-wide text-muted-foreground">Marketing</span>
    </div>
  );
}

function Feature({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3.5 rounded-[14px] bg-paper/80 p-4 shadow-[0_0_0_1px_var(--color-line)] backdrop-blur">
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-blue-50 text-blue-deep"
      >
        {icon}
      </span>
      <span className="flex flex-col">
        <span className="text-[13.5px] font-medium text-ink">{title}</span>
        <span className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

function LegalLinks() {
  return (
    <nav
      aria-label="Legal"
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-muted-foreground"
    >
      <Link href="/privacy" className="hover:text-ink hover:underline">
        Privacy policy
      </Link>
      <span aria-hidden="true">·</span>
      <Link href="/data-deletion" className="hover:text-ink hover:underline">
        Data deletion
      </Link>
      <span aria-hidden="true">·</span>
      <span>{LEGAL.companyName}</span>
    </nav>
  );
}

/**
 * Layout of the Clerk sign-in, sign-up and session-task pages (outside the dashboard shell).
 * `title` and `description` head the form; Clerk's own card renders flat under them
 * (CLERK_EMBEDDED). The form area keeps the widget's height while Clerk loads, so nothing moves.
 */
export function AuthPageShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-paper lg:grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <aside
        aria-label="Gudz Marketing"
        className="relative hidden overflow-hidden border-r border-line bg-canvas lg:flex lg:flex-col lg:justify-between lg:p-12"
      >
        <div aria-hidden="true" className="gudz-dot-canvas pointer-events-none absolute inset-0" />
        <div className="relative">
          <BrandRow size="lg" />
        </div>
        <div className="relative max-w-[460px]">
          <p className="text-[44px] leading-[1.04] font-medium tracking-[-0.035em] text-ink">
            All your channels,
            <br />
            <span className="text-blue-deep">in one place.</span>
          </p>
          <p className="mt-5 text-[15px] leading-relaxed text-muted-foreground">
            Your ad accounts, social channels and customer conversations — in one dashboard for your
            team.
          </p>
          <ul className="mt-10 grid gap-3">
            <Feature icon={<Megaphone className="size-4" />} title="Paid results in one currency">
              Google Ads and Meta Ads campaigns, converted to your reporting currency.
            </Feature>
            <Feature icon={<Camera className="size-4" />} title="Organic performance">
              Instagram posts and YouTube videos with their metrics, day by day.
            </Feature>
            <Feature icon={<Inbox className="size-4" />} title="One inbox">
              WhatsApp and Instagram conversations, with saved replies and templates.
            </Feature>
          </ul>
        </div>
        <div className="relative">
          <LegalLinks />
        </div>
      </aside>
      <main
        id="main-content"
        className="flex min-h-dvh flex-col px-6 pt-[max(24px,env(safe-area-inset-top))] pb-8 lg:items-center lg:justify-center lg:px-12"
      >
        <div className="lg:hidden">
          <BrandRow size="sm" />
        </div>
        <div className="flex w-full flex-1 flex-col justify-center py-10 lg:max-w-[400px] lg:flex-none lg:py-0">
          <h1 className="text-[26px] font-medium tracking-[-0.025em] text-ink">{title}</h1>
          <p className="mt-1.5 text-[14px] text-muted-foreground">{description}</p>
          <div className="mt-7 flex min-h-[26rem] w-full flex-col">{children}</div>
        </div>
        <div className="lg:hidden">
          <LegalLinks />
        </div>
      </main>
    </div>
  );
}

/**
 * Stands in for the Clerk form until Clerk has loaded (Clerk mode only), at its size: the
 * provider button, the divider, the email field and the continue button.
 */
export function ClerkCardPlaceholder() {
  return (
    <ClerkLoading>
      <div role="status" aria-label="Loading sign-in" className="flex w-full flex-col gap-4">
        <Skeleton className="h-11 w-full rounded-[10px]" />
        <Skeleton className="mx-auto my-3 h-3 w-24" />
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-11 w-full rounded-[10px]" />
        <Skeleton className="h-11 w-full rounded-[10px]" />
      </div>
    </ClerkLoading>
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
