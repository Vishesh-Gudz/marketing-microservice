import type { Metadata } from "next";
import { WhatsAppInboxView } from "@/components/dashboard/views/whatsapp-inbox-view";

export const metadata: Metadata = { title: "WhatsApp" };

export default function WhatsAppPage() {
  return <WhatsAppInboxView />;
}
