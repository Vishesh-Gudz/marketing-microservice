"use client";

import {
  Building2,
  Camera,
  ChevronDown,
  Inbox,
  Layers,
  LayoutDashboard,
  LayoutTemplate,
  Megaphone,
  MessageCircle,
  MessageSquareText,
  Plug,
  Send,
  Settings,
  Target,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { Logo } from "@/components/brand/logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { filterParamsOnly } from "@/lib/analytics/filters";
import { cn } from "@/lib/utils";

export type NavLinkItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Read after the visible label, so a link inside a group has a unique accessible name. */
  srSuffix?: string;
  /** Extra words the ⌘K palette matches. */
  keywords?: string;
};
export type NavGroupItem = { label: string; icon: LucideIcon; children: readonly NavLinkItem[] };
export type NavEntry = NavLinkItem | NavGroupItem;
export type NavSection = { label?: string; items: readonly NavEntry[] };

/** Real routes only. Every role sees every page; actions are gated on the pages themselves. */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard, keywords: "home dashboard kpi spend" },
      // The unified inbox (ADR 0018): every channel's conversations.
      { href: "/inbox", label: "Inbox", icon: Inbox, keywords: "conversations messages" },
    ],
  },
  {
    label: "Analytics",
    items: [
      { href: "/campaigns", label: "Campaigns", icon: Megaphone, keywords: "ads paid" },
      { href: "/breakdowns", label: "Breakdowns", icon: Layers, keywords: "platform split" },
      { href: "/conversions", label: "Conversions", icon: Target, keywords: "goals results" },
      { href: "/accounts", label: "Accounts", icon: Wallet, keywords: "ad accounts" },
      // Phase 10: organic Instagram and YouTube, separate from the paid pages above.
      {
        href: "/social",
        label: "Organic",
        icon: Camera,
        keywords: "social posts instagram youtube videos",
      },
    ],
  },
  {
    label: "Messaging",
    items: [
      // WhatsApp (ADR 0013) and Instagram direct messages (ADR 0017): the channel inboxes.
      { href: "/whatsapp", label: "WhatsApp", icon: MessageCircle, keywords: "inbox chats" },
      { href: "/instagram/messages", label: "Instagram DMs", icon: Send, keywords: "inbox direct" },
      {
        href: "/inbox/saved-replies",
        label: "Saved replies",
        icon: MessageSquareText,
        keywords: "canned responses snippets",
      },
      {
        label: "Templates",
        icon: LayoutTemplate,
        children: [
          {
            href: "/whatsapp/templates",
            label: "WhatsApp",
            srSuffix: "templates",
            icon: MessageCircle,
            keywords: "message templates",
          },
          {
            href: "/instagram/messages/templates",
            label: "Instagram",
            srSuffix: "templates",
            icon: Send,
            keywords: "message templates buttons cards",
          },
        ],
      },
    ],
  },
];

/** Pinned to the bottom of the sidebar. */
export const NAV_FOOTER: readonly NavEntry[] = [
  // Ad, organic and messaging channel connections (connect, choose the account, follow its sync).
  {
    href: "/connections",
    label: "Connections",
    icon: Plug,
    keywords: "channels integrations google meta youtube instagram connect",
  },
  {
    label: "Settings",
    icon: Settings,
    children: [
      // /whatsapp/settings connects a number (ADR 0014); the Instagram one turns DMs on.
      {
        href: "/whatsapp/settings",
        label: "WhatsApp",
        srSuffix: "settings",
        icon: MessageCircle,
        keywords: "phone number connect",
      },
      {
        href: "/instagram/messages/settings",
        label: "Instagram",
        srSuffix: "DM settings",
        icon: Send,
        keywords: "messaging ice breakers",
      },
      // Standalone SaaS: members, invitations and roles (Clerk organization profile, D9).
      {
        href: "/organization",
        label: "Organization",
        icon: Building2,
        keywords: "members team invitations roles workspace",
      },
    ],
  },
];

export function isGroup(entry: NavEntry): entry is NavGroupItem {
  return "children" in entry;
}

export type FlatNavLink = NavLinkItem & {
  /** The section ("Analytics") or the footer ("Setup"); "General" for the top items. */
  section: string;
  /** The group a link sits in ("Templates"), if any. */
  parent?: NavGroupItem;
  /** The label plus its suffix: "WhatsApp templates". */
  name: string;
};

