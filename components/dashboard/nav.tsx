"use client";

import {
  BarChart3,
  Building2,
  Camera,
  Layers,
  LayoutDashboard,
  Megaphone,
  MessageCircle,
  Plug,
  Target,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { filterParamsOnly } from "@/lib/analytics/filters";
import { cn } from "@/lib/utils";

export const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/breakdowns", label: "Breakdowns", icon: Layers },
  { href: "/conversions", label: "Conversions", icon: Target },
  { href: "/accounts", label: "Accounts", icon: Wallet },
  // Phase 10: organic Instagram, separate from the paid pages above.
  { href: "/social", label: "Organic", icon: Camera },
  // Standalone SaaS: members, invitations and roles (Clerk organization profile, D9).
  { href: "/organization", label: "Organization", icon: Building2 },
  // WhatsApp: the inbox (ADR 0013); /whatsapp/settings connects a number (ADR 0014).
  { href: "/whatsapp", label: "WhatsApp", icon: MessageCircle },
  // Google Ads connection management (connect, choose the account, follow its sync).
  { href: "/connections", label: "Connections", icon: Plug },
] as const;

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** Primary navigation. Links carry the global filters (not page params) along. */
export function DashboardNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = filterParamsOnly(new URLSearchParams(searchParams.toString())).toString();
  return (
    <nav aria-label="Main">
      <ul className="flex flex-col gap-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <li key={href}>
              <Link
                href={query ? `${href}?${query}` : href}
                aria-current={active ? "page" : undefined}
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                  active ? "bg-accent text-accent-foreground" : "text-muted-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function Brand() {
  return (
    <span className="flex items-center gap-2 font-semibold">
      <BarChart3 className="size-5" aria-hidden="true" />
      Marketing
    </span>
  );
}
