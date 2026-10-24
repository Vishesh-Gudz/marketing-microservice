import type { SignupConfig } from "./types";

/**
 * Meta's JavaScript SDK, only as far as Embedded Signup uses it (Meta's "Embedded Signup
 * implementation" page, read 2026-10-24). It is loaded with next/script on the WhatsApp page
 * only, for admins, once the server reports Embedded Signup as available; the app id and the
 * login configuration id come from v1/whatsapp:getSignupConfig, never from client env.
 */

export const FACEBOOK_SDK_URL = "https://connect.facebook.net/en_US/sdk.js";

export type FacebookLoginOptions = {
  config_id: string;
  response_type: "code";
  override_default_response_type: true;
  extras: { setup: Record<string, never> };
};

export type FacebookSdk = {
  init(options: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }): void;
  login(callback: (response: unknown) => void, options: FacebookLoginOptions): void;
};

type AvailableConfig = SignupConfig & { available: true; appId: string; configId: string };

/** The config when Embedded Signup can start (the server sends the ids only then). */
export function availableConfig(config: SignupConfig | undefined): AvailableConfig | null {
  return config?.available === true && config.appId !== undefined && config.configId !== undefined
    ? (config as AvailableConfig)
    : null;
}

/** The loaded SDK, or undefined (not loaded, or blocked). */
export function facebookSdk(): FacebookSdk | undefined {
  const sdk = (window as Window & { FB?: Partial<FacebookSdk> }).FB;
  return typeof sdk?.init === "function" && typeof sdk.login === "function"
    ? (sdk as FacebookSdk)
    : undefined;
}

const initialized = new WeakMap<FacebookSdk, string>();

/**
 * FB.init with the values Meta documents for Embedded Signup (ADR 0014 B3, D2: exactly as
 * documented for the first real test), at most once per SDK instance and app id.
 */
export function initFacebookSdk(sdk: FacebookSdk, config: AvailableConfig): void {
  if (initialized.get(sdk) === config.appId) return;
  sdk.init({
    appId: config.appId,
    autoLogAppEvents: true,
    xfbml: true,
    version: config.graphApiVersion,
  });
  initialized.set(sdk, config.appId);
}

/** FB.login options for Embedded Signup (v4 is selected by the login configuration). */
export function embeddedSignupLoginOptions(config: AvailableConfig): FacebookLoginOptions {
  return {
    config_id: config.configId,
    response_type: "code",
    override_default_response_type: true,
    extras: { setup: {} },
  };
}
