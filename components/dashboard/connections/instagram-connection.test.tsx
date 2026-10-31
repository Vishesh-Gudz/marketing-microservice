import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SocialAccount } from "@/lib/analytics/organic-types";
import type { Connection, Org } from "@/lib/analytics/types";
import type * as Navigation from "@/lib/connections/navigation";
import { ORG } from "@/tests/unit/analytics-fixtures";
import {
  mockAction,
  mockMutation,
  queryResults,
  renderWithOrg,
  resetHarness,
  setUrl,
} from "@/tests/unit/dashboard-harness";
import { socialAccount } from "@/tests/unit/organic-fixtures";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);
vi.mock("@/lib/connections/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  navigateToAuthorization: vi.fn(),
}));

import { navigateToAuthorization } from "@/lib/connections/navigation";
import { ConnectionsView } from "../views/connections-view";

// ADR 0017: Instagram on /connections, for direct messages. Connect / Reconnect through the
// existing OAuth flow (Unified Login on the server for new Meta apps), link the discovered
// account, see the linked one with the way to its direct messages, and Disconnect.

const BEGIN = "v1/connections:beginConnect";
const DISCONNECT = "v1/connections:disconnect";
const LINK = "v1/connections:linkSocialAccounts";
const IG_CONNECTION_ID = "conn_ig_unified";
const IG_ACCOUNT = "17841400000000301";
const AUTHORIZE_URL = "https://www.facebook.com/dialog/oauth?config_id=1&state=SECRET_STATE";
const VIEWER: Org = { ...ORG, role: "viewer" };
const SCOPES = ["instagram_basic", "instagram_manage_messages"];

function instagramConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: IG_CONNECTION_ID,
    provider: "instagram",
    externalUserId: IG_ACCOUNT,
    displayName: "fake_unified",
    status: "active",
    grantedScopes: SCOPES,
    missingScopes: [],
    expiresSoon: false,
    connectedAt: "2026-10-31T10:00:00.000Z",
    updatedAt: "2026-10-31T10:00:00.000Z",
    ...overrides,
  } as Connection;
}

function linkedAccount(overrides: Partial<SocialAccount> = {}): SocialAccount {
  return socialAccount({
    id: "sa_unified",
    externalId: IG_ACCOUNT,
    username: "fake_unified",
    connectionId: IG_CONNECTION_ID,
    ...overrides,
  });
}

function setup({
  connections = [instagramConnection()],
  accounts = [linkedAccount()],
  discovered = [
    {
      externalId: IG_ACCOUNT,
      platform: "instagram" as const,
      username: "fake_unified",
      accountType: "business" as const,
      linked: true,
      discoveredAt: "2026-10-31T10:00:00.000Z",
    },
  ],
}: {
  connections?: Connection[];
  accounts?: SocialAccount[];
  discovered?: unknown[];
} = {}) {
  queryResults.set("v1/connections:list", connections);
  queryResults.set("v1/adAccounts:list", []);
  queryResults.set("v1/connections:listDiscoveredAssets", []);
  queryResults.set("v1/socialAccounts:list", { page: accounts, isDone: true, continueCursor: "" });
  queryResults.set("v1/connections:listDiscoveredSocialAccounts", discovered);
}

const instagram = () => screen.getByRole("region", { name: "Instagram" });

