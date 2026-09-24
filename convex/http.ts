import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { OAUTH_CALLBACK_PATH } from "./connections/config";
import { handleOAuthCallback } from "./connections/oauthFlow";

// HTTP routes exist only where a platform requires a URL. Phase 4: OAuth callback.
const http = httpRouter();

http.route({
  path: OAUTH_CALLBACK_PATH,
  method: "GET",
  handler: httpAction(async (ctx, request) => await handleOAuthCallback(ctx, request)),
});

export default http;
