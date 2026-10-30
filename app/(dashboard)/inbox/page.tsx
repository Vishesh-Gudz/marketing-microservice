import type { Metadata } from "next";
import { InboxView } from "@/components/dashboard/views/inbox-view";

export const metadata: Metadata = { title: "Inbox" };

export default function InboxPage() {
  return <InboxView />;
}
