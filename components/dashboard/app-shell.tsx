"use client";

import { useState, type ReactNode } from "react";
import { CommandPalette, usePaletteShortcut } from "@/components/shell/command-palette";
import { MobileDock } from "@/components/shell/mobile-dock";
import { Sidebar } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/top-bar";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OrgProvider } from "@/lib/analytics/org-context";
import { OrganizationControl } from "./account-controls";
import { Brand, DashboardNav } from "./nav";
import { OrgGateMessage, useOrgGate } from "./org-gate";

/**
 * Dashboard shell (D21/D22): skip link; on large screens a sticky, collapsible sidebar; a
 * top bar (page trail, ⌘K search, organization, Convex status, user menu); on phones and
 * tablets a bottom dock whose Menu opens the full navigation in a sheet. Page content renders
 * only once the organization is resolved (D16).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const gate = useOrgGate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  usePaletteShortcut(() => setPaletteOpen((open) => !open));
  return (
    <TooltipProvider>
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <div className="group/shell flex min-h-dvh">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar gate={gate} onSearch={() => setPaletteOpen(true)} />
          <main
            id="main-content"
            tabIndex={-1}
            className="min-w-0 flex-1 p-4 pb-24 outline-none md:p-6 md:pb-24 lg:pb-8 has-[[data-inbox-workspace]]:p-0 has-[[data-inbox-workspace]]:pb-20 lg:has-[[data-inbox-workspace]]:pb-0"
          >
            {gate.status === "ready" ? (
              <OrgProvider org={gate.org}>
                <div className="mx-auto flex max-w-7xl flex-col gap-4 has-[[data-inbox-workspace]]:max-w-none">
                  {children}
                </div>
              </OrgProvider>
            ) : (
              <div className="mx-auto max-w-7xl">
                <OrgGateMessage state={gate} />
              </div>
            )}
          </main>
        </div>
      </div>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <MobileDock />
        <SheetContent side="left" className="flex w-72 flex-col gap-0 bg-canvas p-0">
          <SheetHeader className="h-14 shrink-0 justify-center px-5 py-0">
            <SheetTitle>
              <Brand />
            </SheetTitle>
            <SheetDescription className="sr-only">Dashboard navigation</SheetDescription>
          </SheetHeader>
          <OrganizationControl />
          <DashboardNav onNavigate={() => setMenuOpen(false)} />
        </SheetContent>
      </Sheet>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </TooltipProvider>
  );
}
