import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  CredentialUnavailableError,
  encryptCredential,
  withConnectionCredential,
} from "../connections/credentialStore";
import { apiError } from "../lib/errors";
import type { Tenant } from "../lib/tenancy";
import {
  signupAppConfig,
  TOKEN_AUTH_ERROR_CODES,
  WHATSAPP_SCOPES,
  whatsappConnectionsEnabled,
  type SignupAppConfig,
} from "./config";
import {
  exchangeSignupCode,
  inspectToken,
  isSuccess,
  listWabaNumbers,
  readWaba,
  registerPhoneNumber,
  subscribeApp,
  type GraphFailure,
  type GraphOutcome,
} from "./graph";
import { setupProgress, type SetupProgress } from "./accounts";
import { isNumericId } from "./payload";

/**
 * WhatsApp Embedded Signup, server side (ADR 0014, B2).
 *
 * The browser runs Meta's Embedded Signup (FB.login with our login configuration) and hands
 * over three values: the 30-second `code`, and the `waba_id` / `phone_number_id` from Meta's
 * WA_EMBEDDED_SIGNUP message. None of them is trusted:
 *
 * 1. The code is exchanged here for the customer's business token (never stored raw, never
 *    logged, never returned).
 * 2. The token is inspected with our app token: it must be valid, issued to OUR app, carry both
 *    WhatsApp permissions, and list the WABA among the WABAs the customer shared with us
 *    (`granular_scopes` of whatsapp_business_management).
 * 3. The WABA is read with that token, and the number must be one of the WABA's numbers.
 * 4. Only then is anything stored: the token and the registration PIN, encrypted for
 *    (org, "whatsapp", WABA), the connection and account, and the number's routing to this
 *    org. Refused first: another org's WABA or number, and a number this org has from the
 *    operator path (its two-step PIN at Meta is not ours). A PIN already stored for the WABA
 *    is kept, never replaced.
 * 5. Then Meta's remaining steps, in their documented order: subscribe our app to the WABA's
 *    webhooks, register the number for Cloud API. A failure here leaves the account
 *    `action_required` with a sanitized reason; `retrySetup` resumes only the missing steps.
 *    A refused token moves the connection to needs_reauth (`reauthorization_required`).
 *
 * The org and the actor always come from the caller's verified JWT (the `tenant`).
 */

const CODE_PATTERN = /^[\x21-\x7e]{1,4096}$/;
const PIN_SPACE = 1_000_000;

export type SetupResult = SetupProgress & {
  accountId: Id<"whatsappBusinessAccounts">;
  /** Sanitized reason code of the latest failed step (action / reauthorization required). */
  reason?: string;
};

type WhatsAppCredential = { kind: "whatsapp"; v: 1; accessToken: string; pin: string };

function parseCredential(value: unknown): WhatsAppCredential | null {
  const c = value as Partial<WhatsAppCredential> | null;
  if (c === null || typeof c !== "object" || c.kind !== "whatsapp" || c.v !== 1) return null;
  if (typeof c.accessToken !== "string" || c.accessToken === "") return null;
  if (typeof c.pin !== "string" || !/^\d{6}$/.test(c.pin)) return null;
  return { kind: "whatsapp", v: 1, accessToken: c.accessToken, pin: c.pin };
}

/** A uniformly random 6-digit PIN (rejection sampling; never derived from anything). */
function generatePin(): string {
  const buffer = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / PIN_SPACE) * PIN_SPACE;
  do crypto.getRandomValues(buffer);
  while (buffer[0]! >= limit);
  return String(buffer[0]! % PIN_SPACE).padStart(6, "0");
}

/** Sanitized reason code for a failed Meta call: kinds and numbers only, never text. */
export function failureReason(failure: GraphFailure): string {
  if (failure.kind !== "http") return failure.kind;
  if (failure.metaCode !== undefined) return `meta_${failure.metaCode}`;
  return `http_${failure.status ?? 0}`;
}

function retryable(failure: GraphFailure): boolean {
  return failure.kind !== "http" || (failure.status ?? 0) >= 500;
}

