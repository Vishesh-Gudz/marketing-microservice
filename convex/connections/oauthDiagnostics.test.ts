import { describe, expect, it } from "vitest";
import { sanitizeOAuthDiagnostics } from "./oauthDiagnostics";

// D28b: only allowlisted failureKind / failureStage / providerCode values survive.

describe("sanitizeOAuthDiagnostics (D28b allowlist)", () => {
  it("keeps allowlisted kind, stage and numeric or internal codes", () => {
    expect(
      sanitizeOAuthDiagnostics({ kind: "auth", providerCode: "code_exchange:100/36009" }),
    ).toEqual({
      failureKind: { from: null, to: "auth" },
      failureStage: { from: null, to: "code_exchange" },
      providerCode: { from: null, to: "100/36009" },
    });
    expect(
      sanitizeOAuthDiagnostics({ kind: "auth", providerCode: "debug_token:app_id_mismatch" }),
    ).toMatchObject({
      providerCode: { to: "app_id_mismatch" },
    });
    expect(
      sanitizeOAuthDiagnostics({ kind: "unknown", providerCode: "config:meta_config_invalid" }),
    ).toMatchObject({
      failureStage: { to: "config" },
      providerCode: { to: "meta_config_invalid" },
    });
    expect(
      sanitizeOAuthDiagnostics({ kind: "unknown", providerCode: "config:provider_mode_invalid" }),
    ).toMatchObject({
      providerCode: { to: "provider_mode_invalid" },
    });
  });

  it("keeps the stage but drops non-allowlisted codes (transport markers, free text)", () => {
    expect(
      sanitizeOAuthDiagnostics({ kind: "transient", providerCode: "debug_token:network" }),
    ).toEqual({
      failureKind: { from: null, to: "transient" },
      failureStage: { from: null, to: "debug_token" },
    });
    expect(
      sanitizeOAuthDiagnostics({ kind: "data", providerCode: "identity:user_mismatch" }),
    ).toEqual({
      failureKind: { from: null, to: "data" },
      failureStage: { from: null, to: "identity" },
    });
  });

  it.each([
    [{ kind: "EAAB-token-like-value" }],
    [{ kind: "auth; drop table" }],
    [{ providerCode: "https://graph.facebook.com/v26.0/oauth/access_token?code=abc" }],
    [{ providerCode: "code_exchange:test-long-u1" }],
    [{ providerCode: "code_exchange:Error validating verification code" }],
    [{ providerCode: "unknown_stage:190" }],
    [{ providerCode: "190" }],
    [{ providerCode: "code_exchange:1234567/1" }],
    [{ providerCode: "mock" }],
    [{ providerCode: `code_exchange:${"9".repeat(70)}` }],
  ])("drops %j entirely or keeps only safe parts", (input) => {
    const out = sanitizeOAuthDiagnostics(input);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(
      /EAAB|drop table|https?:|test-long|Error validating|unknown_stage|mock/,
    );
    expect(out).not.toHaveProperty("providerCode");
  });

  it("returns nothing for missing diagnostics", () => {
    expect(sanitizeOAuthDiagnostics(undefined)).toEqual({});
    expect(sanitizeOAuthDiagnostics({})).toEqual({});
  });
});
