import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstagramConversation } from "@/lib/instagram/types";
import {
  lastArgs,
  loadMoreMock,
  queryResults,
  renderWithOrg,
  resetHarness,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import InstagramMessagesPage, { metadata } from "@/app/(dashboard)/instagram/messages/page";
import { InstagramInboxView } from "./instagram-inbox-view";

// The Instagram DM inbox (ADR 0017, IM5) through the dashboard harness: the org's
// conversations, newest first, with each one's reply state.

const LIST = "v1/instagramMessaging:listConversations";
const NOW = Date.parse("2026-10-30T12:00:00.000Z");

function conversation(overrides: Partial<InstagramConversation> = {}): InstagramConversation {
  return {
    id: "conv1",
    messagingAccountId: "acct1",
    accountUsername: "shop",
    contactUsername: "ana.shop",
    lastMessageAt: "2026-10-30T11:30:00.000Z",
    lastInboundAt: "2026-10-30T11:00:00.000Z",
    replyWindowExpiresAt: "2026-10-31T11:00:00.000Z",
    ...overrides,
  };
}

function page(conversations: InstagramConversation[], isDone = true) {
  return { page: conversations, isDone, continueCursor: isDone ? "" : "c1" };
}

beforeEach(() => {
  resetHarness();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Instagram DM inbox", () => {
  it("is the /instagram/messages route and pages through the conversations", () => {
    expect(metadata.title).toBe("Instagram DMs");
    queryResults.set(LIST, page([]));
    renderWithOrg(<InstagramMessagesPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Instagram DMs" })).toBeInTheDocument();
    expect(lastArgs(LIST)).toEqual({ paginationOpts: { numItems: 25, cursor: null } });
  });

  it("shows a labelled placeholder while loading", () => {
    renderWithOrg(<InstagramInboxView />);
    expect(screen.getByRole("status", { name: "Loading conversations" })).toBeInTheDocument();
  });

  it("explains an empty inbox and links to the settings", () => {
    queryResults.set(LIST, page([]));
    renderWithOrg(<InstagramInboxView />);
    expect(screen.getByText("No conversations yet")).toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: "Instagram DM settings" })) {
      expect(link).toHaveAttribute("href", "/instagram/messages/settings");
    }
  });

  it("lists each conversation with its contact, account and reply state", () => {
    queryResults.set(
      LIST,
      page([
        conversation(),
        conversation({
          id: "conv2",
          contactUsername: undefined,
          contactName: undefined,
          replyWindowExpiresAt: "2026-10-30T11:59:00.000Z",
        }),
        conversation({ id: "conv3", contactUsername: "ben", replyBlocker: "scope_missing" }),
      ]),
    );
    renderWithOrg(<InstagramInboxView />);
    const items = within(screen.getByRole("list", { name: "Conversations" })).getAllByRole("link");
    expect(items.map((item) => item.getAttribute("href"))).toEqual([
      "/instagram/messages/conversations/conv1",
      "/instagram/messages/conversations/conv2",
      "/instagram/messages/conversations/conv3",
    ]);
    expect(items[0]).toHaveTextContent("@ana.shop");
    expect(items[0]).toHaveTextContent("To @shop");
    expect(items[0]).toHaveTextContent("Reply window open");
    expect(items[1]).toHaveTextContent("Instagram user");
    expect(items[1]).toHaveTextContent("Reply window closed");
    expect(items[2]).toHaveTextContent("Replies unavailable");
  });

  it("loads more conversations on request", async () => {
    queryResults.set(LIST, page([conversation()], false));
    renderWithOrg(<InstagramInboxView />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Show more conversations" })),
    );
    expect(loadMoreMock).toHaveBeenCalledWith(25);
  });

  it("shows a failed listing as an error, not as an empty inbox", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    queryResults.set(LIST, () => {
      throw new Error("boom");
    });
    renderWithOrg(<InstagramInboxView />);
    expect(screen.queryByText("No conversations yet")).toBeNull();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
