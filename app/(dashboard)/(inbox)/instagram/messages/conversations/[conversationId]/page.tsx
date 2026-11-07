import type { Metadata } from "next";
import { InstagramConversationView } from "@/components/dashboard/views/instagram-conversation-view";

export const metadata: Metadata = { title: "Instagram conversation" };

// Ownership is checked by the API (v1/instagramMessaging:getConversation); the id is passed
// through untouched and an unknown or another org's id renders "Not found".
export default async function InstagramConversationPage({
  params,
}: PageProps<"/instagram/messages/conversations/[conversationId]">) {
  const { conversationId } = await params;
  return <InstagramConversationView conversationId={conversationId} />;
}
