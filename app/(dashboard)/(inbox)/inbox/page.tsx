import type { Metadata } from "next";
import { NoConversationOpen } from "@/components/dashboard/messaging/workspace";

export const metadata: Metadata = { title: "Inbox" };

// The list is the workspace's (app/(dashboard)/(inbox)/layout.tsx); this page is the pane beside
// it before a conversation is chosen.
export default function InboxPage() {
  return <NoConversationOpen />;
}
