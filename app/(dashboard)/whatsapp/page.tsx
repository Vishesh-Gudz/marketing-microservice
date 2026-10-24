import type { Metadata } from "next";
import { WhatsAppView } from "@/components/dashboard/views/whatsapp-view";

export const metadata: Metadata = { title: "WhatsApp" };

export default function WhatsAppPage() {
  return <WhatsAppView />;
}
