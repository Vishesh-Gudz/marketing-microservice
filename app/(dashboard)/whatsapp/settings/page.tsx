import type { Metadata } from "next";
import { WhatsAppView } from "@/components/dashboard/views/whatsapp-view";

export const metadata: Metadata = { title: "WhatsApp settings" };

export default function WhatsAppSettingsPage() {
  return <WhatsAppView />;
}
