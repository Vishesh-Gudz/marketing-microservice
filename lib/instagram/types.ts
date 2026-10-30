import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

// Instagram direct messages (ADR 0017), derived from the PUBLIC v1 API only (type-only imports,
// D23): the dashboard never imports the server's DTO modules.

type InstagramMessaging = typeof api.v1.instagramMessaging;

export type InstagramConversation = FunctionReturnType<InstagramMessaging["getConversation"]>;
export type InstagramMessage = FunctionReturnType<
  InstagramMessaging["listMessages"]
>["page"][number];
export type MessageStatus = InstagramMessage["status"];
export type MessageType = InstagramMessage["type"];
export type ReplyBlocker = NonNullable<InstagramConversation["replyBlocker"]>;
export type MessagingAvailability = FunctionReturnType<InstagramMessaging["getAvailability"]>;
export type AvailabilityState = MessagingAvailability["availability"];
export type SetupResult = FunctionReturnType<InstagramMessaging["enable"]>;
