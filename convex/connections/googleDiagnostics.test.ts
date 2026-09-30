import { describe, expect, it } from "vitest";
import { sanitizeOAuthDiagnostics } from "./oauthDiagnostics";

// Phase 9 (G-D19): the D28b allowlist extended for Google — stages token_exchange, identity,
// api_access and config, and an EXPLICIT list of Google codes. Everything else is dropped.

describe("sanitizeOAuthDiagnostics — Google stages and codes", () => {
  it.each([
    ["auth", "token_exchange:invalid_grant"],
    ["unknown", "token_exchange:invalid_client"],
    ["auth", "token_exchange:no_refresh_token"],
    ["auth", "token_exchange:invalid_request"],
    ["auth", "api_access:NOT_ADS_USER"],
    ["unknown", "api_access:DEVELOPER_TOKEN_NOT_APPROVED"],
    ["unknown", "api_access:DEVELOPER_TOKEN_PROHIBITED"],
    ["unknown", "api_access:DEVELOPER_TOKEN_INVALID"],
    ["permission", "api_access:USER_PERMISSION_DENIED"],
    ["unknown", "config:google_config_invalid"],
  ])("keeps %s / %s", (kind, staged) => {
    const [stage, code] = staged.split(":");
    expect(sanitizeOAuthDiagnostics({ kind, providerCode: staged })).toEqual({
      failureKind: { from: null, to: kind },
      failureStage: { from: null, to: stage },
      providerCode: { from: null, to: code },
    });
  });

  it.each([
    "identity:http_503",
    "token_exchange:network",
    "token_exchange:timeout",
    "token_exchange:invalid_scope",
    "api_access:RESOURCE_EXHAUSTED",
    "api_access:fakeRequestId000000001",
    "identity:schema",
  ])("keeps the stage but drops the non-allowlisted code of %s", (staged) => {
    expect(sanitizeOAuthDiagnostics({ kind: "transient", providerCode: staged })).toEqual({
      failureKind: { from: null, to: "transient" },
      failureStage: { from: null, to: staged.split(":")[0] },
    });
  });

  it.each([
    "token_exchange:someone@example.com",
    "token_exchange:ya29.a0AfH6SMBexample",
    "token_exchange:https://oauth2.googleapis.com/token",
    "userinfo:invalid_grant",
    "invalid_grant",
    "token_exchange:invalid_grant extra text",
  ])("drops stage and code of %s entirely", (staged) => {
    expect(sanitizeOAuthDiagnostics({ kind: "auth", providerCode: staged })).toEqual({
      failureKind: { from: null, to: "auth" },
    });
  });
});
