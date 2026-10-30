import type { Metadata } from "next";
import { InstagramInboxView } from "@/components/dashboard/views/instagram-inbox-view";

export const metadata: Metadata = { title: "Instagram DMs" };

export default function InstagramMessagesPage() {
  return <InstagramInboxView />;
}
