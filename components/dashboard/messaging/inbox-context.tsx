"use client";

import { createContext, useContext } from "react";

// Which conversation list the inbox workspace shows (Kinso K2), shared with the open
// conversation so its back arrow returns to that list (D-M12, Kinso K3).

export type ListSource = "inbox" | "whatsapp" | "instagram";

/** Each list's page and the name it goes by in a back link. */
export const LIST_PAGES: Readonly<Record<ListSource, { href: string; label: string }>> = {
  inbox: { href: "/inbox", label: "Inbox" },
  whatsapp: { href: "/whatsapp", label: "WhatsApp" },
  instagram: { href: "/instagram/messages", label: "Instagram DMs" },
};

/** The workspace's current list; null outside the workspace. */
export const InboxListContext = createContext<ListSource | null>(null);

/**
 * Where a conversation's back arrow goes: the list it was opened from (the unified inbox stays
 * the unified inbox), else its own channel's list.
 */
export function useBackToList(channel: "whatsapp" | "instagram"): { href: string; label: string } {
  return LIST_PAGES[useContext(InboxListContext) ?? channel];
}
