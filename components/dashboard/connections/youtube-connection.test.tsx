import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import type { SocialAccount } from "@/lib/analytics/organic-types";
import type { Connection, Org } from "@/lib/analytics/types";
import type * as Navigation from "@/lib/connections/navigation";
import { ORG } from "@/tests/unit/analytics-fixtures";
import {
  lastArgs,
  mockAction,
  mockMutation,
  queryResults,
  renderWithOrg,
  resetHarness,
  setUrl,
} from "@/tests/unit/dashboard-harness";
import { socialAccount } from "@/tests/unit/organic-fixtures";
import { CHANNEL_ID, YT_CONNECTION_ID, youtubeChannel } from "@/tests/unit/youtube-fixtures";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);
vi.mock("@/lib/connections/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  navigateToAuthorization: vi.fn(),
}));

import { navigateToAuthorization } from "@/lib/connections/navigation";
import { ConnectionsView } from "../views/connections-view";

// ADR 0016, Checkpoint 5: YouTube on /connections. Connect / Reconnect through the existing
// OAuth flow, link the discovered channel, and Disconnect, which revokes Google access and
// deletes the channel's stored data: the page claims the deletion only once the server
// confirms it (the channel's row is gone from v1/socialAccounts:list).

const BEGIN = "v1/connections:beginConnect";
const DISCONNECT = "v1/connections:disconnect";
const LINK = "v1/connections:linkSocialAccounts";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth?state=SECRET_STATE";
const VIEWER: Org = { ...ORG, role: "viewer" };
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

function youtubeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: YT_CONNECTION_ID,
    provider: "youtube",
    externalUserId: "UCfakeChannel0000000000a",
    status: "active",
    grantedScopes: SCOPES,
    missingScopes: [],
    expiresSoon: false,
    connectedAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  } as Connection;
}

function setup({
  connections = [youtubeConnection()],
  channels = [youtubeChannel()] as SocialAccount[],
  discovered = [
    {
      externalId: "UCfakeChannel0000000000a",
      platform: "youtube" as const,
      accountType: "channel" as const,
      linked: true,
      discoveredAt: "2026-10-01T10:00:00.000Z",
    },
  ],
} = {}) {
  queryResults.set("v1/connections:list", connections);
  queryResults.set("v1/adAccounts:list", []);
  queryResults.set("v1/connections:listDiscoveredAssets", []);
  queryResults.set("v1/socialAccounts:list", {
    page: [socialAccount(), ...channels],
    isDone: true,
    continueCursor: "",
  });
  queryResults.set("v1/connections:listDiscoveredSocialAccounts", discovered);
}

const youtube = () => screen.getByRole("region", { name: "YouTube" });

