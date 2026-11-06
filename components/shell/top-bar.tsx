"use client";

import { ChevronRight, Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { ConvexStatus } from "@/components/convex-status";
import { UserControl } from "@/components/dashboard/account-controls";
import { Brand, navTrail } from "@/components/dashboard/nav";
import { OrgBadge, type OrgGateState } from "@/components/dashboard/org-gate";
import { useShortcutLabel } from "./command-palette";

/**
 * Where the page sits: "Analytics › Campaigns". The page's own h1 names it for screen readers.
 * Pages with their own breadcrumb (records, templates, settings) show only theirs.
 */
function PageTrail() {
  const trail = navTrail(usePathname());
  if (trail.length === 0) return null;
  return (
    <p className="hidden min-w-0 items-center gap-1.5 text-sm lg:flex group-has-[main_nav[aria-label=Breadcrumb]]/shell:hidden">
      {trail.map((part, i) => {
        const last = i === trail.length - 1;
        return (
          <span key={part} className="flex min-w-0 items-center gap-1.5">
            <span
              className={last ? "truncate font-medium text-ink" : "shrink-0 text-muted-foreground"}
            >
              {part}
            </span>
            {!last && <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden="true" />}
          </span>
        );
      })}
    </p>
  );
}

function SearchButton({ onClick }: { onClick: () => void }) {
  const shortcut = useShortcutLabel();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Search pages"
      aria-keyshortcuts="Meta+K Control+K"
      className="flex h-9 shrink-0 items-center gap-2 rounded-[10px] border border-line bg-canvas px-2.5 text-sm text-muted-foreground transition-colors duration-150 hover:border-line-strong hover:text-ink-2 xl:w-56"
    >
      <Search className="size-4 shrink-0" aria-hidden="true" />
      <span className="hidden flex-1 text-left xl:inline">Search</span>
      <kbd
        aria-hidden="true"
        className="hidden rounded-[6px] border border-line bg-paper px-1.5 py-0.5 font-mono text-[11px] leading-none xl:inline"
      >
        {shortcut}
      </kbd>
    </button>
  );
}

/**
 * The top bar: the brand on small screens (the sidebar shows it on large ones), where the
 * page sits, page search (⌘K), the organization, Convex status and the Clerk user menu.
 */
export function TopBar({ gate, onSearch }: { gate: OrgGateState; onSearch: () => void }) {
  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-paper/90 px-4 backdrop-blur md:px-6">
      <span className="shrink-0 lg:hidden">
        <Brand />
      </span>
      <PageTrail />
      <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
        <SearchButton onClick={onSearch} />
        <OrgBadge state={gate} />
        <span className="hidden md:inline-flex">
          <ConvexStatus />
        </span>
        <UserControl />
      </div>
    </header>
  );
}
