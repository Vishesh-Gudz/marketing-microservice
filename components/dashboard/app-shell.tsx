"use client";

import { Menu } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ConvexStatus } from "@/components/convex-status";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OrgProvider } from "@/lib/analytics/org-context";
import { AccountControls } from "./account-controls";
import { Brand, DashboardNav } from "./nav";
import { OrgBadge, OrgGateMessage, useOrgGate } from "./org-gate";

/**
 * Dashboard shell (D21/D22): skip link, header (menu, org, reporting currency,
 * Convex status), sidebar navigation on large screens and a sheet menu on small
 * ones. Page content renders only once the organization is resolved (D16).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const gate = useOrgGate();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <TooltipProvider>
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
                <Menu className="size-5" aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-4">
              <SheetHeader className="p-0 pb-4">
                <SheetTitle>
                  <Brand />
                </SheetTitle>
                <SheetDescription className="sr-only">Dashboard navigation</SheetDescription>
              </SheetHeader>
              <DashboardNav onNavigate={() => setMenuOpen(false)} />
            </SheetContent>
          </Sheet>
          <Brand />
          <div className="ml-auto flex items-center gap-3">
            <OrgBadge state={gate} />
            <span className="hidden sm:inline-flex">
              <ConvexStatus />
            </span>
            <AccountControls />
          </div>
        </header>
        <div className="flex flex-1">
          <aside className="hidden w-56 shrink-0 border-r p-3 lg:block">
            <DashboardNav />
          </aside>
          <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none md:p-6">
            {gate.status === "ready" ? (
              <OrgProvider org={gate.org}>
                <div className="mx-auto flex max-w-7xl flex-col gap-4">{children}</div>
              </OrgProvider>
            ) : (
              <div className="mx-auto max-w-7xl">
                <OrgGateMessage state={gate} />
              </div>
            )}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
