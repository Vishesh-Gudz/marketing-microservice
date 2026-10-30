import type { Metadata } from "next";
import { InstagramMessagingSettingsView } from "@/components/dashboard/views/instagram-messaging-settings-view";

export const metadata: Metadata = { title: "Instagram DM settings" };

export default function InstagramMessagingSettingsPage() {
  return <InstagramMessagingSettingsView />;
}