beforeEach(() => {
  resetHarness();
  setUrl("/connections");
  vi.mocked(navigateToAuthorization).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("YouTube connection status", () => {
  it("offers Connect when YouTube is not connected, and starts the YouTube flow once", async () => {
    setup({ connections: [], channels: [] });
    mockAction(BEGIN).mockResolvedValue({ authorizeUrl: AUTHORIZE_URL, expiresAt: "x" });
    renderWithOrg(<ConnectionsView />);
    const section = youtube();
    expect(within(section).getByText("YouTube is not connected.")).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: /Disconnect/ })).toBeNull();
    expect(section).not.toHaveTextContent("Disconnecting YouTube");
    fireEvent.click(within(section).getByRole("button", { name: "Connect YouTube" }));
    expect(within(section).getByRole("button", { name: "Opening Google sign-in…" })).toBeDisabled();
    await waitFor(() => expect(navigateToAuthorization).toHaveBeenCalledOnce());
    expect(mockAction(BEGIN)).toHaveBeenCalledExactlyOnceWith({
      provider: "youtube",
      returnUrl: `${window.location.origin}/connections?connect=youtube`,
    });
    // The authorization URL is used, never shown.
    expect(document.body.textContent).not.toContain("SECRET_STATE");
  });

  it("explains in YouTube words when YouTube is not available on this service", async () => {
    setup({ connections: [], channels: [] });
    mockAction(BEGIN).mockRejectedValue(
      apiError("INVALID_ARGUMENT", "server text", { field: "provider" }),
    );
    renderWithOrg(<ConnectionsView />);
    fireEvent.click(within(youtube()).getByRole("button", { name: "Connect YouTube" }));
    expect(await within(youtube()).findByLabelText("YouTube is not available")).toHaveTextContent(
      "YouTube cannot be connected on this service yet.",
    );
    expect(document.body.textContent).not.toContain("server text");
  });

  it("shows the connected channel without any credential, scope string or token", () => {
    setup();
    renderWithOrg(<ConnectionsView />);
    const section = youtube();
    expect(within(section).getByLabelText("Connected")).toHaveTextContent("YouTube is connected.");
    const linked = within(section).getByRole("region", { name: "Linked channel" });
    expect(linked).toHaveTextContent("Fake Brand @fakebrand");
    expect(linked).toHaveTextContent("channel days through Oct 17, 2026 (Pacific Time)");
    expect(
      within(linked).getByRole("link", { name: "View YouTube analytics for Fake Brand" }),
    ).toHaveAttribute("href", `/social?platform=youtube&account=${CHANNEL_ID}`);
    const text = section.textContent ?? "";
    expect(text).not.toMatch(/googleapis|token|secret|credential/i);
  });

  it("states missing YouTube Analytics access (videos keep syncing); Reconnect adds it", async () => {
    setup({
      connections: [
        youtubeConnection({ missingScopes: [SCOPES[1]!], grantedScopes: [SCOPES[0]!] }),
      ],
    });
    mockAction(BEGIN).mockResolvedValue({ authorizeUrl: AUTHORIZE_URL, expiresAt: "x" });
    renderWithOrg(<ConnectionsView />);
    const section = youtube();
    expect(
      within(section).getByLabelText("YouTube Analytics access is missing"),
    ).toBeInTheDocument();
    expect(section).toHaveTextContent(
      "The channel's videos and their statistics keep syncing; only the daily channel metrics wait for this access.",
    );
    expect(section).not.toHaveTextContent("stop updating");
    fireEvent.click(within(section).getByRole("button", { name: "Reconnect YouTube" }));
    await waitFor(() => expect(navigateToAuthorization).toHaveBeenCalledOnce());
    expect(mockAction(BEGIN)).toHaveBeenCalledExactlyOnceWith({
      provider: "youtube",
      returnUrl: `${window.location.origin}/connections?connect=youtube`,
      reconnectConnectionId: YT_CONNECTION_ID,
    });
  });

  it("asks to reconnect when authorization is required", () => {
    setup({ connections: [youtubeConnection({ status: "needs_reauth" })] });
    renderWithOrg(<ConnectionsView />);
    expect(within(youtube()).getByLabelText("Reconnect required")).toHaveTextContent(
      "Google access expired or was revoked. Reconnect with the same Google account",
    );
    expect(within(youtube()).getByRole("button", { name: "Reconnect YouTube" })).toBeEnabled();
  });

  it("shows a viewer the status and the channel, but no actions and no discovery", () => {
    setup();
    renderWithOrg(<ConnectionsView />, VIEWER);
    const section = youtube();
    expect(within(section).queryByRole("button")).toBeNull();
    expect(section).toHaveTextContent(
      "Only organization admins can connect or disconnect YouTube.",
    );
    expect(lastArgs("v1/connections:listDiscoveredSocialAccounts")).toBeUndefined();
    expect(within(section).getByRole("region", { name: "Linked channel" })).toBeInTheDocument();
  });
});

describe("linking the channel", () => {
  const unlinked = [
    {
      externalId: "UCfakeChannel0000000000a",
      platform: "youtube" as const,
      accountType: "channel" as const,
      linked: false,
      discoveredAt: "2026-10-01T10:00:00.000Z",
    },
  ];

  it("links the discovered channel once", async () => {
    setup({ channels: [], discovered: unlinked });
    mockMutation(LINK).mockResolvedValue([youtubeChannel()]);
    renderWithOrg(<ConnectionsView />);
    fireEvent.click(
      within(youtube()).getByRole("button", {
        name: "Link YouTube channel UCfakeChannel0000000000a",
      }),
    );
    expect(await within(youtube()).findByLabelText("Channel linked")).toHaveTextContent(
      "about 3 days late",
    );
    expect(mockMutation(LINK)).toHaveBeenCalledExactlyOnceWith({
      connectionId: YT_CONNECTION_ID,
      externalIds: ["UCfakeChannel0000000000a"],
    });
  });

  it("explains purge_pending: the channel's data is still being deleted", async () => {
    setup({ channels: [], discovered: unlinked });
    mockMutation(LINK).mockRejectedValue(
      apiError("CONFLICT", "server text", { reason: "purge_pending", externalId: "UCx" }),
    );
    renderWithOrg(<ConnectionsView />);
    fireEvent.click(within(youtube()).getByRole("button", { name: /Link YouTube channel/ }));
    expect(
      await within(youtube()).findByLabelText("Stored data is still being deleted"),
    ).toHaveTextContent("Try again in a few minutes.");
    expect(document.body.textContent).not.toContain("server text");
  });
});

