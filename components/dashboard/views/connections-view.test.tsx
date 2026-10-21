import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import type { AdAccount, Connection, Org } from "@/lib/analytics/types";
import type * as Navigation from "@/lib/connections/navigation";
import type { DiscoveredAsset, SyncStatus } from "@/lib/connections/types";
import { ORG } from "@/tests/unit/analytics-fixtures";
import {
  lastArgs,
  mockAction,
  mockMutation,
  queryResults,
  renderWithOrg,
  resetHarness,
  routerReplace,
  setUrl,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);
vi.mock("@/lib/connections/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  navigateToAuthorization: vi.fn(),
}));

import ConnectionsPage, { metadata } from "@/app/(dashboard)/connections/page";
import { navigateToAuthorization } from "@/lib/connections/navigation";
import { ConnectionsView } from "./connections-view";

// B4: the Google Ads connection journey on /connections, through the B2 harness. Rules and
// texts come from lib/connections (B1); these tests check the wiring.

const C1 = "jd7connection1";
const C2 = "jd7connection2";
const AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?state=SECRET_STATE&code_challenge=SECRET_CHALLENGE";
const BEGIN = "v1/connections:beginConnect";
const LINK = "v1/connections:linkAdAccounts";
const REFRESH = "v1/connections:refreshAssets";
const VIEWER: Org = { ...ORG, role: "viewer" };

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: C1,
    provider: "google_ads",
    status: "active",
    grantedScopes: ["https://www.googleapis.com/auth/adwords", "openid"],
    missingScopes: [],
    expiresSoon: false,
    connectedAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function asset(overrides: Partial<DiscoveredAsset>): DiscoveredAsset {
  return {
    externalId: "2220000001",
    platform: "google_ads",
    name: "Client Test",
    currency: "USD",
    timezone: "America/New_York",
    status: "active",
    isManager: false,
    managerStatus: "client",
    testAccountStatus: "test",
    parentExternalId: "1110000001",
    linked: false,
    ...overrides,
  } as DiscoveredAsset;
}

const ASSETS: DiscoveredAsset[] = [
  asset({ externalId: "1110000001", name: "Manager", isManager: true, managerStatus: "manager" }),
  asset({ externalId: "2220000001", name: "Client Test" }),
  asset({ externalId: "2220000002", name: "Client Real", testAccountStatus: "not_test" }),
  asset({ externalId: "2220000003", name: "Client Linked", linked: true }),
  asset({
    externalId: "7770000001",
    name: "Unknown Type",
    managerStatus: "unknown",
    testAccountStatus: "unknown",
  }),
];

function adAccount(overrides: Partial<AdAccount> = {}): AdAccount {
  return {
    id: "a2",
    platform: "google_ads",
    externalId: "2220000003",
    name: "Client Linked",
    currency: "USD",
    timezone: "America/New_York",
    status: "active",
    isManager: false,
    linked: true,
    connectionId: C1,
    ...overrides,
  } as AdAccount;
}

function setup({
  connections = [connection()],
  assets = ASSETS,
  accounts = [] as AdAccount[],
} = {}) {
  queryResults.set("v1/connections:list", connections);
  queryResults.set("v1/adAccounts:list", accounts);
  queryResults.set("v1/connections:listDiscoveredAssets", () => assets);
}

const radio = (name: RegExp) => screen.getByRole("radio", { name });
const DISCOVERED = "v1/connections:listDiscoveredAssets";

beforeEach(() => {
  resetHarness();
  setUrl("/connections");
  vi.mocked(navigateToAuthorization).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("/connections route", () => {
  it("titles the page and renders one heading with a Google Ads region", () => {
    setup();
    expect(metadata.title).toBe("Connections");
    renderWithOrg(<ConnectionsPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Connections" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Google Ads" })).toBeInTheDocument();
  });
});

describe("connection status and roles", () => {
  it("offers Connect to an admin when Google Ads is not connected", () => {
    setup({ connections: [connection({ provider: "meta", id: "m1" })] });
    renderWithOrg(<ConnectionsView />);
    expect(screen.getByText("Google Ads is not connected.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Google Ads" })).toBeEnabled();
    // Discovery is only asked for the Meta connection (on the Meta Ads card).
    expect(lastArgs(DISCOVERED)).toEqual({ connectionId: "m1" });
  });

  it("shows a viewer the status and linked accounts, but no actions and no discovery", () => {
    setup({ accounts: [adAccount()] });
    renderWithOrg(<ConnectionsView />, VIEWER);
    expect(screen.getByLabelText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/Only organization admins can connect Google Ads/)).toBeInTheDocument();
    // listDiscoveredAssets is admin-only on the server: a viewer never asks for it.
    expect(lastArgs(DISCOVERED)).toBeUndefined();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: /Linked Google Ads accounts/ })).toBeInTheDocument();
  });

  it("shows a reconnect-required connection with Reconnect", () => {
    setup({ connections: [connection({ status: "needs_reauth" })] });
    renderWithOrg(<ConnectionsView />);
    expect(screen.getByLabelText("Reconnect required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect Google Ads" })).toBeEnabled();
  });

  it("explains a discovery failure from its allowlisted reason", () => {
    setup({
      connections: [
        connection({
          lastError: {
            kind: "unknown",
            message: "The platform request failed",
            reason: "cloud_project_not_approved_for_production",
            at: "2026-09-01T10:00:00.000Z",
          },
        }),
      ],
      assets: [],
    });
    renderWithOrg(<ConnectionsView />);
    const notice = screen.getByLabelText("Your Google Ads accounts could not be loaded");
    expect(notice).toHaveTextContent("Test access only");
    expect(notice).not.toHaveTextContent("The platform request failed");
    expect(screen.queryByText("No Google Ads accounts found")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry discovery" })).toBeEnabled();
  });

  it("lets an admin switch between several Google connections", () => {
    setup({
      connections: [
        connection({ id: C1, connectedAt: "2026-09-01T10:00:00.000Z" }),
        connection({ id: C2, connectedAt: "2026-09-02T10:00:00.000Z" }),
      ],
    });
    renderWithOrg(<ConnectionsView />);
    const select = screen.getByRole("combobox", { name: "Google connection" });
    expect(select).toHaveValue(C2);
    fireEvent.change(select, { target: { value: C1 } });
    expect(lastArgs(DISCOVERED)).toEqual({
      connectionId: C1,
    });
  });
});

