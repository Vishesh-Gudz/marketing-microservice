"use client";

import { BookmarkPlus, Inbox } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType, type ReactNode } from "react";
import { ChannelLogo, InstagramLogo, WhatsAppLogo } from "@/components/brand/channel-logo";
import { cn } from "@/lib/utils";
import { InboxView } from "../views/inbox-view";
import { InstagramInboxView } from "../views/instagram-inbox-view";
import { WhatsAppInboxView } from "../views/whatsapp-inbox-view";

// The inbox workspace (Kinso K2): an app rail, the conversation list and the open conversation
// side by side. It is the layout of /inbox, /whatsapp, /instagram/messages and both
// conversation routes (app/(dashboard)/(inbox)), so the list stays on screen and keeps its place
// while conversations open beside it. URLs are unchanged.

type ListSource = "inbox" | "whatsapp" | "instagram";

const LISTS: readonly {
  source: ListSource;
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { source: "inbox", href: "/inbox", label: "All", icon: Inbox },
  { source: "whatsapp", href: "/whatsapp", label: "WhatsApp", icon: WhatsAppLogo },
  { source: "instagram", href: "/instagram/messages", label: "Instagram", icon: InstagramLogo },
];

/** Which list a path shows, or which channel's conversation it opens. */
function routeOf(pathname: string): { list?: ListSource; channel?: "whatsapp" | "instagram" } {
  if (pathname === "/inbox") return { list: "inbox" };
  if (pathname === "/whatsapp") return { list: "whatsapp" };
  if (pathname === "/instagram/messages") return { list: "instagram" };
  if (pathname.startsWith("/whatsapp/conversations/")) return { channel: "whatsapp" };
  if (pathname.startsWith("/instagram/messages/conversations/")) return { channel: "instagram" };
  return {};
}

/** The rail at the far left (≥1280 px): the three lists as large logos, then saved replies. */
function AppRail({ source }: { source: ListSource }) {
  return (
    <nav
      aria-label="Inbox lists"
      className="hidden flex-col items-center gap-1 border-r border-line bg-canvas py-4 xl:flex"
    >
      {LISTS.map(({ source: item, href, label, icon: Icon }) => {
        const active = item === source;
        return (
          <Link
            key={item}
            href={href}
            aria-current={active ? "page" : undefined}
            className="group flex w-16 flex-col items-center gap-1 rounded-[12px] py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-[current=page]:text-ink"
          >
            <span
              className={cn(
                "grid size-10 place-items-center rounded-[12px] transition-[background-color,box-shadow,transform] duration-200 group-active:scale-[0.97]",
                active ? "bg-paper shadow-soft ring-1 ring-line" : "group-hover:bg-paper/70",
              )}
            >
              <Icon className={cn("size-5", item === "inbox" && "text-ink-2")} />
            </span>
            {label}
          </Link>
        );
      })}
      <span aria-hidden="true" className="my-2 h-px w-8 bg-line" />
      <Link
        href="/inbox/saved-replies"
        className="group flex w-16 flex-col items-center gap-1 rounded-[12px] py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="grid size-10 place-items-center rounded-[12px] transition-colors group-hover:bg-paper/70">
          <BookmarkPlus className="size-5 text-ink-2" />
        </span>
        Saved
      </Link>
    </nav>
  );
}

/** Below 1280 px the rail is a row of chips above the list. */
function ListChips({ source }: { source: ListSource }) {
  return (
    <nav aria-label="Inbox lists" className="px-3 pt-1 pb-3 xl:hidden">
      <ul className="inline-flex max-w-full gap-0.5 rounded-[10px] border border-line bg-canvas p-0.5">
        {LISTS.map(({ source: item, href, label, icon: Icon }) => (
          <li key={item}>
            <Link
              href={href}
              aria-current={item === source ? "page" : undefined}
              className="inline-flex h-8 items-center gap-1.5 rounded-[8px] px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-[current=page]:bg-paper aria-[current=page]:text-ink aria-[current=page]:shadow-soft"
            >
              <Icon className={cn("size-3.5", item === "inbox" && "text-ink-2")} />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function InboxWorkspace({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const route = routeOf(pathname);
  const conversationOpen = route.list === undefined;
  // The list stays the one you came from: opening a WhatsApp conversation from the unified
  // inbox keeps the unified list; a conversation opened directly shows its channel's list.
  const [source, setSource] = useState<ListSource>(route.list ?? route.channel ?? "inbox");
  if (route.list !== undefined && route.list !== source) setSource(route.list);
  const headingLevel = conversationOpen ? 2 : 1;

  return (
    <div
      data-inbox-workspace=""
      className="flex flex-col lg:grid lg:h-[calc(100dvh-3.5rem)] lg:grid-cols-[21rem_minmax(0,1fr)] xl:grid-cols-[5rem_22rem_minmax(0,1fr)]"
    >
      <AppRail source={source} />
      <section
        aria-label="Conversation list"
        className={cn(
          "flex min-h-0 flex-col bg-canvas/60 pt-4 lg:border-r lg:border-line",
          conversationOpen && "hidden lg:flex",
        )}
      >
        <ListChips source={source} />
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {source === "inbox" ? (
            <InboxView headingLevel={headingLevel} />
          ) : source === "whatsapp" ? (
            <WhatsAppInboxView headingLevel={headingLevel} />
          ) : (
            <InstagramInboxView headingLevel={headingLevel} />
          )}
        </div>
      </section>
      <div
        className={cn(
          "@container min-h-0 min-w-0 bg-paper lg:overflow-y-auto",
          !conversationOpen && "hidden lg:block",
        )}
      >
        <div className="p-4 md:p-6">{children}</div>
      </div>
    </div>
  );
}

/** The pane on a list page, before a conversation is chosen. */
export function NoConversationOpen() {
  return (
    <div className="flex min-h-[24rem] flex-col items-center justify-center gap-4 text-center lg:h-[calc(100dvh-3.5rem-3rem)]">
      <div aria-hidden="true" className="flex items-center -space-x-2">
        <span className="grid size-12 place-items-center rounded-[14px] bg-paper shadow-soft ring-1 ring-line">
          <ChannelLogo channel="whatsapp" className="size-6" />
        </span>
        <span className="grid size-12 place-items-center rounded-[14px] bg-paper shadow-soft ring-1 ring-line">
          <ChannelLogo channel="instagram" className="size-6" />
        </span>
      </div>
      <div className="flex max-w-xs flex-col gap-1">
        <h2 className="text-[15px] font-medium text-ink">Choose a conversation</h2>
        <p className="text-sm text-muted-foreground">
          Pick one from the list to read it and reply, without leaving your inbox.
        </p>
      </div>
    </div>
  );
}