/** A Meta call failed before anything was stored: nothing to undo, the user can start over. */
function providerError(stage: string, failure: GraphFailure) {
  return apiError("PROVIDER_ERROR", "Meta could not complete this step. Please try again.", {
    stage,
    reason: failureReason(failure),
    retryable: retryable(failure),
  });
}

function refused(reason: string, message: string) {
  return apiError("INVALID_ARGUMENT", message, { reason });
}

function requireOpen(): SignupAppConfig {
  if (!whatsappConnectionsEnabled()) {
    throw apiError("INVALID_ARGUMENT", "WhatsApp cannot be connected yet.", {
      reason: "connections_disabled",
    });
  }
  const app = signupAppConfig();
  if (app === null) {
    throw apiError("INTERNAL", "WhatsApp signup is not configured.", {
      reason: "not_configured",
    });
  }
  return app;
}

type InspectedToken = { grantedScopes: string[]; tokenExpiresAt?: number };

/** Step 2: the token must be ours, valid, fully permitted and granted this WABA. */
function checkInspection(body: unknown, app: SignupAppConfig, wabaId: string): InspectedToken {
  const data = (body as { data?: unknown } | null)?.data as
    | {
        app_id?: unknown;
        is_valid?: unknown;
        scopes?: unknown;
        granular_scopes?: unknown;
        expires_at?: unknown;
      }
    | undefined;
  if (data === undefined || data === null || typeof data !== "object") {
    throw refused("token_invalid", "Meta did not confirm the signup.");
  }
  if (data.is_valid !== true) throw refused("token_invalid", "Meta did not confirm the signup.");
  if (String(data.app_id) !== app.appId) {
    throw refused("token_wrong_app", "The signup was not made for this application.");
  }
  const scopes = Array.isArray(data.scopes)
    ? data.scopes.filter((s): s is string => typeof s === "string")
    : [];
  if (!WHATSAPP_SCOPES.every((scope) => scopes.includes(scope))) {
    throw refused("scopes_missing", "The signup did not grant the required WhatsApp permissions.");
  }
  const management = Array.isArray(data.granular_scopes)
    ? (data.granular_scopes as { scope?: unknown; target_ids?: unknown }[]).find(
        (entry) => entry?.scope === "whatsapp_business_management",
      )
    : undefined;
  const targets = Array.isArray(management?.target_ids)
    ? management.target_ids.map((id) => String(id))
    : [];
  // Explicit grants only: Meta lists the WABAs the customer shared with us here.
  if (!targets.includes(wabaId)) {
    throw refused(
      "waba_not_granted",
      "This WhatsApp account was not shared with this application.",
    );
  }
  const expires = typeof data.expires_at === "number" ? data.expires_at : 0;
  return {
    grantedScopes: scopes.filter((s) => s.startsWith("whatsapp_")).sort(),
    ...(expires > 0 ? { tokenExpiresAt: expires * 1000 } : {}),
  };
}

/**
 * The PIN for this WABA's numbers, and the credentialVersion it was read at (null: no
 * connection yet). A PIN stored with an existing connection (active or needs_reauth) is always
 * kept: numbers registered with it have it as their two-step PIN at Meta. A new PIN only when
 * no credential is stored (first signup; a revoked connection's credential is deleted). A
 * stored credential that cannot be read is refused, never replaced. recordConnection refuses
 * the write if the version changed meanwhile (a concurrent signup stored another PIN).
 */