function flatten(entries: readonly NavEntry[], section: string): FlatNavLink[] {
  return entries.flatMap((entry) =>
    isGroup(entry)
      ? entry.children.map((child) => ({ ...child, section, parent: entry, name: fullName(child) }))
      : [{ ...entry, section, name: fullName(entry) }],
  );
}

function fullName(item: NavLinkItem): string {
  return item.srSuffix ? `${item.label} ${item.srSuffix}` : item.label;
}

/** Every link in navigation order, for the palette, the dock and the page trail. */
export const NAV_LINKS: readonly FlatNavLink[] = [
  ...NAV_SECTIONS.flatMap((section) => flatten(section.items, section.label ?? "General")),
  ...flatten(NAV_FOOTER, "Setup"),
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The one link that is current: the longest matching href, so `/inbox/saved-replies` marks
 * "Saved replies" and not "Inbox", and `/campaigns/123` still marks "Campaigns".
 */
export function activeHref(pathname: string): string | undefined {
  let best: string | undefined;
  for (const link of NAV_LINKS) {
    if (isActive(pathname, link.href) && (best === undefined || link.href.length > best.length)) {
      best = link.href;
    }
  }
  return best;
}

/** Where the page sits in the navigation: ["Analytics", "Campaigns"], ["Templates", "WhatsApp"]. */
export function navTrail(pathname: string): string[] {
  const href = activeHref(pathname);
  const link = NAV_LINKS.find((l) => l.href === href);
  if (!link) return [];
  if (link.parent) return [link.parent.label, link.label];
  if (link.section === "General" || link.section === "Setup") return [link.label];
  return [link.section, link.label];
}

/** The global filters of the current URL (not page params), carried along on every link. */
export function useNavQuery(): string {
  const searchParams = useSearchParams();
  return filterParamsOnly(new URLSearchParams(searchParams.toString())).toString();
}

export function withQuery(href: string, query: string): string {
  return query ? `${href}?${query}` : href;
}

const ITEM =
  "group/item flex h-8 items-center gap-2.5 rounded-[8px] px-2.5 text-sm font-medium transition-[background-color,color,box-shadow] duration-150";
const ITEM_IDLE = "text-ink-2 hover:bg-canvas-2 hover:text-ink";
const ITEM_CURRENT =
  "bg-paper text-ink shadow-[0_0_0_1px_var(--color-line),0_1px_2px_rgb(15_17_21/0.05)]";
const RAIL_ITEM = "size-10 justify-center px-0";

function ItemIcon({ icon: Icon, current }: { icon: LucideIcon; current: boolean }) {
  return (
    <Icon
      className={cn(
        "size-4 shrink-0",
        current ? "text-blue-deep" : "text-muted-foreground group-hover/item:text-ink-2",
      )}
      aria-hidden="true"
    />
  );
}

function ItemLabel({ item, hidden }: { item: NavLinkItem; hidden?: boolean }) {
  return (
    <span className={cn("min-w-0 flex-1 truncate", hidden && "sr-only")}>
      {item.label}
      {item.srSuffix && (
        <>
          {" "}
          <span className="sr-only">{item.srSuffix}</span>
        </>
      )}
    </span>
  );
}

/** A tooltip with the label, for the icon-only rail. */
function RailTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={10}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

type ItemProps = {
  current: string | undefined;
  query: string;
  collapsed: boolean;
  onNavigate?: () => void;
};

function NavLinkRow({
  item,
  nested,
  current,
  query,
  collapsed,
  onNavigate,
}: ItemProps & { item: NavLinkItem; nested?: boolean }) {
  const isCurrent = current === item.href;
  const link = (
    <Link
      href={withQuery(item.href, query)}
      aria-current={isCurrent ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        ITEM,
        nested && "h-7 pl-9 text-[13px]",
        collapsed && RAIL_ITEM,
        isCurrent ? ITEM_CURRENT : ITEM_IDLE,
      )}
    >
      {!nested && <ItemIcon icon={item.icon} current={isCurrent} />}
      <ItemLabel item={item} hidden={collapsed} />
    </Link>
  );
  return collapsed ? <RailTip label={item.label}>{link}</RailTip> : link;
}

