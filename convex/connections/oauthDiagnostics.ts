import { PROVIDER_ERROR_KINDS } from "../providers/errors";
import type { AuditChanges } from "../lib/validation";

/**
 * Sanitized OAuth-failure diagnostics (Phase 8, D28b). ONLY these audit keys and
 * values may ever be stored on the existing `connection.oauth_failed` entry:
 *
 *   failureKind   a ProviderError kind
 *   failureStage  code_exchange | long_lived_exchange | debug_token | identity | config
 *                 (Meta) and token_exchange | identity | api_access | config (Google)
 *   providerCode  a Meta numeric code, optionally with a subcode ("190", "100/36009"),
 *                 one internal constant (INTERNAL_CODES) or one allowlisted Google code
 *                 (GOOGLE_CODES)
 *
 * Input comes from a ProviderError's `kind` and `providerCode` ("<stage>:<code>").
 * Anything that does not match exactly is DROPPED, never stored. Tokens, codes,
 * states, secrets, URLs, response bodies, error messages and provider payloads
 * never reach this function's output.
 */

export const OAUTH_FAILURE_STAGES = [
  "code_exchange",
  "long_lived_exchange",
  "debug_token",
  "identity",
  "config",
  // Google Ads (Phase 9, G-D19)
  "token_exchange",
  "api_access",
] as const;

const INTERNAL_CODES: ReadonlySet<string> = new Set([
  "app_id_mismatch",
  "meta_config_invalid",
  "provider_mode_missing",
  "provider_mode_invalid",
]);

/**
 * Google Ads codes (Phase 9, G-D19): an EXPLICIT allowlist of OAuth error codes, Google Ads
 * error enums and internal constants. Anything else (free text, request ids, emails, …) is
 * dropped.
 */
const GOOGLE_CODES: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_client",
  "invalid_request",
  "redirect_uri_mismatch",
  "unauthorized_client",
  "access_denied",
  "no_refresh_token",
  "client_id_mismatch",
  "NOT_ADS_USER",
  "DEVELOPER_TOKEN_NOT_APPROVED",
  "DEVELOPER_TOKEN_PROHIBITED",
  "DEVELOPER_TOKEN_INVALID",
  "USER_PERMISSION_DENIED",
  "CUSTOMER_NOT_ENABLED",
  "google_config_invalid",
]);

const NUMERIC_CODE = /^\d{1,6}(\/\d{1,9})?$/;
const STAGED = /^([a-z_]{1,32}):([A-Za-z0-9_/]{1,64})$/;

export type OAuthFailureDiagnostics = { kind?: string; providerCode?: string };

export function sanitizeOAuthDiagnostics(input: OAuthFailureDiagnostics | undefined): AuditChanges {
  const changes: AuditChanges = {};
  if (input === undefined) return changes;

  if (
    input.kind !== undefined &&
    (PROVIDER_ERROR_KINDS as readonly string[]).includes(input.kind)
  ) {
    changes.failureKind = { from: null, to: input.kind };
  }

  const staged = input.providerCode !== undefined ? STAGED.exec(input.providerCode) : null;
  if (staged !== null) {
    const [, stage, code] = staged as unknown as [string, string, string];
    if ((OAUTH_FAILURE_STAGES as readonly string[]).includes(stage)) {
      changes.failureStage = { from: null, to: stage };
      if (NUMERIC_CODE.test(code) || INTERNAL_CODES.has(code) || GOOGLE_CODES.has(code)) {
        changes.providerCode = { from: null, to: code };
      }
    }
  }
  return changes;
}
