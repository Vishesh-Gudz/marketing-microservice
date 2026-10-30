import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { OAUTH_CALLBACK_PATH } from "./connections/config";
import { handleOAuthCallback } from "./connections/oauthFlow";
import {
  handleDataDeletion as handleInstagramDataDeletion,
  handleDeauthorize as handleInstagramDeauthorize,
  handleDeletionStatus as handleInstagramDeletionStatus,
} from "./instagram/dataDeletion/callbacks";
import {
  INSTAGRAM_DATA_DELETION_PATH,
  INSTAGRAM_DATA_DELETION_STATUS_PATH,
  INSTAGRAM_DEAUTHORIZE_PATH,
} from "./instagram/dataDeletion/config";
import { INSTAGRAM_WEBHOOK_PATH } from "./instagram/messaging/config";
import {
  handleWebhookDelivery as handleInstagramDelivery,
  handleWebhookVerification as handleInstagramVerification,
} from "./instagram/messaging/webhook";
import { WHATSAPP_WEBHOOK_PATH } from "./whatsapp/config";
import { handleWebhookDelivery, handleWebhookVerification } from "./whatsapp/webhook";

// HTTP routes exist only where a platform requires a URL. Phase 4: OAuth callback.
// WhatsApp inbox (ADR 0013): Meta webhook verification (GET) and signed deliveries (POST).
// Instagram messaging (ADR 0017): the same two routes for Instagram direct messages, and
// (IM6) the Instagram Login app's deauthorize and data-deletion callbacks with the status page.
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

http.route({
  path: INSTAGRAM_WEBHOOK_PATH,
  method: "GET",
  handler: httpAction(async (_ctx, request) => await handleInstagramVerification(request)),
});

http.route({
  path: INSTAGRAM_WEBHOOK_PATH,
  method: "POST",
  handler: httpAction(async (ctx, request) => await handleInstagramDelivery(ctx, request)),
});

http.route({
  path: INSTAGRAM_DEAUTHORIZE_PATH,
  method: "POST",
  handler: httpAction(async (ctx, request) => await handleInstagramDeauthorize(ctx, request)),
});

http.route({
  path: INSTAGRAM_DATA_DELETION_PATH,
  method: "POST",
  handler: httpAction(async (ctx, request) => await handleInstagramDataDeletion(ctx, request)),
});

http.route({
  path: INSTAGRAM_DATA_DELETION_STATUS_PATH,
  method: "GET",
  handler: httpAction(async (ctx, request) => await handleInstagramDeletionStatus(ctx, request)),
});

export default http;
