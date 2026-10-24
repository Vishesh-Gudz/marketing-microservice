import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import type { Org } from "@/lib/analytics/types";
import type { WhatsAppAccount } from "@/lib/whatsapp/types";
import { ORG } from "@/tests/unit/analytics-fixtures";
import {
  allArgs,
  mockAction,
  queryResults,
  renderWithOrg,
  resetHarness,
  routerReplace,
} from "@/tests/unit/dashboard-harness";

/** How the faked next/script behaves for the next render. */
const sdkScript = vi.hoisted(() => ({
  mode: "load" as "load" | "error" | "missing" | "pending",
  sdk: undefined as unknown,
  mounts: 0,
}));

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);
// next/script stand-in: never loads anything; "loads" the fake SDK as the test says.
vi.mock("next/script", async () => {
  const React = await import("react");
  return {
    default: function FakeScript(props: {
      src: string;
      strategy?: string;
      crossOrigin?: string;
      onReady?: () => void;
      onError?: (event: unknown) => void;
    }) {
      const { onReady, onError } = props;
      React.useEffect(() => {
        sdkScript.mounts += 1;
        if (sdkScript.mode === "load") {
          (window as Window & { FB?: unknown }).FB = sdkScript.sdk;
          onReady?.();
        } else if (sdkScript.mode === "missing") {
          onReady?.();
        } else if (sdkScript.mode === "error") {
          onError?.(new Event("error"));
        }
      }, [onReady, onError]);
      return React.createElement("script", {
        "data-testid": "facebook-sdk",
        "data-src": props.src,
        "data-strategy": props.strategy,
        "data-crossorigin": props.crossOrigin,
      });
    },
  };
});

import WhatsAppPage, { metadata } from "@/app/(dashboard)/whatsapp/page";
import { useEmbeddedSignup } from "../whatsapp/connect-whatsapp";
import { WhatsAppView } from "./whatsapp-view";

// B3 (ADR 0014): the WhatsApp page and Meta's Embedded Signup in the browser, against a fake
// SDK and the dashboard harness. Rules and texts come from lib/whatsapp; these tests check the
// wiring and the browser-side safeguards (sender check, one attempt, the code never shown).

const VIEWER: Org = { ...ORG, role: "viewer" };
const CONFIG = {
  available: true,
  appId: "4440000000001",
  configId: "4440000000002",
  graphApiVersion: "v26.0",
  embeddedSignupVersion: "v4",
};
const UNAVAILABLE = { available: false, graphApiVersion: "v26.0", embeddedSignupVersion: "v4" };
const META = "https://www.facebook.com";
const CODE = "AQ-test-signup-code-SECRET";
const WABA = "100000000000001";
const PHONE = "200000000000001";
const COMPLETE = "v1/whatsapp:completeSignup";
const RETRY = "v1/whatsapp:retrySetup";

type Fb = { init: ReturnType<typeof vi.fn>; login: ReturnType<typeof vi.fn> };
let fb: Fb;
let loginCallback: ((response: unknown) => void) | undefined;

function account(overrides: Partial<WhatsAppAccount> = {}): WhatsAppAccount {
  return {
    id: "acc1",
    connectionId: "conn1",
    wabaId: WABA,
    status: "active",
    setupStatus: "connected",
    connectedAt: "2026-10-24T10:00:00.000Z",
    numbers: [
      {
        id: "num1",
        phoneNumberId: PHONE,
        displayPhoneNumber: "+1 555-000-0001",
        status: "active",
        registered: true,
      },
    ],
    ...overrides,
  };
}

function post(event: string, data: Record<string, unknown> = {}, origin = META) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin,
        data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event, data }),
      }),
    );
  });
}

function finish(origin = META) {
  post("FINISH", { waba_id: WABA, phone_number_id: PHONE, business_id: "3" }, origin);
}

async function answer(response: unknown) {
  await act(async () => loginCallback?.(response));
}

function connectButton() {
  return screen.getByRole("button", { name: /Connect WhatsApp|Waiting|Connecting|Preparing/ });
}

function render(org: Org = ORG) {
  return renderWithOrg(<WhatsAppView />, org);
}

beforeEach(() => {
  resetHarness();
  sdkScript.mode = "load";
  sdkScript.mounts = 0;
  loginCallback = undefined;
  fb = {
    init: vi.fn(),
    login: vi.fn((callback: (response: unknown) => void) => {
      loginCallback = callback;
    }),
  };
  sdkScript.sdk = fb;
  queryResults.set("v1/whatsapp:getSignupConfig", CONFIG);
  queryResults.set("v1/whatsapp:listAccounts", []);
  queryResults.set("v1/connections:list", []);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as Window & { FB?: unknown }).FB;
});