async function pinFor(
  ctx: ActionCtx,
  orgId: Id<"organizations">,
  wabaId: string,
): Promise<{ pin: string; expectedCredentialVersion: number | null }> {
  const existing = await ctx.runQuery(internal.whatsapp.accounts.findConnectionForWaba, {
    orgId,
    wabaId,
  });
  if (existing === null) return { pin: generatePin(), expectedCredentialVersion: null };
  const fresh = { pin: generatePin(), expectedCredentialVersion: existing.credentialVersion };
  if (existing.revoked) return fresh;
  let stored: { pin: string | null; version: number };
  try {
    stored = await withConnectionCredential(
      ctx,
      existing.connectionId,
      async (credential, binding) => ({
        pin: parseCredential(credential)?.pin ?? null,
        version: binding.credentialVersion,
      }),
      { allowNeedsReauth: true },
    );
  } catch (error) {
    // No credential row: nothing to keep. Anything else (it exists but cannot be decrypted).
    if (error instanceof CredentialUnavailableError) return fresh;
    stored = { pin: null, version: existing.credentialVersion };
  }
  if (stored.pin === null) {
    throw apiError("CONFLICT", "The stored WhatsApp credential cannot be used. Contact support.", {
      reason: "stored_pin_unavailable",
    });
  }
  return { pin: stored.pin, expectedCredentialVersion: stored.version };
}

/** Meta refused the business token itself (same classification as the Meta Ads provider). */
function tokenRefused(failure: GraphFailure): boolean {
  return (
    failure.kind === "http" &&
    ((failure.metaCode !== undefined && TOKEN_AUTH_ERROR_CODES.has(failure.metaCode)) ||
      failure.status === 401)
  );
}

function outcomeOf(result: GraphOutcome): { failure?: string; tokenRefused: boolean } {
  if (result.ok) {
    return isSuccess(result.body)
      ? { tokenRefused: false }
      : { failure: "unexpected_response", tokenRefused: false };
  }
  return { failure: failureReason(result.failure), tokenRefused: tokenRefused(result.failure) };
}

/**
 * Steps 5-6 for one account: only what is still missing, never a completed step again. Never
 * throws for Meta failures. Nothing runs for an inactive connection or an account without an
 * active number (nothing at Meta is subscribed for it). A refused token moves the connection to
 * needs_reauth and stops. A number is registered only under a won claim (claimRegistration:
 * one call at a time, our attempt cap, Meta's rate-limit window).
 */
async function runSetupSteps(
  ctx: ActionCtx,
  orgId: Id<"organizations">,
  accountId: Id<"whatsappBusinessAccounts">,
  actorSubject: string,
  auth: { accessToken: string; appSecret: string; pin: string },
): Promise<void> {
  const state = await ctx.runQuery(internal.whatsapp.accounts.loadSetupState, {
    orgId,
    accountId,
  });
  if (state === null || state.status !== "active" || !state.connectionActive) return;
  if (state.numbers.length === 0) return;
  const reauth = async (step: "subscribe" | "register") =>
    await ctx.runMutation(internal.whatsapp.accounts.recordReauthRequired, {
      orgId,
      accountId,
      step,
      actorSubject,
    });
  if (!state.subscribed) {
    const outcome = outcomeOf(await subscribeApp(state.wabaId, auth));
    if (outcome.tokenRefused) {
      await reauth("subscribe");
      return;
    }
    await ctx.runMutation(internal.whatsapp.accounts.recordSubscribeResult, {
      orgId,
      accountId,
      ...(outcome.failure !== undefined ? { failure: outcome.failure } : {}),
    });
    // Registration waits for the subscription: Meta's documented order.
    if (outcome.failure !== undefined) return;
  }
  for (const number of state.numbers) {
    if (number.registered) continue;
    const claim = await ctx.runMutation(internal.whatsapp.accounts.claimRegistration, {
      orgId,
      accountId,
      numberId: number.numberId,
    });
    if (!claim.ok) continue;
    const outcome = outcomeOf(await registerPhoneNumber(number.phoneNumberId, auth.pin, auth));
    await ctx.runMutation(internal.whatsapp.accounts.recordRegisterResult, {
      orgId,
      accountId,
      numberId: number.numberId,
      ...(outcome.failure !== undefined ? { failure: outcome.failure } : {}),
    });
    if (outcome.tokenRefused) {
      await reauth("register");
      return;
    }
  }
}

