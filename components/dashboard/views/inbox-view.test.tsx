import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxThread } from "@/lib/inbox/threads";
import {
  lastArgs,
  loadMoreMock,
  queryResults,
  renderWithOrg,
  resetHarness,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import InboxPage, { metadata } from "@/app/(dashboard)/(inbox)/inbox/page";
import { InboxView } from "./inbox-view";

// The unified inbox (ADR 0018, IM7.4) through the dashboard harness: every channel's
// conversations, newest first, with the channel filter, each opening the channel's own page.

const LIST = "v1/inbox:listThreads";
const NOW = Date.parse("2026-10-30T12:00:00.000Z");

function thread(overrides: Partial<InboxThread> = {}): InboxThread {
  return {
    id: "t1",
    channel: "whatsapp",
    conversationId: "wa1",
    accountLabel: "+1 555-000-0001",
    contactLabel: "Ana",
    lastMessageAt: "2026-10-30T11:30:00.000Z",
    lastInboundAt: "2026-10-30T11:00:00.000Z",
    replyState: "open",
    replyWindowExpiresAt: "2026-10-31T11:00:00.000Z",
    ...overrides,
  };
}

function page(threads: InboxThread[], isDone = true) {
  return { page: threads, isDone, continueCursor: isDone ? "" : "c1" };
}

beforeEach(() => {
  resetHarness();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const rows = () => within(screen.getByRole("list", { name: "Conversations" })).getAllByRole("link");

describe("unified inbox", () => {
  it("is the /inbox route: the list (in the workspace) pages through every channel", () => {
    expect(metadata.title).toBe("Inbox");
    // The page itself is the pane beside the list, before a conversation is chosen.
    renderWithOrg(<InboxPage />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Choose a conversation" }),
    ).toBeInTheDocument();
    queryResults.set(LIST, page([]));
    renderWithOrg(<InboxView />);
    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Saved replies" })).toHaveAttribute(
      "href",
      "/inbox/saved-replies",
    );
    expect(lastArgs(LIST)).toEqual({ paginationOpts: { numItems: 25, cursor: null } });
  });

  it("shows a labelled placeholder while loading, and explains an empty inbox", () => {
    renderWithOrg(<InboxView />);
    expect(screen.getByRole("status", { name: "Loading conversations" })).toBeInTheDocument();
    queryResults.set(LIST, page([]));
    renderWithOrg(<InboxView />);
    expect(screen.getAllByText("No conversations yet")[0]).toBeInTheDocument();
  });

  it("lists both channels with their badge, labels and reply state, linking to their own pages", () => {
    queryResults.set(
      LIST,
      page([
        thread({
          id: "t2",
          channel: "instagram",
          conversationId: "ig1",
          accountLabel: "@shop",
          contactLabel: "@ana.lisboa",
          replyState: "unavailable",
        }),
        thread(),
        thread({
          id: "t3",
          conversationId: "wa2",
          contactLabel: "+15550002222",
          replyState: "closed",
          replyWindowExpiresAt: "2026-10-29T11:00:00.000Z",
        }),
      ]),
    );
    renderWithOrg(<InboxView />);
    const links = rows();
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/instagram/messages/conversations/ig1",
      "/whatsapp/conversations/wa1",
      "/whatsapp/conversations/wa2",
    ]);
    expect(links[0]).toHaveTextContent("Instagram");
    expect(links[0]).toHaveTextContent("@ana.lisboa");
    expect(links[0]).toHaveTextContent("To @shop");
    expect(links[0]).toHaveTextContent("Replies unavailable");
    expect(links[1]).toHaveTextContent("WhatsApp");
    expect(links[1]).toHaveTextContent("To +1 555-000-0001");
    expect(links[1]).toHaveTextContent("Reply window open");
    expect(links[2]).toHaveTextContent("Reply window closed");
  });

  it("re-checks an open window on its own clock and never upgrades a state", () => {
    queryResults.set(
      LIST,
      page([
        // Evaluated open by the server, but the window has passed since.
        thread({ id: "t1", replyWindowExpiresAt: "2026-10-30T11:59:00.000Z" }),
        // Closed or unavailable stay so, whatever the window says.
        thread({ id: "t2", conversationId: "wa2", replyState: "closed" }),
        thread({ id: "t3", conversationId: "wa3", replyState: "unavailable" }),
      ]),
    );
    renderWithOrg(<InboxView />);
    const [expired, closed, unavailable] = rows();
    expect(expired).toHaveTextContent("Reply window closed");
    expect(closed).toHaveTextContent("Reply window closed");
    expect(unavailable).toHaveTextContent("Replies unavailable");
    expect(screen.queryByText("Reply window open")).toBeNull();
  });

  it("is a level-2 heading while a conversation is open beside it", () => {
    queryResults.set(LIST, page([thread()]));
    renderWithOrg(<InboxView headingLevel={2} />);
    expect(screen.getByRole("heading", { level: 2, name: "Inbox" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("loads more on request, and shows a failure as an error", async () => {
    queryResults.set(LIST, page([thread()], false));
    renderWithOrg(<InboxView />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Show more conversations" })),
    );
    expect(loadMoreMock).toHaveBeenCalledWith(25);

    vi.spyOn(console, "error").mockImplementation(() => {});
    queryResults.set(LIST, () => {
      throw new Error("boom");
    });
    renderWithOrg(<InboxView />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
