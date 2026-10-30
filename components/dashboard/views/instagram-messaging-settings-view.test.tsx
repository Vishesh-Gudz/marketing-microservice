import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import type { Org } from "@/lib/analytics/types";
import type { MessagingAvailability } from "@/lib/instagram/types";
import { ORG } from "@/tests/unit/analytics-fixtures";
import {
  mockAction,
  mockMutation,
  queryResults,
  renderWithOrg,
  resetHarness,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import InstagramMessagingSettingsPage, {
  metadata,
} from "@/app/(dashboard)/instagram/messages/settings/page";
import { InstagramMessagingSettingsView } from "./instagram-messaging-settings-view";

// Instagram DM settings (ADR 0017, IM5) through the dashboard harness: every linked Instagram
// account with its messaging state, and the admin controls that state allows.

const SOCIAL = "v1/socialAccounts:list";
const ACCOUNTS = "v1/instagramMessaging:listAccounts";
const AVAILABILITY = "v1/instagramMessaging:getAvailability";
const ENABLE = "v1/instagramMessaging:enable";
const RETRY = "v1/instagramMessaging:retrySetup";
const DISABLE = "v1/instagramMessaging:disable";
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const EDITOR: Org = { ...ORG, role: "editor" };

function social(id: string, username: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    platform: "instagram",
    externalId: `1784140000000${id.length}`,
    username,
    name: username,
    accountType: "business",
    status: "active",
    linked: true,
    connectionId: `c-${id}`,
    ...overrides,
  };
}

function setup(
  states: Record<string, MessagingAvailability>,
  messaging: Record<string, unknown>[] = [],
  org: Org = ORG,
) {
  queryResults.set(SOCIAL, {
    page: Object.keys(states).map((id) => social(id, `shop_${id}`)),
    isDone: true,
    continueCursor: "",
  });
  queryResults.set(ACCOUNTS, messaging);
  queryResults.set(
    AVAILABILITY,
    (args: Record<string, unknown>) => states[String(args.socialAccountId)],
  );
  return renderWithOrg(<InstagramMessagingSettingsView />, org);
}

const row = (username: string) =>
  screen.getByRole("heading", { level: 3, name: `@${username}` }).closest("li")!;

beforeEach(() => {
  resetHarness();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Instagram DM settings", () => {
  it("is the settings route under the inbox", () => {
    expect(metadata.title).toBe("Instagram DM settings");
    setup({});
    renderWithOrg(<InstagramMessagingSettingsPage />);
    const crumbs = screen.getAllByRole("navigation", { name: "Breadcrumb" })[0]!;
    expect(within(crumbs).getByRole("link", { name: "Instagram DMs" })).toHaveAttribute(
      "href",
      "/instagram/messages",
    );
  });

  it("shows a labelled placeholder while loading, and explains when no account is linked", () => {
    renderWithOrg(<InstagramMessagingSettingsView />);
    expect(screen.getByRole("status", { name: "Loading Instagram accounts" })).toBeInTheDocument();
    setup({});
    expect(screen.getByText("No Instagram account linked")).toBeInTheDocument();
  });

  it("explains every state, with only the controls it allows", () => {
    setup(
      {
        a: { availability: "ready" },
        b: { availability: "active", accountId: "acct-b" },
        c: { availability: "action_required", accountId: "acct-c" },
        d: { availability: "unavailable" },
        e: { availability: "scope_missing" },
        f: { availability: "connection_inactive" },
        g: { availability: "in_use" },
        h: {
          availability: "purge_in_progress",
          accountId: "acct-h",
          purgeAfter: "2026-10-29T00:00:00.000Z",
        },
      },
      [
        {
          id: "acct-c",
          socialAccountId: "c",
          status: "action_required",
          activatedAt: "x",
          setupReason: "timeout",
        },
      ],
    );
    expect(within(row("shop_a")).getByText("Off")).toBeInTheDocument();
    expect(
      within(row("shop_a")).getByRole("button", { name: "Turn on direct messages" }),
    ).toBeInTheDocument();
    expect(within(row("shop_b")).getByText("On")).toBeInTheDocument();
    expect(within(row("shop_b")).getByRole("button", { name: "Turn off" })).toBeInTheDocument();
    expect(within(row("shop_c")).getByText("Needs attention")).toBeInTheDocument();
    expect(row("shop_c")).toHaveTextContent("did not answer as expected");
    expect(within(row("shop_c")).getByRole("button", { name: "Retry setup" })).toBeInTheDocument();
    expect(row("shop_d")).toHaveTextContent("not available on this deployment yet");
    expect(row("shop_e")).toHaveTextContent("Reconnect Instagram with direct messages allowed");
    expect(row("shop_f")).toHaveTextContent("Reconnect needed");
    expect(row("shop_g")).toHaveTextContent("Another organization receives");
    expect(row("shop_h")).toHaveTextContent("being deleted");
    for (const name of ["shop_d", "shop_e", "shop_f", "shop_g", "shop_h"]) {
      expect(within(row(name)).queryByRole("button")).toBeNull();
    }
  });

  it("shows editors the states but no controls", () => {
    setup(
      { a: { availability: "ready" }, b: { availability: "active", accountId: "acct-b" } },
      [],
      EDITOR,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getAllByText("Only organization admins can turn direct messages on or off."),
    ).toHaveLength(2);
  });

  it("says until when an account's earlier conversations are kept", () => {
    setup({
      a: { availability: "ready", accountId: "acct-a", purgeAfter: "2026-11-20T12:00:00.000Z" },
    });
    expect(row("shop_a")).toHaveTextContent("kept until");
  });
});