beforeEach(() => {
  resetHarness();
  setUrl("/connections");
  vi.mocked(navigateToAuthorization).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("Instagram connection", () => {
  it("offers Connect when Instagram is not connected, and starts the Instagram flow once", async () => {
    setup({ connections: [], accounts: [], discovered: [] });
    mockAction(BEGIN).mockResolvedValue({ authorizeUrl: AUTHORIZE_URL, expiresAt: "x" });
    renderWithOrg(<ConnectionsView />);
    const section = instagram();
    expect(within(section).getByText("Instagram is not connected.")).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: /Disconnect/ })).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: "Connect Instagram" }));
    expect(within(section).getByRole("button", { name: "Opening Meta sign-in…" })).toBeDisabled();
    await waitFor(() => expect(navigateToAuthorization).toHaveBeenCalledOnce());
    expect(mockAction(BEGIN)).toHaveBeenCalledExactlyOnceWith({
      provider: "instagram",
      returnUrl: `${window.location.origin}/connections?connect=instagram`,
    });
    // The authorization URL is used, never shown.
    expect(document.body.textContent).not.toContain("SECRET_STATE");
  });

  it("shows the active connection and the linked account with the way to its direct messages", () => {
    setup();
    renderWithOrg(<ConnectionsView />);
    const section = instagram();
    expect(within(section).getByText("Instagram is connected.")).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Reconnect Instagram" })).toBeEnabled();
    const settings = within(section).getByRole("link", {
      name: "Direct messages settings for @fake_unified",
    });
    expect(settings).toHaveAttribute("href", "/instagram/messages/settings");
    expect(within(section).getByText("Linked")).toBeInTheDocument();
    // No permission or token strings are shown.
    expect(section).not.toHaveTextContent(/instagram_basic|instagram_manage_messages/);
  });

  it("links the discovered account", async () => {
    setup({
      accounts: [],
      discovered: [
        {
          externalId: IG_ACCOUNT,
          platform: "instagram",
          username: "fake_unified",
          accountType: "business",
          linked: false,
          discoveredAt: "2026-10-31T10:00:00.000Z",
        },
      ],
    });
    mockMutation(LINK).mockResolvedValue([]);
    renderWithOrg(<ConnectionsView />);
    fireEvent.click(
      within(instagram()).getByRole("button", { name: `Link Instagram account ${IG_ACCOUNT}` }),
    );
    await waitFor(() =>
      expect(mockMutation(LINK)).toHaveBeenCalledExactlyOnceWith({
        connectionId: IG_CONNECTION_ID,
        externalIds: [IG_ACCOUNT],
      }),
    );
    expect(await within(instagram()).findByText("Account linked")).toBeInTheDocument();
  });

  it("disconnects after a confirmation that lists Instagram's consequences", async () => {
    setup();
    mockMutation(DISCONNECT).mockResolvedValue(instagramConnection({ status: "revoked" }));
    renderWithOrg(<ConnectionsView />);
    fireEvent.click(within(instagram()).getByRole("button", { name: "Disconnect Instagram" }));
    const dialog = within(instagram());
    expect(dialog.getByText("Disconnect Instagram?")).toBeInTheDocument();
    expect(
      dialog.getByText("Direct messages for the linked Instagram account stop at once."),
    ).toBeInTheDocument();
    expect(
      dialog.getByText("Its stored conversations and messages are deleted after 30 days."),
    ).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(mockMutation(DISCONNECT)).toHaveBeenCalledExactlyOnceWith({
        connectionId: IG_CONNECTION_ID,
      }),
    );
  });

  it("asks for a reconnect in Meta's words when access was revoked", () => {
    setup({ connections: [instagramConnection({ status: "needs_reauth" })] });
    renderWithOrg(<ConnectionsView />);
    expect(within(instagram()).getByText("Reconnect required")).toBeInTheDocument();
    expect(instagram()).toHaveTextContent("Meta access expired or was revoked.");
  });

  it("is read-only for viewers", () => {
    setup();
    renderWithOrg(<ConnectionsView />, VIEWER);
    const section = instagram();
    expect(
      within(section).getByText("Only organization admins can connect or disconnect Instagram."),
    ).toBeInTheDocument();
    expect(within(section).queryByRole("button")).toBeNull();
    expect(
      within(section).getByRole("link", { name: "Direct messages settings for @fake_unified" }),
    ).toBeInTheDocument();
  });

  it("never shows an Instagram connection's account on another card", () => {
    setup();
    renderWithOrg(<ConnectionsView />);
    for (const name of ["Meta Ads", "Google Ads", "YouTube"]) {
      expect(screen.getByRole("region", { name })).not.toHaveTextContent(/fake_unified/);
    }
  });
});
