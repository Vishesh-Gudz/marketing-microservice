import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { OAUTH_CALLBACK_PATH } from "./connections/config";
import { handleOAuthCallback } from "./connections/oauthFlow";
import { WHATSAPP_WEBHOOK_PATH } from "./whatsapp/config";
import { handleWebhookDelivery, handleWebhookVerification } from "./whatsapp/webhook";

// HTTP routes exist only where a platform requires a URL. Phase 4: OAuth callback.
// WhatsApp inbox (ADR 0013): Meta webhook verification (GET) and signed deliveries (POST).
const http = httpRouter();

http.route({
  path: OAUTH_CALLBACK_PATH,
  method: "GET",
  handler: httpAction(async (ctx, request) => await handleOAuthCallback(ctx, request)),
});

http.route({
  path: WHATSAPP_WEBHOOK_PATH,
  method: "GET",
  handler: httpAction(async (_ctx, request) => await handleWebhookVerification(request)),
});

http.route({
  path: WHATSAPP_WEBHOOK_PATH,
  method: "POST",
  handler: httpAction(async (ctx, request) => await handleWebhookDelivery(ctx, request)),
});

export default http;
