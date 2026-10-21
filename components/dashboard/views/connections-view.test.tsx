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
    expect(lastArgs(DISCOVERED)).toBeUndefined();
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
      returnUrl: `${window.location.origin}/connections?preset=last_7_days`,
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
      returnUrl: `${window.location.origin}/connections`,
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

describe("OAuth callback result", () => {
  it("confirms a connection, shows that connection, and removes the parameters (filters stay)", () => {
    setUrl("/connections", `preset=last_7_days&status=connected&connection=${C1}`);
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
    setUrl("/connections", `status=connected&connection=${C1}&warning=discovery_failed`);
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
    setUrl("/connections", `status=error&error=${code}`);
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

  it("says when no Google Ads account is linked (other platforms are not listed)", () => {
    setup({ accounts: [adAccount({ id: "m1", platform: "meta", name: "Meta EU" })] });
    renderWithOrg(<ConnectionsView />);
    expect(screen.getByText("No Google Ads account linked yet")).toBeInTheDocument();
    expect(screen.queryByText("Meta EU")).not.toBeInTheDocument();
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
