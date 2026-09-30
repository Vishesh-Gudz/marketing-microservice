import { describe, expect, it } from "vitest";
import { sanitizeOAuthDiagnostics } from "./oauthDiagnostics";

// Phase 10: the D28b allowlist extended for Instagram — stage token_refresh and an EXPLICIT
// list of Instagram internal codes; numeric Graph/OAuth codes pass as before. Everything
// else (tokens, URLs, messages, trace ids, transport markers) is dropped.

describe("sanitizeOAuthDiagnostics — Instagram stages and codes", () => {
  it.each([
    ["permission", "identity:account_type_unsupported"],
    ["data", "identity:identity_invalid"],
    ["unknown", "config:instagram_config_invalid"],
    ["auth", "token_exchange:400"],
    ["auth", "long_lived_exchange:190"],
    ["auth", "token_refresh:190"],
    ["auth", "token_refresh:credential_invalid"],
    ["invalid_request", "token_refresh:token_too_new"],
    ["unknown", "identity:transport_blocked"],
    ["unknown", "identity:request_budget_exceeded"],
  ])("keeps %s / %s", (kind, staged) => {
    const [stage, code] = staged.split(":");
    expect(sanitizeOAuthDiagnostics({ kind, providerCode: staged })).toEqual({
      failureKind: { from: null, to: kind },
      failureStage: { from: null, to: stage },
      providerCode: { from: null, to: code },
    });
  });

  it.each([
    "token_exchange:IGAAfaketoken0001",
    "long_lived_exchange:https://graph.instagram.com/access_token?client_secret=x",
    "identity:Matching code was not found",
    "token_refresh:FakeTraceIdNeverStored",
    "identity:instagram_mapping_pending",
  ])("never stores %s", (staged) => {
    const out = sanitizeOAuthDiagnostics({ kind: "auth", providerCode: staged });
    expect(out.providerCode).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/IGAA|https|secret|Matching|Trace/);
  });
});
