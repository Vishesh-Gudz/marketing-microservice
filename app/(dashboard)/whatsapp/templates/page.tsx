import type { Metadata } from "next";
import { WhatsAppTemplatesView } from "@/components/dashboard/views/whatsapp-templates-view";

export const metadata: Metadata = { title: "WhatsApp templates" };

export default function WhatsAppTemplatesPage() {
  return <WhatsAppTemplatesView />;
}