describe("disconnecting YouTube deletes the stored data", () => {
  it("says what disconnecting deletes before and in the confirmation; Cancel changes nothing", () => {
    setup();
    renderWithOrg(<ConnectionsView />);
    const section = youtube();
    expect(section).toHaveTextContent(
      "Disconnecting YouTube revokes this service's Google access and deletes the channel's stored YouTube data",
    );
    fireEvent.click(within(section).getByRole("button", { name: "Disconnect YouTube" }));
    const confirmation = within(section).getByRole("group", { name: "Disconnect YouTube?" });
    expect(confirmation).toHaveTextContent("is deleted. This cannot be undone.");
    expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(mockMutation(DISCONNECT)).not.toHaveBeenCalled();
  });

  it("reports the deletion in progress, and complete only once the server confirms it", async () => {
    setup();
    mockMutation(DISCONNECT).mockImplementation(async () => {
      // The live queries: the connection is revoked; the channel row stays (being deleted).
      queryResults.set("v1/connections:list", [youtubeConnection({ status: "revoked" })]);
      queryResults.set("v1/socialAccounts:list", {
        page: [
          socialAccount(),
          youtubeChannel({ status: "disconnected", linked: false, connectionId: undefined }),
        ],
        isDone: true,
        continueCursor: "",
      });
      return youtubeConnection({ status: "revoked" });
    });
    const { rerender } = renderWithOrg(<ConnectionsView />);
    fireEvent.click(within(youtube()).getByRole("button", { name: "Disconnect YouTube" }));
    fireEvent.click(within(youtube()).getByRole("button", { name: "Disconnect and delete data" }));

    const status = await within(youtube()).findByTestId("youtube-deletion-status");
    expect(status).toHaveTextContent("Deleting stored YouTube data…");
    expect(status).not.toHaveTextContent("Stored YouTube data deleted");
    expect(mockMutation(DISCONNECT)).toHaveBeenCalledExactlyOnceWith({
      connectionId: YT_CONNECTION_ID,
    });
    expect(within(youtube()).getByText("YouTube is not connected.")).toBeInTheDocument();

    // The server finishes: the channel's row is gone.
    queryResults.set("v1/socialAccounts:list", {
      page: [socialAccount()],
      isDone: true,
      continueCursor: "",
    });
    rerender(<ConnectionsView />);
    expect(within(youtube()).getByTestId("youtube-deletion-status")).toHaveTextContent(
      "Stored YouTube data deleted",
    );
    // Instagram's account is untouched by the YouTube card.
    expect(lastArgs("v1/socialAccounts:list")).toEqual({
      paginationOpts: { numItems: 100, cursor: null },
    });
  });

  it("keeps the connection and shows a fixed notice when disconnect fails", async () => {
    setup();
    mockMutation(DISCONNECT).mockRejectedValue(apiError("FORBIDDEN", "server text"));
    renderWithOrg(<ConnectionsView />);
    fireEvent.click(within(youtube()).getByRole("button", { name: "Disconnect YouTube" }));
    fireEvent.click(within(youtube()).getByRole("button", { name: "Disconnect and delete data" }));
    expect(await within(youtube()).findByLabelText("Admins only")).toHaveTextContent(
      "Only organization admins can disconnect YouTube.",
    );
    expect(within(youtube()).queryByTestId("youtube-deletion-status")).toBeNull();
    expect(document.body.textContent).not.toContain("server text");
  });

  it("shows a deletion this page did not start", () => {
    setup({
      connections: [],
      channels: [
        youtubeChannel({ status: "disconnected", linked: false, connectionId: undefined }),
      ],
    });
    renderWithOrg(<ConnectionsView />);
    expect(within(youtube()).getByRole("status")).toHaveTextContent(
      "The stored data of 1 channel is being deleted",
    );
  });
});