describe("WhatsApp page", () => {
  it("is the /whatsapp route, titled WhatsApp", () => {
    expect(metadata.title).toBe("WhatsApp");
    renderWithOrg(<WhatsAppPage />);
    expect(screen.getByRole("heading", { level: 1, name: "WhatsApp" })).toBeInTheDocument();
  });

  it("shows viewers the accounts only: no signup config, no Meta SDK, no admin actions", () => {
    queryResults.set("v1/whatsapp:listAccounts", [
      account({ setupStatus: "action_required", nextStep: "register" }),
      account({ id: "acc2", setupStatus: "reauthorization_required" }),
    ]);
    render(VIEWER);
    expect(screen.getByText("Only organization admins can connect WhatsApp.")).toBeInTheDocument();
    const configCalls = allArgs("v1/whatsapp:getSignupConfig");
    expect(configCalls.length).toBeGreaterThan(0);
    expect(configCalls.every((args) => args === "skip")).toBe(true);
    expect(allArgs("v1/whatsapp:listAccounts")).toContainEqual({});
    expect(screen.queryByTestId("facebook-sdk")).not.toBeInTheDocument();
    expect(sdkScript.mounts).toBe(0);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem", { name: /WhatsApp Business account/ })).toHaveLength(2);
  });

  it("says so when WhatsApp is not available, without loading Meta's SDK", () => {
    queryResults.set("v1/whatsapp:getSignupConfig", UNAVAILABLE);
    render();
    expect(screen.getByLabelText("WhatsApp is not available yet")).toBeInTheDocument();
    expect(screen.queryByTestId("facebook-sdk")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect WhatsApp" })).not.toBeInTheDocument();
  });

  it("waits for the signup config, then for the SDK", () => {
    queryResults.delete("v1/whatsapp:getSignupConfig");
    const { rerender } = render();
    expect(
      screen.getByRole("status", { name: "Checking whether WhatsApp can be connected" }),
    ).toBeInTheDocument();
    sdkScript.mode = "pending";
    queryResults.set("v1/whatsapp:getSignupConfig", CONFIG);
    rerender(<WhatsAppView />);
    expect(screen.getByRole("button", { name: "Preparing Meta sign-in…" })).toBeDisabled();
  });

  it("loads Meta's documented SDK once and initializes it with the documented values", () => {
    render();
    const script = screen.getByTestId("facebook-sdk");
    expect(script).toHaveAttribute("data-src", "https://connect.facebook.net/en_US/sdk.js");
    expect(script).toHaveAttribute("data-crossorigin", "anonymous");
    expect(script).toHaveAttribute("data-strategy", "afterInteractive");
    expect(fb.init).toHaveBeenCalledTimes(1);
    expect(fb.init).toHaveBeenCalledWith({
      appId: CONFIG.appId,
      autoLogAppEvents: true,
      xfbml: true,
      version: "v26.0",
    });
    expect(connectButton()).toHaveTextContent("Connect WhatsApp");
    expect(connectButton()).toBeEnabled();
  });

  it("explains a blocked or broken SDK", () => {
    sdkScript.mode = "error";
    const first = render();
    expect(screen.getByLabelText("Meta sign-in could not load")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect WhatsApp" })).not.toBeInTheDocument();
    first.unmount();
    sdkScript.mode = "missing"; // the script ran but FB is not there
    render();
    expect(screen.getByLabelText("Meta sign-in could not load")).toBeInTheDocument();
  });
});

describe("Embedded Signup", () => {
  it("opens Meta's signup with the documented options and completes it once with code and ids", async () => {
    const complete = mockAction(COMPLETE).mockResolvedValue({
      accountId: "acc1",
      status: "connected",
    });
    const logged = vi.spyOn(console, "log");
    const logged2 = vi.spyOn(console, "info");
    render();
    fireEvent.click(connectButton());
    expect(fb.login).toHaveBeenCalledTimes(1);
    expect(fb.login.mock.calls[0]![1]).toEqual({
      config_id: CONFIG.configId,
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {} },
    });
    expect(connectButton()).toHaveTextContent("Waiting for Meta…");
    expect(connectButton()).toBeDisabled();
    expect(
      screen.getByText("Finish the steps in the Meta window. Keep this page open."),
    ).toBeInTheDocument();

    finish();
    await answer({ authResponse: { code: CODE }, status: "connected" });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({ code: CODE, wabaId: WABA, phoneNumberId: PHONE });
    const notice = await screen.findByLabelText("WhatsApp connected");
    expect(notice.parentElement).toHaveFocus();
    // The code is never shown, put in the URL or logged.
    expect(document.body.innerHTML).not.toContain(CODE);
    expect(routerReplace).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(CODE);
    for (const spy of [logged, logged2]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(CODE);
    }
    expect(connectButton()).toHaveTextContent("Connect WhatsApp");
  });

  it("pairs the code and the ids in either order", async () => {
    const complete = mockAction(COMPLETE).mockResolvedValue({
      accountId: "acc1",
      status: "connected",
    });
    render();
    fireEvent.click(connectButton());
    await answer({ authResponse: { code: CODE } });
    expect(complete).not.toHaveBeenCalled();
    finish();
    await screen.findByLabelText("WhatsApp connected");
    expect(complete).toHaveBeenCalledWith({ code: CODE, wabaId: WABA, phoneNumberId: PHONE });
  });

  it("completes when the code comes long after FINISH (the user stays on Meta's final screen)", async () => {
    vi.useFakeTimers();
    const complete = mockAction(COMPLETE).mockResolvedValue({
      accountId: "acc1",
      status: "connected",
    });
    render();
    fireEvent.click(connectButton());
    finish();
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(screen.queryByLabelText("Signup did not finish")).not.toBeInTheDocument();
    expect(connectButton()).toHaveTextContent("Waiting for Meta…");
    await answer({ authResponse: { code: CODE } });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({ code: CODE, wabaId: WABA, phoneNumberId: PHONE });
    expect(screen.getByLabelText("WhatsApp connected")).toBeInTheDocument();
  });

  it("ignores messages from other senders and from before the signup started", async () => {
    vi.useFakeTimers();
    const complete = mockAction(COMPLETE).mockResolvedValue({
      accountId: "a",
      status: "connected",
    });
    render();
    finish(); // no signup running: ignored
    fireEvent.click(connectButton());
    finish("https://evilfacebook.com");
    finish("http://www.facebook.com");
    await answer({ authResponse: { code: CODE } });
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(complete).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Signup did not finish")).toBeInTheDocument();
  });

  it("starts one signup at a time", () => {
    render();
    fireEvent.click(connectButton());
    fireEvent.click(connectButton());
    expect(fb.login).toHaveBeenCalledTimes(1);
  });

  it("refuses a second start while one is running, even when called directly", () => {
    function DoubleStart() {
      const signup = useEmbeddedSignup(CONFIG, () => {});
      return (
        <>
          {signup.script}
          <button
            type="button"
            onClick={() => {
              signup.start();
              signup.start();
            }}
          >
            Start twice
          </button>
        </>
      );
    }
    renderWithOrg(<DoubleStart />);
    fireEvent.click(screen.getByRole("button", { name: "Start twice" }));
    fireEvent.click(screen.getByRole("button", { name: "Start twice" }));
    expect(fb.login).toHaveBeenCalledTimes(1);
  });

  it("explains a cancelled, closed, failed or unsupported signup without calling the server", async () => {
    const complete = mockAction(COMPLETE);
    render();

    fireEvent.click(connectButton());
    post("CANCEL", { current_step: "PHONE_NUMBER_SETUP" });
    expect(screen.getByLabelText("Signup cancelled")).toHaveTextContent(
      "cancelled at the “phone number setup” step",
    );

    fireEvent.click(connectButton());
    expect(screen.queryByLabelText("Signup cancelled")).not.toBeInTheDocument(); // cleared
    await answer({ authResponse: null, status: "unknown" });
    expect(screen.getByLabelText("Signup window closed")).toHaveTextContent("allow pop-ups");

    fireEvent.click(connectButton());
    post("CANCEL", {
      error_message: "Meta text that is never shown",
      error_code: "524126",
      session_id: "abc123",
    });
    const error = screen.getByLabelText("Meta reported an error");
    expect(error).toHaveTextContent("Reference: error code 524126, session abc123.");
    expect(error).not.toHaveTextContent("Meta text that is never shown");

    fireEvent.click(connectButton());
    post("FINISH_ONLY_WABA", { waba_id: WABA });
    expect(screen.getByLabelText("Signup not supported")).toHaveTextContent(
      "No phone number was chosen",
    );

    fireEvent.click(connectButton());
    post("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", { waba_id: WABA });
    expect(screen.getByLabelText("Signup not supported")).toHaveTextContent(
      "WhatsApp Business app",
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it("shows server refusals and partial setups in fixed words", async () => {
    const complete = mockAction(COMPLETE).mockRejectedValueOnce(
      apiError("CONFLICT", "server detail never shown", {
        reason: "phone_number_operator_managed",
      }),
    );
    render();
    fireEvent.click(connectButton());
    finish();
    await answer({ authResponse: { code: CODE } });
    const refused = await screen.findByLabelText("Number set up by support");
    expect(refused).toHaveAttribute("role", "alert");
    expect(refused).not.toHaveTextContent("server detail never shown");

    complete.mockResolvedValueOnce({
      accountId: "acc1",
      status: "action_required",
      nextStep: "register",
      reason: "meta_133016",
    });
    fireEvent.click(connectButton());
    finish();
    await answer({ authResponse: { code: CODE } });
    expect(
      await screen.findByLabelText("WhatsApp connected, setup not finished"),
    ).toHaveTextContent("Meta limits how often a number can be registered");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("shows progress while the server connects", async () => {
    let resolve: (value: unknown) => void = () => {};
    mockAction(COMPLETE).mockImplementation(() => new Promise((r) => (resolve = r)));
    render();
    fireEvent.click(connectButton());
    finish();
    await answer({ authResponse: { code: CODE } });
    expect(connectButton()).toHaveTextContent("Connecting…");
    expect(
      screen.getByText("Connecting your WhatsApp number. This can take a few seconds."),
    ).toBeInTheDocument();
    await act(async () => resolve({ accountId: "acc1", status: "connected" }));
    expect(screen.getByLabelText("WhatsApp connected")).toBeInTheDocument();
  });
});

describe("Connected accounts", () => {
  it("lists each account with its name, status and numbers", () => {
    queryResults.set("v1/connections:list", [
      { id: "conn1", provider: "whatsapp", status: "active", displayName: "Acme Coaching" },
    ]);
    queryResults.set("v1/whatsapp:listAccounts", [
      account({
        setupStatus: "action_required",
        nextStep: "register",
        setupReason: "registration_rate_limited",
        numbers: [
          {
            id: "num1",
            phoneNumberId: PHONE,
            displayPhoneNumber: "+1 555-000-0001",
            status: "active",
            registered: false,
            registrationRetryAfter: "2026-10-27T10:00:00.000Z",
          },
        ],
      }),
    ]);
    render();
    const card = screen.getByRole("listitem", { name: /Acme Coaching/ });
    expect(within(card).getByText("Setup not finished")).toBeInTheDocument();
    expect(card).toHaveTextContent(`WhatsApp Business account ${WABA}`);
    expect(card).toHaveTextContent("Meta limits how often a number can be registered");
    const numbers = within(card).getByRole("list", { name: "Phone numbers of Acme Coaching" });
    expect(numbers).toHaveTextContent("+1 555-000-0001");
    expect(numbers).toHaveTextContent("Not registered for messaging yet");
    expect(numbers).toHaveTextContent("registration can be retried after Oct 27, 2026");
  });

  it("says when nothing is connected yet", () => {
    render();
    expect(screen.getByText(/No WhatsApp account is connected yet\./)).toHaveTextContent(
      "Use Connect WhatsApp",
    );
  });

  it("lets admins retry an unfinished setup once at a time", async () => {
    queryResults.set("v1/whatsapp:listAccounts", [
      account({ setupStatus: "action_required", nextStep: "subscribe", setupReason: "http_503" }),
    ]);
    let resolve: (value: unknown) => void = () => {};
    const retry = mockAction(RETRY).mockImplementation(() => new Promise((r) => (resolve = r)));
    render();
    const button = screen.getByRole("button", { name: "Retry setup" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith({ accountId: "acc1" });
    expect(screen.getByRole("button", { name: "Retrying setup…" })).toBeDisabled();
    await act(async () => resolve({ accountId: "acc1", status: "connected" }));
    expect(screen.getByLabelText("WhatsApp connected")).toBeInTheDocument();
  });

  it("explains a refused retry", async () => {
    queryResults.set("v1/whatsapp:listAccounts", [
      account({ setupStatus: "action_required", nextStep: "register" }),
    ]);
    mockAction(RETRY).mockRejectedValue(
      apiError("CONFLICT", "x", { reason: "reconnect_required" }),
    );
    render();
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    expect(await screen.findByLabelText("Connect WhatsApp again")).toBeInTheDocument();
  });

  it("starts a new signup from an account that needs reauthorization", () => {
    queryResults.set("v1/whatsapp:listAccounts", [
      account({ setupStatus: "reauthorization_required", setupReason: "token_invalid" }),
    ]);
    render();
    expect(screen.getByRole("listitem", { name: /WhatsApp Business account/ })).toHaveTextContent(
      "Meta no longer accepts this connection",
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect again" }));
    expect(fb.login).toHaveBeenCalledTimes(1);
  });
});