async function setupResult(
  ctx: ActionCtx,
  orgId: Id<"organizations">,
  accountId: Id<"whatsappBusinessAccounts">,
): Promise<SetupResult> {
  const state = await ctx.runQuery(internal.whatsapp.accounts.loadSetupState, {
    orgId,
    accountId,
  });
  if (state === null) throw apiError("NOT_FOUND", "No WhatsApp account with this id.");
  const progress = setupProgress({
    active: state.status === "active",
    connectionActive: state.connectionActive,
    subscribed: state.subscribed,
    numbersRegistered: state.numbers.map((n) => n.registered),
  });
  const failed =
    progress.status === "action_required" || progress.status === "reauthorization_required";
  // Another call is registering a number right now: say so instead of a stale failure.
  const inProgress =
    progress.nextStep === "register" &&
    state.numbers.some((n) => !n.registered && n.registrationInProgress);
  const reason = progress.reason ?? (inProgress ? "registration_in_progress" : state.setupReason);
  return {
    accountId,
    ...progress,
    ...(failed && reason !== undefined ? { reason } : {}),
  };
}

export async function completeSignup(
  ctx: ActionCtx,
  tenant: Tenant,
  input: { code: string; wabaId: string; phoneNumberId: string },
): Promise<SetupResult> {
  // Cheap checks first; nothing is sent to Meta for malformed input.
  if (!CODE_PATTERN.test(input.code)) throw refused("invalid_code", "The signup code is invalid.");
  if (!isNumericId(input.wabaId) || !isNumericId(input.phoneNumberId)) {
    throw refused("invalid_id", "The WhatsApp account or number id is invalid.");
  }
  const app = requireOpen();

  // 1. Code -> business token (the code is valid for 30 seconds and single-use).
  const exchanged = await exchangeSignupCode(app, input.code);
  if (!exchanged.ok) {
    if (exchanged.failure.kind === "http" && (exchanged.failure.status ?? 0) < 500) {
      throw refused("signup_code_invalid", "The signup expired or was already used. Start again.");
    }
    throw providerError("code_exchange", exchanged.failure);
  }
  const accessToken = (exchanged.body as { access_token?: unknown } | null)?.access_token;
  if (typeof accessToken !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(accessToken)) {
    throw providerError("code_exchange", { kind: "invalid_json", status: 200 });
  }
  const auth = { accessToken, appSecret: app.appSecret };

  // 2. Inspect the token (ours, valid, permitted, granted this WABA).
  const inspected = await inspectToken(app, accessToken);
  if (!inspected.ok) throw providerError("token_inspection", inspected.failure);
  const token = checkInspection(inspected.body, app, input.wabaId);

  // 3. Read the WABA with the token, and find the number among the WABA's numbers.
  const waba = await readWaba(input.wabaId, auth);
  if (!waba.ok) {
    if (waba.failure.kind === "http" && (waba.failure.status ?? 0) < 500) {
      throw refused("waba_not_accessible", "This WhatsApp account cannot be read with the signup.");
    }
    throw providerError("waba", waba.failure);
  }
  const wabaBody = waba.body as { id?: unknown; name?: unknown };
  if (String(wabaBody.id) !== input.wabaId) {
    throw refused("waba_not_accessible", "This WhatsApp account cannot be read with the signup.");
  }
  const listed = await listWabaNumbers(input.wabaId, auth);
  if (!listed.ok) throw providerError("phone_numbers", listed.failure);
  const number = listed.numbers.find((n) => n.id === input.phoneNumberId);
  if (number === undefined) {
    throw refused(
      "phone_number_not_in_waba",
      "This number does not belong to the WhatsApp account.",
    );
  }

  // 4. Store: refuse another org's number, or this org's operator-managed number, before any
  // credential is read or stored (and before any write at Meta). recordConnection checks it
  // again and routes the number in the same transaction as the connection and account.
  const availability = await ctx.runQuery(internal.whatsapp.accounts.numberAvailability, {
    orgId: tenant.orgId,
    phoneNumberId: input.phoneNumberId,
  });
  if (availability !== "available") throw numberConflict(availability);
  const { pin, expectedCredentialVersion } = await pinFor(ctx, tenant.orgId, input.wabaId);
  const encrypted = await encryptCredential(
    { orgId: tenant.orgId, provider: "whatsapp", externalUserId: input.wabaId },
    { kind: "whatsapp", v: 1, accessToken, pin } satisfies WhatsAppCredential,
  );
  const recorded = await ctx.runMutation(internal.whatsapp.accounts.recordConnection, {
    orgId: tenant.orgId,
    issuer: tenant.issuer,
    actorSubject: tenant.subject,
    wabaId: input.wabaId,
    onboardingType: "cloud_api",
    ...(typeof wabaBody.name === "string" && wabaBody.name.trim() !== ""
      ? { displayName: wabaBody.name.trim().slice(0, 256) }
      : {}),
    grantedScopes: token.grantedScopes,
    ...(token.tokenExpiresAt !== undefined ? { tokenExpiresAt: token.tokenExpiresAt } : {}),
    encrypted,
    expectedCredentialVersion,
    number: {
      phoneNumberId: input.phoneNumberId,
      ...(number.displayPhoneNumber !== undefined
        ? { displayPhoneNumber: number.displayPhoneNumber }
        : {}),
    },
  });
  if (!recorded.ok) {
    // Nothing was written (one transaction).
    switch (recorded.reason) {
      case "waba_in_use":
        throw apiError("CONFLICT", "This WhatsApp account is connected to another organization.", {
          reason: "waba_in_use",
        });
      case "credential_changed":
        throw apiError(
          "CONFLICT",
          "Another signup for this WhatsApp account finished first. Check its status.",
          { reason: "signup_in_progress" },
        );
      case "phone_number_in_use":
        throw numberConflict("in_use");
      case "phone_number_operator_managed":
        throw numberConflict("operator_managed");
      case "connections_disabled":
        requireOpen();
    }
    throw apiError("INTERNAL", "The WhatsApp connection could not be saved.", {
      reason: recorded.reason,
    });
  }

  // 5-6. Subscribe, then register (each recorded; failures leave action_required).
  await runSetupSteps(ctx, tenant.orgId, recorded.accountId, tenant.subject, { ...auth, pin });
  return await setupResult(ctx, tenant.orgId, recorded.accountId);
}

