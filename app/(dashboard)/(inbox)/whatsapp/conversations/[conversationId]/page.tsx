import type { Metadata } from "next";
import { WhatsAppConversationView } from "@/components/dashboard/views/whatsapp-conversation-view";

export const metadata: Metadata = { title: "WhatsApp conversation" };

// Ownership is checked by the API (v1/whatsapp:getConversation); the id is passed through
// untouched and an unknown or another org's id renders "Not found".
export default async function WhatsAppConversationPage({
  params,
}: PageProps<"/whatsapp/conversations/[conversationId]">) {
  const { conversationId } = await params;
  return <WhatsAppConversationView conversationId={conversationId} />;
}