/** A disclosure ("Templates", "Settings"): open while one of its pages is current. */
function NavGroupRow({ group, ...props }: ItemProps & { group: NavGroupItem }) {
  const { current, query, collapsed, onNavigate } = props;
  const id = useId();
  const holdsCurrent = group.children.some((child) => child.href === current);
  const [toggled, setToggled] = useState<boolean | null>(null);
  // Arriving on one of its pages opens the group again, even if it was closed by hand.
  const [lastHoldsCurrent, setLastHoldsCurrent] = useState(holdsCurrent);
  if (lastHoldsCurrent !== holdsCurrent) {
    setLastHoldsCurrent(holdsCurrent);
    setToggled(null);
  }
  const open = toggled ?? holdsCurrent;

  if (collapsed) {
    return (
      <DropdownMenu>
        <RailTip label={group.label}>
          <DropdownMenuTrigger
            className={cn(ITEM, RAIL_ITEM, holdsCurrent ? ITEM_CURRENT : ITEM_IDLE)}
            aria-label={group.label}
          >
            <ItemIcon icon={group.icon} current={holdsCurrent} />
          </DropdownMenuTrigger>
        </RailTip>
        <DropdownMenuContent side="right" align="start" sideOffset={10} className="min-w-48">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {group.label}
          </DropdownMenuLabel>
          {group.children.map((child) => (
            <DropdownMenuItem key={child.href} asChild>
              <Link
                href={withQuery(child.href, query)}
                aria-current={current === child.href ? "page" : undefined}
                onClick={onNavigate}
              >
                <child.icon aria-hidden="true" />
                <ItemLabel item={child} />
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setToggled(!open)}
        className={cn(ITEM, "w-full", ITEM_IDLE)}
      >
        <ItemIcon icon={group.icon} current={holdsCurrent && !open} />
        <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      <ul id={id} hidden={!open} className="mt-0.5 flex flex-col gap-0.5">
        {group.children.map((child) => (
          <li key={child.href}>
            <NavLinkRow item={child} nested {...props} />
          </li>
        ))}
      </ul>
    </>
  );
}

function NavList({ entries, ...props }: ItemProps & { entries: readonly NavEntry[] }) {
  return (
    <ul className={cn("flex flex-col gap-0.5", props.collapsed && "items-center")}>
      {entries.map((entry) => (
        <li key={entry.label}>
          {isGroup(entry) ? (
            <NavGroupRow group={entry} {...props} />
          ) : (
            <NavLinkRow item={entry} {...props} />
          )}
        </li>
      ))}
    </ul>
  );
}

function NavSectionBlock({ section, ...props }: ItemProps & { section: NavSection }) {
  const id = useId();
  if (!section.label) return <NavList entries={section.items} {...props} />;
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1">
      {props.collapsed && (
        <div aria-hidden="true" className="mx-auto my-1 h-px w-6 bg-line-strong" />
      )}
      <p
        id={id}
        className={cn(
          "px-2.5 pt-3 text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase",
          props.collapsed && "sr-only",
        )}
      >
        {section.label}
      </p>
      <NavList entries={section.items} {...props} />
    </div>
  );
}

/**
 * Primary navigation, grouped (Analytics, Messaging) with Connections and Settings pinned at
 * the bottom. `collapsed` draws the 64 px icon rail. Links carry the global filters along.
 */
export function DashboardNav({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const props: ItemProps = {
    current: activeHref(pathname),
    query: useNavQuery(),
    collapsed,
    onNavigate,
  };
  return (
    <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-2">
        {NAV_SECTIONS.map((section, i) => (
          <NavSectionBlock key={section.label ?? i} section={section} {...props} />
        ))}
      </div>
      <div className="border-t border-line px-3 py-2">
        <NavList entries={NAV_FOOTER} {...props} />
      </div>
    </nav>
  );
}

/** "Gudz Marketing": the Gudz wordmark in the logo blue, then the product name. */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <Logo
        width={undefined}
        height={undefined}
        className={cn("w-auto", compact ? "h-[11px]" : "h-[18px]")}
        aria-hidden="true"
      />
      <span className="sr-only">Gudz</span>
      <span
        className={cn("text-[15px] font-medium tracking-[-0.01em] text-ink", compact && "sr-only")}
      >
        Marketing
      </span>
    </span>
  );
}