function numberConflict(reason: "in_use" | "operator_managed") {
  return reason === "in_use"
    ? apiError("CONFLICT", "This number is connected to another organization.", {
        reason: "phone_number_in_use",
      })
    : apiError(
        "CONFLICT",
        "This number is already set up for this organization outside Embedded Signup.",
        { reason: "phone_number_operator_managed" },
      );
}

export async function retrySetup(
  ctx: ActionCtx,
  tenant: Tenant,
  input: { accountId: string },
): Promise<SetupResult> {
  const app = requireOpen();
  const state = await ctx.runQuery(internal.whatsapp.accounts.loadSetupState, {
    orgId: tenant.orgId,
    accountId: input.accountId,
  });
  if (state === null) throw apiError("NOT_FOUND", "No WhatsApp account with this id.");
  if (state.status !== "active") {
    throw apiError("CONFLICT", "This WhatsApp account is disconnected.", {
      reason: "account_disconnected",
    });
  }
  // An expired or refused token is never used again: the admin signs up again (reconnect).
  if (!state.connectionActive) throw reconnectRequired();
  try {
    await withConnectionCredential(ctx, state.connectionId, async (credential) => {
      const parsed = parseCredential(credential);
      if (parsed === null) throw new CredentialUnavailableError("missing");
      await runSetupSteps(ctx, tenant.orgId, state.accountId, tenant.subject, {
        accessToken: parsed.accessToken,
        appSecret: app.appSecret,
        pin: parsed.pin,
      });
    });
  } catch (error) {
    if (error instanceof CredentialUnavailableError) throw reconnectRequired();
    throw error;
  }
  return await setupResult(ctx, tenant.orgId, state.accountId);
}

function reconnectRequired() {
  return apiError("CONFLICT", "Connect this WhatsApp account again.", {
    reason: "reconnect_required",
  });
}