describe("Connect / Reconnect", () => {
  it("starts OAuth with the allowlisted return URL and leaves without showing the URL", async () => {
    setUrl("/connections", "preset=last_7_days&tab=x");
    setup({ connections: [] });
    mockAction(BEGIN).mockResolvedValue({ authorizeUrl: AUTHORIZE_URL, expiresAt: "x" });
    const log = vi.spyOn(console, "log");
    const info = vi.spyOn(console, "info");
    renderWithOrg(<ConnectionsView />);

    fireEvent.click(screen.getByRole("button", { name: "Connect Google Ads" }));
    await waitFor(() => expect(navigateToAuthorization).toHaveBeenCalledOnce());

    expect(mockAction(BEGIN)).toHaveBeenCalledExactlyOnceWith({
      provider: "google_ads",
      returnUrl: `${window.location.origin}/connections?preset=last_7_days&connect=google_ads`,
    });
    expect(navigateToAuthorization).toHaveBeenCalledWith(AUTHORIZE_URL);
    expect(screen.getByRole("button", { name: "Opening Google sign-in…" })).toBeDisabled();
    expect(document.body.innerHTML).not.toContain("SECRET_STATE");
    expect(document.body.innerHTML).not.toContain("accounts.google.com");
    expect([...log.mock.calls, ...info.mock.calls].flat().join(" ")).not.toContain("SECRET");
  });

  it("reconnects the shown connection by id", async () => {
    setup({ connections: [connection({ status: "needs_reauth" })] });
    mockAction(BEGIN).mockResolvedValue({ authorizeUrl: AUTHORIZE_URL, expiresAt: "x" });
    renderWithOrg(<ConnectionsView />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Google Ads" }));
    await waitFor(() => expect(navigateToAuthorization).toHaveBeenCalledOnce());
    expect(mockAction(BEGIN)).toHaveBeenCalledWith({
      provider: "google_ads",
      returnUrl: `${window.location.origin}/connections?connect=google_ads`,
      reconnectConnectionId: C1,
    });
  });

  it.each([
    [
      apiError("INVALID_ARGUMENT", "returnUrl is not allowed", { field: "returnUrl" }),
      "This dashboard address is not allowed",
    ],
    [apiError("FORBIDDEN", "role"), "Admins only"],
    [apiError("RATE_LIMITED", "busy"), "Too many attempts"],
  ])(
    "shows a fixed notice when beginConnect fails (%#) and stays on the page",
    async (error, title) => {
      setup({ connections: [] });
      mockAction(BEGIN).mockRejectedValue(error);
      renderWithOrg(<ConnectionsView />);
      fireEvent.click(screen.getByRole("button", { name: "Connect Google Ads" }));
      expect(await screen.findByLabelText(title)).toBeInTheDocument();
      expect(navigateToAuthorization).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Connect Google Ads" })).toBeEnabled();
      expect(document.body.textContent).not.toContain(error.data.message);
    },
  );
});

describe("Disconnect", () => {
  const DISCONNECT = "v1/connections:disconnect";
  const META = connection({ id: "m1", provider: "meta" });
  const confirmation = () => screen.queryByRole("group", { name: "Disconnect Google Ads?" });
  const openConfirmation = () =>
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Google Ads" }));

  it("keeps Reconnect available next to Disconnect for a valid connection", () => {
    setup();
    renderWithOrg(<ConnectionsView />);
    expect(screen.getByRole("button", { name: "Reconnect Google Ads" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disconnect Google Ads" })).toBeEnabled();
  });

  it("asks for confirmation first and focuses Cancel; nothing is disconnected yet", () => {
    setup({ connections: [connection({ status: "needs_reauth" })] });
    renderWithOrg(<ConnectionsView />);
    openConfirmation();
    const group = confirmation()!;
    expect(group).toHaveTextContent("Their data and history are kept");
    expect(group).toHaveTextContent("sign in with any Google account");
    expect(within(group).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(mockMutation(DISCONNECT)).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reconnect Google Ads" })).toBeEnabled();
  });

  it.each([
    ["Cancel", () => fireEvent.click(screen.getByRole("button", { name: "Cancel" }))],
    ["Escape", () => fireEvent.keyDown(confirmation()!, { key: "Escape" })],
  ])("%s closes the confirmation without disconnecting", (_label, close) => {
    setup();
    renderWithOrg(<ConnectionsView />);
    openConfirmation();
    close();
    expect(confirmation()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect Google Ads" })).toHaveFocus();
    expect(mockMutation(DISCONNECT)).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Connected")).toBeInTheDocument();
  });

  it("disconnects only the shown Google connection, then offers a fresh Connect", async () => {
    setup({ connections: [META, connection({ status: "needs_reauth" })] });
    mockMutation(DISCONNECT).mockImplementation(async () => {
      // The live query drops the revoked connection; Meta is untouched.
      queryResults.set("v1/connections:list", [META]);
      return connection({ status: "revoked" });
    });
    mockAction(BEGIN).mockResolvedValue({ authorizeUrl: AUTHORIZE_URL, expiresAt: "x" });
    renderWithOrg(<ConnectionsView />);

    openConfirmation();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByLabelText("Google Ads disconnected")).toBeInTheDocument();
    expect(mockMutation(DISCONNECT)).toHaveBeenCalledExactlyOnceWith({ connectionId: C1 });
    expect(screen.getByText("Google Ads is not connected.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect Google Ads" })).not.toBeInTheDocument();

    // A fresh connection: no reconnect id, so any Google account can sign in.
    fireEvent.click(screen.getByRole("button", { name: "Connect Google Ads" }));
    await waitFor(() => expect(navigateToAuthorization).toHaveBeenCalledOnce());
    expect(mockAction(BEGIN)).toHaveBeenCalledExactlyOnceWith({
      provider: "google_ads",
      returnUrl: `${window.location.origin}/connections?connect=google_ads`,
    });
  });

  it("disconnects the connection chosen among several Google connections", async () => {
    setup({
      connections: [
        connection({ id: C1, connectedAt: "2026-09-01T10:00:00.000Z" }),
        connection({ id: C2, connectedAt: "2026-09-02T10:00:00.000Z" }),
      ],
    });
    mockMutation(DISCONNECT).mockResolvedValue(connection({ id: C1, status: "revoked" }));
    renderWithOrg(<ConnectionsView />);
    fireEvent.change(screen.getByRole("combobox", { name: "Google connection" }), {
      target: { value: C1 },
    });
    openConfirmation();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(mockMutation(DISCONNECT)).toHaveBeenCalledExactlyOnceWith({ connectionId: C1 }),
    );
  });

  it.each([
    [apiError("FORBIDDEN", "role check failed"), "Admins only", "role check failed"],
    [apiError("NOT_FOUND", "no such connection"), "Connection not found", "no such connection"],
    [new Error("socket closed ya29.token"), "Something went wrong", "ya29"],
  ])(
    "shows a fixed notice when disconnect fails (%#) and keeps the connection",
    async (error, title, raw) => {
      setup();
      mockMutation(DISCONNECT).mockRejectedValue(error);
      renderWithOrg(<ConnectionsView />);
      openConfirmation();
      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
      expect(await screen.findByLabelText(title)).toBeInTheDocument();
      expect(confirmation()).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Disconnect Google Ads" })).toBeEnabled();
      expect(screen.getByLabelText("Connected")).toBeInTheDocument();
      expect(screen.queryByLabelText("Google Ads disconnected")).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain(raw);
    },
  );

  it("keeps the confirmation buttons disabled while disconnecting", async () => {
    setup();
    mockMutation(DISCONNECT).mockReturnValue(new Promise(() => {}));
    renderWithOrg(<ConnectionsView />);
    openConfirmation();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("button", { name: "Disconnecting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(mockMutation(DISCONNECT)).toHaveBeenCalledOnce();
  });

  it.each([
    ["viewer", VIEWER],
    ["editor", { ...ORG, role: "editor" } as Org],
  ])("is not offered to a %s", (_role, org) => {
    setup({ connections: [connection({ status: "needs_reauth" })] });
    renderWithOrg(<ConnectionsView />, org);
    expect(screen.getByLabelText("Reconnect required")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/Only organization admins can connect Google Ads/)).toBeInTheDocument();
    expect(mockMutation(DISCONNECT)).not.toHaveBeenCalled();
  });
});

describe("Meta Ads card", () => {
  const M1 = "jd7metaconnection1";
  const M2 = "jd7metaconnection2";
  const DISCONNECT = "v1/connections:disconnect";
  const EDITOR: Org = { ...ORG, role: "editor" };
  const AT = "2026-09-01T10:00:00.000Z";
  const metaConnection = (overrides: Partial<Connection> = {}) =>
    connection({ id: M1, provider: "meta", grantedScopes: ["ads_read"], ...overrides });
  const metaAsset = (overrides: Partial<DiscoveredAsset>): DiscoveredAsset =>
    asset({
      platform: "meta",
      externalId: "1001",
      name: "Acme Retail US",
      currency: "USD",
      timezone: "America/New_York",
      status: "active",
      isManager: false,
      managerStatus: "client",
      testAccountStatus: "unknown",
      parentExternalId: "5550001",
      linked: false,
      ...overrides,
    });
  const META_ASSETS: DiscoveredAsset[] = [
    metaAsset({}),
    metaAsset({
      externalId: "1002",
      name: "Acme Indonesia",
      currency: "IDR",
      timezone: "Asia/Jakarta",
      parentExternalId: undefined,
    }),
    metaAsset({ externalId: "1003", name: "Empty sandbox", status: "disabled", linked: true }),
  ];
  const meta = () => screen.getByRole("region", { name: "Meta Ads" });
  const google = () => screen.getByRole("region", { name: "Google Ads" });
  /** Discovery per connection: Meta assets for the Meta connections, Google ones otherwise. */
  function setupMeta({
    connections = [metaConnection()],
    metaAssets = META_ASSETS,
    accounts = [] as AdAccount[],
  } = {}) {
    setup({ connections, accounts });
    queryResults.set("v1/connections:listDiscoveredAssets", (args: Record<string, unknown>) =>
      args.connectionId === M1 || args.connectionId === M2 ? metaAssets : ASSETS,
    );
  }
  const expectNoGoogleWording = () =>
    expect(meta().textContent).not.toMatch(/Google|Manager account|customer/i);

  it("has its own section; Connect Meta Ads starts the Meta flow once and never shows the URL", async () => {
    setupMeta({ connections: [] });
    mockAction(BEGIN).mockResolvedValue({ authorizeUrl: AUTHORIZE_URL, expiresAt: "x" });
    renderWithOrg(<ConnectionsView />);
    expect(within(meta()).getByText("Meta Ads is not connected.")).toBeInTheDocument();
    const button = within(meta()).getByRole("button", { name: "Connect Meta Ads" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(navigateToAuthorization).toHaveBeenCalledOnce());
    expect(mockAction(BEGIN)).toHaveBeenCalledExactlyOnceWith({
      provider: "meta",
      returnUrl: `${window.location.origin}/connections?connect=meta`,
    });
    expect(within(meta()).getByRole("button", { name: "Opening Meta sign-in…" })).toBeDisabled();
    // Google Ads is untouched.
    expect(within(google()).getByRole("button", { name: "Connect Google Ads" })).toBeEnabled();
    expect(document.body.innerHTML).not.toContain("SECRET_STATE");
    expectNoGoogleWording();
  });

  it("explains in Meta words when Meta Ads is not available on this service", async () => {
    setupMeta({ connections: [] });
    mockAction(BEGIN).mockRejectedValue(
      apiError("INVALID_ARGUMENT", "This platform cannot be connected yet.", { field: "provider" }),
    );
    renderWithOrg(<ConnectionsView />);
    fireEvent.click(within(meta()).getByRole("button", { name: "Connect Meta Ads" }));
    const notice = await within(meta()).findByLabelText("Meta Ads is not available");
    expect(notice).toHaveTextContent("Meta Ads cannot be connected on this service yet.");
    expect(within(meta()).getByRole("button", { name: "Connect Meta Ads" })).toBeEnabled();
    expect(navigateToAuthorization).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("This platform cannot be connected yet.");
  });

  it("lists discovered Meta ad accounts without Google-only columns and links exactly one", async () => {
    setupMeta();
    mockMutation(LINK).mockResolvedValue([]);
    renderWithOrg(<ConnectionsView />);
    expect(within(meta()).getByLabelText("Connected")).toHaveTextContent("Meta Ads is connected.");
    const table = within(meta()).getByRole("table", { name: "Discovered Meta Ads accounts" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);
    expect(headers).toEqual([
      "Select",
      "Account",
      "Currency / time zone",
      "Status",
      "Business",
      "Availability",
    ]);
    const row = (id: string) => within(table).getByText(id).closest("tr") as HTMLElement;
    expect(row("1001")).toHaveTextContent("USD · America/New_York");
    expect(row("1001")).toHaveTextContent("5550001");
    expect(row("1002")).toHaveTextContent("—");
    expect(row("1003")).toHaveTextContent("Disabled");
    expect(within(meta()).getByRole("radio", { name: /Empty sandbox/ })).toBeDisabled();

    fireEvent.click(within(meta()).getByRole("radio", { name: /Acme Retail US/ }));
    fireEvent.click(within(meta()).getByRole("button", { name: "Link selected account" }));
    expect(await within(meta()).findByLabelText("Account linked")).toHaveTextContent(
      "Acme Retail US (1001) is linked. Its first sync starts automatically.",
    );
    expect(mockMutation(LINK)).toHaveBeenCalledExactlyOnceWith({
      connectionId: M1,
      externalIds: ["1001"],
    });
    expectNoGoogleWording();
  });

  it("shows an empty Meta discovery in Meta words, with Retry discovery", async () => {
    setupMeta({ metaAssets: [] });
    mockMutation(REFRESH).mockResolvedValue(null);
    renderWithOrg(<ConnectionsView />);
    expect(within(meta()).getByText("No Meta ad accounts found")).toBeInTheDocument();
    expect(meta()).toHaveTextContent("This Facebook account cannot access any Meta ad account.");
    fireEvent.click(within(meta()).getByRole("button", { name: "Retry discovery" }));
    await waitFor(() =>
      expect(mockMutation(REFRESH)).toHaveBeenCalledExactlyOnceWith({ connectionId: M1 }),
    );
    expectNoGoogleWording();
  });

  it.each([
    [
      { kind: "auth", reason: "reauth_required" as const },
      "Meta needs you to sign in again. Reconnect Meta Ads.",
    ],
    [
      { kind: "permission", reason: "permission_denied" as const },
      "The connected Facebook account has no permission to read this Meta ad account.",
    ],
    [{ kind: "rate_limited" }, "Meta Ads did not respond. Retry discovery in a few minutes."],
  ])(
    "explains a Meta discovery failure (%#) in Meta words, never the server message",
    (err, text) => {
      setupMeta({
        connections: [
          metaConnection({
            lastError: { message: "Meta request failed (secret detail)", at: AT, ...err },
          }),
        ],
        metaAssets: [],
      });
      renderWithOrg(<ConnectionsView />);
      const notice = within(meta()).getByLabelText("Your Meta ad accounts could not be loaded");
      expect(notice).toHaveTextContent(text);
      expect(document.body.textContent).not.toContain("secret detail");
      expect(within(meta()).queryByText("No Meta ad accounts found")).not.toBeInTheDocument();
      expectNoGoogleWording();
    },
  );

  it("a Meta connection needing reconnection explains it and Reconnect passes its id", async () => {
    setupMeta({ connections: [metaConnection({ status: "needs_reauth" })] });
    mockAction(BEGIN).mockResolvedValue({ authorizeUrl: AUTHORIZE_URL, expiresAt: "x" });
    renderWithOrg(<ConnectionsView />);
    expect(within(meta()).getByLabelText("Reconnect required")).toHaveTextContent(
      "Meta access expired or was revoked. Reconnect with the same Facebook account, or disconnect Meta Ads to use a different one.",
    );
    expect(within(meta()).getByRole("radio", { name: /Acme Retail US/ })).toBeDisabled();
    fireEvent.click(within(meta()).getByRole("button", { name: "Reconnect Meta Ads" }));
    await waitFor(() => expect(navigateToAuthorization).toHaveBeenCalledOnce());
    expect(mockAction(BEGIN)).toHaveBeenCalledWith({
      provider: "meta",
      returnUrl: `${window.location.origin}/connections?connect=meta`,
      reconnectConnectionId: M1,
    });
    expectNoGoogleWording();
  });

  it("warns before Meta access expires (Meta tokens last about 60 days)", () => {
    setupMeta({ connections: [metaConnection({ expiresSoon: true })] });
    renderWithOrg(<ConnectionsView />);
    expect(within(meta()).getByLabelText("Access expires soon")).toHaveTextContent(
      "Reconnect Meta Ads soon to keep syncing.",
    );
  });

  it("disconnects Meta Ads only; the Google Ads connection stays", async () => {
    const list = [connection(), metaConnection()];
    setupMeta({ connections: list });
    mockMutation(DISCONNECT).mockImplementation(async () => {
      queryResults.set("v1/connections:list", [connection()]);
      return metaConnection({ status: "revoked" });
    });
    renderWithOrg(<ConnectionsView />);
    fireEvent.click(within(meta()).getByRole("button", { name: "Disconnect Meta Ads" }));
    const group = within(meta()).getByRole("group", { name: "Disconnect Meta Ads?" });
    expect(group).toHaveTextContent("The stored Meta access is deleted.");
    expect(group).toHaveTextContent("connect again to sign in with any Facebook account");
    fireEvent.click(within(group).getByRole("button", { name: "Disconnect" }));
    expect(await within(meta()).findByLabelText("Meta Ads disconnected")).toHaveTextContent(
      "Connect Meta Ads to sign in with any Facebook account.",
    );
    expect(mockMutation(DISCONNECT)).toHaveBeenCalledExactlyOnceWith({ connectionId: M1 });
    expect(within(meta()).getByText("Meta Ads is not connected.")).toBeInTheDocument();
    expect(within(google()).getByLabelText("Connected")).toHaveTextContent(
      "Google Ads is connected.",
    );
    expect(within(google()).getByRole("button", { name: "Disconnect Google Ads" })).toBeEnabled();
    expectNoGoogleWording();
  });

  it("shows linked Meta accounts with Meta sync wording and raw ad account ids", () => {
    const metaAccount = (overrides: Partial<AdAccount>) =>
      adAccount({
        platform: "meta",
        connectionId: M1,
        ...overrides,
      });
    setupMeta({
      accounts: [
        metaAccount({
          id: "ma1",
          externalId: "1001",
          name: "Acme Retail US",
          sync: {
            syncState: "idle",
            consecutiveFailures: 2,
            lastRunStatus: "failed",
            lastError: { kind: "permission", message: "x", reason: "permission_denied", at: AT },
          },
        }),
        metaAccount({
          id: "ma2",
          externalId: "1002",
          name: "Acme Indonesia",
          sync: { syncState: "blocked", consecutiveFailures: 1 },
        }),
        metaAccount({
          id: "ma3",
          externalId: "1004",
          name: "Up to date",
          sync: {
            syncState: "idle",
            consecutiveFailures: 0,
            lastRunStatus: "succeeded",
            lastSuccessAt: "2026-09-21T08:30:00.000Z",
            coveredThrough: "2026-09-20",
          },
        }),
      ],
    });
    renderWithOrg(<ConnectionsView />);
    const table = within(meta()).getByRole("table", { name: /Linked Meta Ads accounts/ });
    const row = (id: string) => table.querySelector(`[data-account-id="${id}"]`) as HTMLElement;
    expect(row("ma1")).toHaveTextContent("1001");
    expect(row("ma1")).toHaveTextContent("Last sync failed (2 failures in a row)");
    expect(row("ma1")).toHaveTextContent(
      "The connected Facebook account has no permission to read this Meta ad account.",
    );
    expect(row("ma2")).toHaveTextContent("Sync blocked");
    expect(row("ma2")).toHaveTextContent(
      "Meta denied access to this account or it no longer exists.",
    );
    expect(row("ma3")).toHaveTextContent("Up to date");
    expect(
      within(row("ma3")).getByRole("link", { name: "View analytics for Up to date" }),
    ).toHaveAttribute("href", "/?accounts=ma3");
    // Not in the Google Ads card.
    expect(within(google()).queryByText("Acme Retail US")).not.toBeInTheDocument();
    expectNoGoogleWording();
  });

  it.each([
    ["viewer", VIEWER],
    ["editor", EDITOR],
  ])("a %s sees the Meta status and linked accounts but no Meta actions", (_role, org) => {
    setupMeta({ connections: [metaConnection({ status: "needs_reauth" })] });
    renderWithOrg(<ConnectionsView />, org);
    expect(within(meta()).getByLabelText("Reconnect required")).toBeInTheDocument();
    expect(within(meta()).queryByRole("button")).not.toBeInTheDocument();
    expect(meta()).toHaveTextContent(
      "Only organization admins can connect Meta Ads or choose the account to sync.",
    );
    // listDiscoveredAssets is admin-only on the server: never asked for.
    expect(lastArgs(DISCOVERED)).toBeUndefined();
  });

  it("never shows Instagram connections on either ad platform card", () => {
    setupMeta({
      connections: [connection({ id: "ig1", provider: "instagram", displayName: "mock_1" })],
    });
    renderWithOrg(<ConnectionsView />);
    expect(within(meta()).getByText("Meta Ads is not connected.")).toBeInTheDocument();
    expect(within(google()).getByText("Google Ads is not connected.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Instagram|mock_1/);
    expect(screen.queryByRole("region", { name: /Instagram/ })).not.toBeInTheDocument();
    expect(lastArgs(DISCOVERED)).toBeUndefined();
  });

  it("lets an admin switch between several Meta connections", () => {
    setupMeta({
      connections: [
        metaConnection({ id: M1, connectedAt: "2026-09-01T10:00:00.000Z" }),
        metaConnection({ id: M2, connectedAt: "2026-09-02T10:00:00.000Z" }),
      ],
    });
    renderWithOrg(<ConnectionsView />);
    const select = within(meta()).getByRole("combobox", { name: "Meta connection" });
    expect(select).toHaveValue(M2);
    fireEvent.change(select, { target: { value: M1 } });
    expect(lastArgs(DISCOVERED)).toEqual({ connectionId: M1 });
  });

  it.each([
    ["identity_mismatch", "A different Facebook account was used"],
    ["exchange_failed", "Meta sign-in could not be completed"],
    ["access_denied", "Meta Ads access was not granted"],
  ])("a callback error=%s after a Meta sign-in is worded for Meta", (code, title) => {
    setUrl("/connections", `status=error&error=${code}&connect=meta`);
    setupMeta({ connections: [] });
    renderWithOrg(<ConnectionsView />);
    const notice = screen.getByLabelText(title);
    expect(notice.textContent).not.toContain("Google");
    expect(routerReplace).toHaveBeenCalledExactlyOnceWith("/connections", { scroll: false });
  });

  it("confirms a Meta connection and shows that connection on the Meta card", () => {
    setUrl("/connections", `status=connected&connection=${M1}&connect=meta`);
    setupMeta({
      connections: [
        metaConnection({ id: M1, connectedAt: "2026-09-01T10:00:00.000Z" }),
        metaConnection({ id: M2, connectedAt: "2026-09-02T10:00:00.000Z" }),
      ],
    });
    renderWithOrg(<ConnectionsView />);
    expect(screen.getByLabelText("Meta Ads connected")).toHaveTextContent(
      "Choose the account to link below.",
    );
    expect(within(meta()).getByRole("combobox", { name: "Meta connection" })).toHaveValue(M1);
  });

  it("without a provider hint, a callback error is worded neutrally", () => {
    setUrl("/connections", "status=error&error=identity_mismatch");
    setupMeta({ connections: [] });
    renderWithOrg(<ConnectionsView />);
    const notice = screen.getByLabelText("A different account was used");
    expect(notice.textContent).not.toMatch(/Google|Meta|Facebook/);
  });
});

describe("OAuth callback result", () => {
  it("confirms a connection, shows that connection, and removes the parameters (filters stay)", () => {
    setUrl(
      "/connections",
      `preset=last_7_days&status=connected&connection=${C1}&connect=google_ads`,
    );
    setup({
      connections: [
        connection({ id: C1, connectedAt: "2026-09-01T10:00:00.000Z" }),
        connection({ id: C2, connectedAt: "2026-09-02T10:00:00.000Z" }),
      ],
    });
    renderWithOrg(<ConnectionsView />);
    expect(screen.getByLabelText("Google Ads connected")).toHaveTextContent(
      "Choose the account to link below.",
    );
    // The just-connected (older) connection is shown, not the newest one.
    expect(screen.getByRole("combobox", { name: "Google connection" })).toHaveValue(C1);
    expect(routerReplace).toHaveBeenCalledExactlyOnceWith("/connections?preset=last_7_days", {
      scroll: false,
    });
  });

  it("warns when discovery failed during the callback", () => {
    setUrl(
      "/connections",
      `status=connected&connection=${C1}&warning=discovery_failed&connect=google_ads`,
    );
    setup();
    renderWithOrg(<ConnectionsView />);
    expect(
      screen.getByLabelText("Google Ads connected, but your accounts could not be loaded"),
    ).toBeInTheDocument();
    expect(routerReplace).toHaveBeenCalledWith("/connections", { scroll: false });
  });

  it.each([
    ["access_denied", "Google Ads access was not granted"],
    ["expired_state", "The sign-in took too long"],
    ["identity_mismatch", "A different Google account was used"],
    ["exchange_failed", "Google sign-in could not be completed"],
    ["something_new", "The connection could not be completed"],
  ])("shows a fixed notice for error=%s", (code, title) => {
    setUrl("/connections", `status=error&error=${code}&connect=google_ads`);
    setup({ connections: [] });
    renderWithOrg(<ConnectionsView />);
    expect(screen.getByLabelText(title)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(code);
    expect(routerReplace).toHaveBeenCalledExactlyOnceWith("/connections", { scroll: false });
  });

  it("treats a malformed result neutrally and also strips a stray code / state", () => {
    setUrl("/connections", "status=connected&connection=%3Cimg%3E&code=4%2Fx&state=s3cr3t");
    setup();
    renderWithOrg(<ConnectionsView />);
    expect(screen.getByLabelText("The connection result could not be read")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("s3cr3t");
    expect(routerReplace).toHaveBeenCalledExactlyOnceWith("/connections", { scroll: false });
  });

  it("leaves the URL alone without a result", () => {
    setUrl("/connections", "preset=last_7_days");
    setup();
    renderWithOrg(<ConnectionsView />);
    expect(routerReplace).not.toHaveBeenCalled();
  });
});

describe("discovered accounts and linking", () => {
  it("lists every discovered account with its facts; only confirmed clients are selectable", () => {
    setup();
    renderWithOrg(<ConnectionsView />);
    const table = screen.getByRole("table", { name: "Discovered Google Ads accounts" });
    const row = (id: string) => within(table).getByText(id).closest("tr") as HTMLElement;

    expect(row("222-000-0001")).toHaveTextContent("Client account");
    expect(row("222-000-0001")).toHaveTextContent("Test account");
    expect(row("222-000-0001")).toHaveTextContent("USD · America/New_York");
    expect(row("222-000-0001")).toHaveTextContent("111-000-0001"); // parent manager
    expect(row("222-000-0002")).toHaveTextContent("Not a test account");
    expect(row("777-000-0001")).toHaveTextContent("Account type not reported");
    expect(row("777-000-0001")).toHaveTextContent("Test status not reported");

    expect(radio(/Client Test/)).toBeEnabled();
    expect(radio(/Client Real/)).toBeEnabled();
    expect(radio(/^Manager/)).toBeDisabled();
    expect(radio(/^Manager/)).toHaveAccessibleDescription(/Manager accounts cannot be linked/);
    expect(radio(/Unknown Type/)).toBeDisabled();
    expect(radio(/Unknown Type/)).toHaveAccessibleDescription(/did not report whether/);
    expect(radio(/Client Linked/)).toBeDisabled();
    expect(radio(/Client Linked/)).toHaveAccessibleDescription("Linked");
    expect(screen.getByRole("button", { name: "Link selected account" })).toBeDisabled();
  });

  it("links exactly the one selected client account", async () => {
    setup();
    mockMutation(LINK).mockResolvedValue([adAccount({ id: "a9", externalId: "2220000002" })]);
    renderWithOrg(<ConnectionsView />);

    fireEvent.click(radio(/Client Test/));
    fireEvent.click(radio(/Client Real/)); // one choice only: the last one wins
    expect(screen.getByText(/Selected: Client Real \(222-000-0002\)/)).toHaveTextContent(
      "needs Explorer access or higher",
    );
    fireEvent.click(screen.getByRole("button", { name: "Link selected account" }));

    expect(await screen.findByLabelText("Account linked")).toHaveTextContent(
      "Client Real (222-000-0002) is linked",
    );
    expect(mockMutation(LINK)).toHaveBeenCalledExactlyOnceWith({
      connectionId: C1,
      externalIds: ["2220000002"],
    });
    expect(screen.getByRole("button", { name: "Link selected account" })).toBeDisabled();
  });

  it("shows the server's refusal as a fixed notice", async () => {
    setup();
    mockMutation(LINK).mockRejectedValue(
      apiError("INVALID_ARGUMENT", "raw", {
        externalId: "2220000001",
        reason: "manager_status_unknown",
      }),
    );
    renderWithOrg(<ConnectionsView />);
    fireEvent.click(radio(/Client Test/));
    fireEvent.click(screen.getByRole("button", { name: "Link selected account" }));
    expect(await screen.findByLabelText("Account type not confirmed")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("raw");
  });

  it("offers nothing to link on an inactive connection", () => {
    setup({ connections: [connection({ status: "needs_reauth" })] });
    renderWithOrg(<ConnectionsView />);
    for (const input of screen.getAllByRole("radio")) expect(input).toBeDisabled();
    expect(radio(/Client Test/)).toHaveAccessibleDescription(
      "Reconnect Google Ads before linking accounts.",
    );
    expect(screen.getByRole("button", { name: "Retry discovery" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Link selected account" })).toBeDisabled();
  });

  it("says when nothing was discovered", () => {
    setup({ assets: [] });
    renderWithOrg(<ConnectionsView />);
    expect(screen.getByText("No Google Ads accounts found")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Discovered Google Ads accounts" })).toBeNull();
  });
});

describe("retry discovery", () => {
  it("re-runs discovery and shows progress until the connection changes", async () => {
    setup();
    mockMutation(REFRESH).mockResolvedValue(null);
    const { rerender } = renderWithOrg(<ConnectionsView />);
    fireEvent.click(screen.getByRole("button", { name: "Retry discovery" }));

    expect(await screen.findByText("Refreshing the account list…")).toBeInTheDocument();
    expect(mockMutation(REFRESH)).toHaveBeenCalledExactlyOnceWith({ connectionId: C1 });
    expect(screen.getByRole("button", { name: "Retry discovery" })).toBeDisabled();

    // Discovery finished: the connection was updated (reactively).
    queryResults.set("v1/connections:list", [
      connection({ updatedAt: "2026-09-01T10:05:00.000Z" }),
    ]);
    rerender(<ConnectionsView />);
    expect(screen.queryByText("Refreshing the account list…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry discovery" })).toBeEnabled();
  });

  it("shows a fixed notice when the retry is refused", async () => {
    setup();
    mockMutation(REFRESH).mockRejectedValue(
      apiError("CONFLICT", "inactive", { reason: "connection_inactive" }),
    );
    renderWithOrg(<ConnectionsView />);
    fireEvent.click(screen.getByRole("button", { name: "Retry discovery" }));
    expect(await screen.findByLabelText("Connection not active")).toBeInTheDocument();
    expect(screen.queryByText("Refreshing the account list…")).not.toBeInTheDocument();
  });
});

describe("linked accounts and sync status", () => {
  const sync = (overrides: Partial<SyncStatus>): SyncStatus => ({
    syncState: "idle",
    consecutiveFailures: 0,
    ...overrides,
  });

  it("says when no Google Ads account is linked (a Meta account is listed only under Meta Ads)", () => {
    setup({ accounts: [adAccount({ id: "m1", platform: "meta", name: "Meta EU" })] });
    renderWithOrg(<ConnectionsView />);
    const google = screen.getByRole("region", { name: "Google Ads" });
    expect(within(google).getByText("No Google Ads account linked yet")).toBeInTheDocument();
    expect(within(google).queryByText("Meta EU")).not.toBeInTheDocument();
    const meta = screen.getByRole("region", { name: "Meta Ads" });
    expect(within(meta).getByText("Meta EU")).toBeInTheDocument();
  });

  it("shows status, coverage, last and next sync, and a View analytics link", () => {
    setUrl("/connections", "preset=last_7_days&platforms=meta");
    setup({
      accounts: [
        adAccount({
          sync: sync({
            lastRunStatus: "succeeded",
            lastSuccessAt: "2026-09-21T08:30:00.000Z",
            nextRunAt: "2026-09-21T09:30:00.000Z",
            coveredFrom: "2026-08-01",
            coveredThrough: "2026-09-20",
          }),
        }),
        adAccount({ id: "a3", name: "Unlinked", linked: false }),
      ],
    });
    renderWithOrg(<ConnectionsView />);
    const table = screen.getByRole("table", { name: /Linked Google Ads accounts/ });
    const row = within(table).getByText("Client Linked").closest("tr") as HTMLElement;
    expect(row).toHaveTextContent("222-000-0003");
    expect(row).toHaveTextContent("Up to date");
    expect(row).toHaveTextContent("Data through 2026-09-20.");
    expect(row).toHaveTextContent("Aug 1, 2026 – Sep 20, 2026");
    expect(row).toHaveTextContent("Sep 21, 2026, 8:30 AM");
    expect(row).toHaveTextContent("Sep 21, 2026, 9:30 AM");
    expect(
      within(row).getByRole("link", { name: "View analytics for Client Linked" }),
    ).toHaveAttribute("href", "/?preset=last_7_days&accounts=a2");
    expect(within(table).queryByText("Unlinked")).not.toBeInTheDocument();
  });

  it.each([
    [undefined, "First sync scheduled"],
    [sync({ syncState: "running" }), "Syncing…"],
    [sync({ syncState: "blocked" }), "Sync blocked"],
    [
      sync({
        lastRunStatus: "failed",
        consecutiveFailures: 2,
        lastError: {
          kind: "unknown",
          message: "raw platform text",
          reason: "cloud_project_not_approved_for_production",
          at: "2026-09-21T08:30:00.000Z",
        },
      }),
      "Last sync failed (2 failures in a row)",
    ],
  ])("shows the sync state (%#)", (state, label) => {
    setup({ accounts: [adAccount({ sync: state })] });
    renderWithOrg(<ConnectionsView />);
    const row = screen.getByText("Client Linked", { selector: "div" }).closest("tr") as HTMLElement;
    expect(row).toHaveTextContent(label);
    expect(row).not.toHaveTextContent("raw platform text");
    if (state === undefined) expect(row).toHaveTextContent("Never");
  });
});
