"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_LINKS, activeHref, useNavQuery, withQuery } from "@/components/dashboard/nav";
import { SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const DOCK_HREFS = ["/", "/inbox", "/campaigns", "/social"] as const;
const DOCK_LINKS = DOCK_HREFS.map((href) => NAV_LINKS.find((link) => link.href === href)!);

const ITEM =
  "flex h-full flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors duration-150";

/**
 * Phones and tablets (below 1024 px): the four most used pages plus the full menu, in a dock
 * at the bottom of the screen. Must render inside the menu's <Sheet>.
 */
export function MobileDock() {
  const current = activeHref(usePathname());
  const query = useNavQuery();
  return (
    <nav
      aria-label="Shortcuts"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <ul className="mx-auto grid h-16 max-w-md grid-cols-5">
        {DOCK_LINKS.map((link) => {
          const isCurrent = current === link.href;
          const Icon = link.icon;
          return (
            <li key={link.href}>
              <Link
                href={withQuery(link.href, query)}
                aria-current={isCurrent ? "page" : undefined}
                className={cn(
                  ITEM,
                  isCurrent ? "text-blue-deep" : "text-muted-foreground hover:text-ink",
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
                {link.label}
              </Link>
            </li>
          );
        })}
        <li>
          <SheetTrigger asChild>
            <button
              type="button"
              aria-label="Open menu"
              className={cn(ITEM, "w-full text-muted-foreground hover:text-ink")}
            >
              <Menu className="size-5" aria-hidden="true" />
              Menu
            </button>
          </SheetTrigger>
        </li>
      </ul>
    </nav>
  );
}
