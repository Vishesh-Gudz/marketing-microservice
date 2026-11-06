"use client";

import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { OrganizationControl } from "@/components/dashboard/account-controls";
import { Brand, DashboardNav } from "@/components/dashboard/nav";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { setSidebarCollapsed, useSidebarCollapsed } from "./use-sidebar-collapsed";

/**
 * The large-screen sidebar (1024 px and up): brand, organization switcher, grouped
 * navigation, and a toggle that collapses it to a 64 px icon rail (kept in this browser).
 * It stays in place while the page scrolls.
 */
export function Sidebar() {
  const collapsed = useSidebarCollapsed();
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const toggle = (
    <button
      type="button"
      onClick={() => setSidebarCollapsed(!collapsed)}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-[8px] px-2.5 text-sm text-muted-foreground transition-colors duration-150 hover:bg-canvas-2 hover:text-ink",
        collapsed ? "size-10 justify-center px-0" : "w-full",
      )}
    >
      <ToggleIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className={cn(collapsed && "sr-only")}>{collapsed ? toggleLabel : "Collapse"}</span>
    </button>
  );
  return (
    // The outer column runs the full page height (its canvas and hairline reach the bottom of
    // long pages); the inner panel is one screen tall and stays in place.
    <div
      data-testid="sidebar"
      data-collapsed={collapsed || undefined}
      className={cn(
        "hidden shrink-0 border-r border-line bg-canvas transition-[width] duration-200 ease-out lg:block",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className="sticky top-0 flex h-dvh flex-col">
        <div
          className={cn("flex h-14 shrink-0 items-center", collapsed ? "justify-center" : "px-5")}
        >
          <Brand compact={collapsed} />
        </div>
        <OrganizationControl collapsed={collapsed} />
        <DashboardNav collapsed={collapsed} />
        <div
          className={cn("shrink-0 border-t border-line p-3", collapsed && "flex justify-center")}
        >
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>{toggle}</TooltipTrigger>
              <TooltipContent side="right" sideOffset={10}>
                {toggleLabel}
              </TooltipContent>
            </Tooltip>
          ) : (
            toggle
          )}
        </div>
      </div>
    </div>
  );
}
