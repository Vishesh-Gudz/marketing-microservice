import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryResults, renderWithOrg, resetHarness, setUrl } from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import { InboxWorkspace } from "./workspace";

// Kinso K2: the inbox workspace (rail, list, pane). The lists and conversations are tested in
// their own views; this checks how they sit together.

const THREADS = "v1/inbox:listThreads";
const WHATSAPP = "v1/whatsapp:listConversations";
const INSTAGRAM = "v1/instagramMessaging:listConversations";

const thread = {
  id: "t1",
  channel: "whatsapp",
  conversationId: "conv1",
  accountLabel: "+1 555-000-0001",
  contactLabel: "Ana",
  lastMessageAt: "2026-10-24T11:30:00.000Z",
  replyState: "open",
};
const empty = { page: [], isDone: true, continueCursor: "" };

beforeEach(() => {
  resetHarness();
  queryResults.set(THREADS, { page: [thread], isDone: true, continueCursor: "" });
  queryResults.set(WHATSAPP, empty);
  queryResults.set(INSTAGRAM, empty);
});

const rail = () => screen.getAllByRole("navigation", { name: "Inbox lists" })[0]!;

describe("inbox workspace", () => {
  it("shows the list beside the pane, the rail on the list you are in", () => {
    setUrl("/inbox");
    renderWithOrg(
      <InboxWorkspace>
        <p>pane</p>
      </InboxWorkspace>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByText("pane")).toBeInTheDocument();
    expect(within(rail()).getByRole("link", { name: "All" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(rail()).getByRole("link", { name: "WhatsApp" })).toHaveAttribute(
      "href",
      "/whatsapp",
    );
    expect(within(rail()).getByRole("link", { name: "Instagram" })).toHaveAttribute(
      "href",
      "/instagram/messages",
    );
  });

  it("keeps the list you came from when a conversation opens, and selects its row", () => {
    setUrl("/inbox");
    const { rerender } = renderWithOrg(
      <InboxWorkspace>
        <p>pane</p>
      </InboxWorkspace>,
    );
    setUrl("/whatsapp/conversations/conv1");
    rerender(
      <InboxWorkspace>
        <h1>Ana</h1>
      </InboxWorkspace>,
    );
    // Still the unified list, now a level-2 heading beside the conversation's own h1.
    expect(screen.getByRole("heading", { level: 2, name: "Inbox" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Ana"]);
    const row = within(screen.getByRole("list", { name: "Conversations" })).getByRole("link");
    expect(row).toHaveAttribute("href", "/whatsapp/conversations/conv1");
    expect(row).toHaveAttribute("aria-current", "page");
  });

  it("shows a conversation opened directly beside its own channel's list", () => {
    setUrl("/instagram/messages/conversations/ig1");
    renderWithOrg(
      <InboxWorkspace>
        <p>pane</p>
      </InboxWorkspace>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Instagram DMs" })).toBeInTheDocument();
    expect(within(rail()).getByRole("link", { name: "Instagram" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