describe("admin controls", () => {
  it("turns direct messages on once and announces the result", async () => {
    let resolve: (value: unknown) => void = () => {};
    const enable = mockAction(ENABLE).mockImplementation(() => new Promise((r) => (resolve = r)));
    setup({ a: { availability: "ready" } });
    const button = within(row("shop_a")).getByRole("button", { name: "Turn on direct messages" });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(enable).toHaveBeenCalledTimes(1);
    expect(enable).toHaveBeenCalledWith({ socialAccountId: "a" });
    await act(async () => resolve({ accountId: "acct-a", status: "active" }));
    const notice = screen.getByLabelText("Direct messages are on");
    expect(notice.closest("[tabindex='-1']")).toHaveFocus();
  });

  it("shows a refused turn-on and a failed setup in fixed words", async () => {
    mockAction(ENABLE)
      .mockRejectedValueOnce(apiError("CONFLICT", "server words", { reason: "in_use" }))
      .mockResolvedValueOnce({
        accountId: "acct-a",
        status: "action_required",
        setupReason: "meta_190",
      });
    setup({ a: { availability: "ready" } });
    const button = within(row("shop_a")).getByRole("button", { name: "Turn on direct messages" });
    await act(async () => fireEvent.click(button));
    expect(screen.getByLabelText("Used by another organization")).not.toHaveTextContent(
      "server words",
    );
    await act(async () => fireEvent.click(button));
    expect(screen.getByLabelText("Setup did not finish")).toHaveTextContent("Reconnect");
  });

  it("retries a setup that needs attention", async () => {
    const retry = mockAction(RETRY).mockResolvedValue({ accountId: "acct-c", status: "active" });
    setup({ c: { availability: "action_required", accountId: "acct-c" } });
    await act(async () =>
      fireEvent.click(within(row("shop_c")).getByRole("button", { name: "Retry setup" })),
    );
    expect(retry).toHaveBeenCalledWith({ accountId: "acct-c" });
    expect(screen.getByLabelText("Direct messages are on")).toBeInTheDocument();
  });

  it("turns direct messages off only after a confirmation that explains the 30 days", async () => {
    const disable = mockMutation(DISABLE).mockResolvedValue({
      id: "acct-b",
      socialAccountId: "b",
      status: "disabled",
      activatedAt: "2026-10-01T00:00:00.000Z",
      purgeAfter: "2026-11-29T12:00:00.000Z",
    });
    setup({ b: { availability: "active", accountId: "acct-b" } });
    await act(async () =>
      fireEvent.click(within(row("shop_b")).getByRole("button", { name: "Turn off" })),
    );
    const confirm = screen.getByRole("group", { name: "Turn off direct messages for @shop_b?" });
    expect(confirm).toHaveTextContent("kept for 30 days, then deleted");
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(disable).not.toHaveBeenCalled();

    // Escape closes it without doing anything.
    await act(async () => fireEvent.keyDown(confirm, { key: "Escape" }));
    expect(screen.queryByRole("group")).toBeNull();

    await act(async () =>
      fireEvent.click(within(row("shop_b")).getByRole("button", { name: "Turn off" })),
    );
    const again = screen.getByRole("group");
    await act(async () => fireEvent.click(within(again).getByRole("button", { name: "Turn off" })));
    expect(disable).toHaveBeenCalledTimes(1);
    expect(disable).toHaveBeenCalledWith({ accountId: "acct-b" });
    expect(screen.getByLabelText("Direct messages are off")).toHaveTextContent("kept until");
  });
});
