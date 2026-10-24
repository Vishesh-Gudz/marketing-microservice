import { afterEach, describe, expect, it, vi } from "vitest";
import {
  availableConfig,
  embeddedSignupLoginOptions,
  facebookSdk,
  FACEBOOK_SDK_URL,
  initFacebookSdk,
  type FacebookSdk,
} from "./facebook-sdk";

const CONFIG = {
  available: true,
  appId: "4440000000001",
  configId: "4440000000002",
  graphApiVersion: "v26.0",
  embeddedSignupVersion: "v4",
} as const;

function fakeSdk(): FacebookSdk {
  return { init: vi.fn(), login: vi.fn() };
}

afterEach(() => {
  delete (window as Window & { FB?: unknown }).FB;
});

describe("Facebook SDK helpers", () => {
  it("loads Meta's documented SDK URL", () => {
    expect(FACEBOOK_SDK_URL).toBe("https://connect.facebook.net/en_US/sdk.js");
  });

  it("starts only with an available config that carries both ids", () => {
    expect(availableConfig(CONFIG)).toBe(CONFIG);
    expect(availableConfig(undefined)).toBeNull();
    expect(
      availableConfig({ available: false, graphApiVersion: "v26.0", embeddedSignupVersion: "v4" }),
    ).toBeNull();
    expect(availableConfig({ ...CONFIG, configId: undefined })).toBeNull();
  });

  it("finds the SDK only once it is really loaded", () => {
    expect(facebookSdk()).toBeUndefined();
    (window as Window & { FB?: unknown }).FB = { init: vi.fn() };
    expect(facebookSdk()).toBeUndefined();
    const sdk = fakeSdk();
    (window as Window & { FB?: unknown }).FB = sdk;
    expect(facebookSdk()).toBe(sdk);
  });

  it("initializes with Meta's documented values, once per SDK and app", () => {
    const sdk = fakeSdk();
    const config = availableConfig(CONFIG)!;
    initFacebookSdk(sdk, config);
    initFacebookSdk(sdk, config);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.init).toHaveBeenCalledWith({
      appId: CONFIG.appId,
      autoLogAppEvents: true,
      xfbml: true,
      version: "v26.0",
    });
    initFacebookSdk(sdk, { ...config, appId: "4440000000009" });
    expect(sdk.init).toHaveBeenCalledTimes(2);
  });

  it("logs in exactly as Meta documents for Embedded Signup", () => {
    expect(embeddedSignupLoginOptions(availableConfig(CONFIG)!)).toEqual({
      config_id: CONFIG.configId,
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {} },
    });
  });
});
