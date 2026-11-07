import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import type { WhatsAppConversation, WhatsAppMessage } from "@/lib/whatsapp/types";
import { ORG } from "@/tests/unit/analytics-fixtures";
import {
  lastArgs,
  loadMoreMock,
  notFoundMock,
  queryResults,
  renderWithOrg,
  resetHarness,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import WhatsAppConversationPage, {
  metadata,
} from "@/app/(dashboard)/(inbox)/whatsapp/conversations/[conversationId]/page";
import { clockTime } from "@/lib/inbox/conversation-time";
import { formatInstant } from "../freshness-note";
import { InboxListContext } from "../messaging/inbox-context";
import { WhatsAppConversationView } from "./whatsapp-conversation-view";

// One WhatsApp conversation (ADR 0013): its messages oldest at the top, each outbound message's
// status, and the reply window. Read through the dashboard harness.

const GET = "v1/whatsapp:getConversation";
const MESSAGES = "v1/whatsapp:listMessages";
const NOW = Date.parse("2026-10-24T12:00:00.000Z");

function conversation(overrides: Partial<WhatsAppConversation> = {}): WhatsAppConversation {
  return {
    id: "conv1",
    phoneNumberId: "200000000000001",
    displayPhoneNumber: "+1 555-000-0001",
    contactWaId: "15550001111",
    contactName: "Ana",
    lastMessageAt: "2026-10-24T11:30:00.000Z",
    lastInboundAt: "2026-10-24T11:00:00.000Z",
    serviceWindowExpiresAt: "2026-10-25T11:00:00.000Z",
    ...overrides,
  };
}

function message(overrides: Partial<WhatsAppMessage>): WhatsAppMessage {
  return {
    id: "m1",
    conversationId: "conv1",
    direction: "inbound",
    type: "text",
    text: "Hello",
    status: "received",
    at: "2026-10-24T11:00:00.000Z",
    ...overrides,
  };
}

function page(messages: WhatsAppMessage[], isDone = true) {
  return { page: messages, isDone, continueCursor: isDone ? "" : "c1" };
}

/** A message's meta line as text: who, the clock time, the full time (for screen readers). */
function meta(sender: string, at: string, note?: string): string {
  return `${sender} · ${clockTime(at, ORG.timezone)}${formatInstant(at, ORG.timezone)}${
    note !== undefined ? ` · ${note}` : ""
  }`;
}

beforeEach(() => {
  resetHarness();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WhatsApp conversation", () => {
  it("is the /whatsapp/conversations/[conversationId] route, passing the id through", async () => {
    expect(metadata.title).toBe("WhatsApp conversation");
    queryResults.set(GET, (args: Record<string, unknown>) =>
      conversation({ id: String(args.conversationId) }),
    );
    queryResults.set(MESSAGES, page([]));
    renderWithOrg(
      await WhatsAppConversationPage({
        params: Promise.resolve({ conversationId: "conv42" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(lastArgs(GET)).toEqual({ conversationId: "conv42" });
    expect(lastArgs(MESSAGES)).toEqual({
      conversationId: "conv42",
      paginationOpts: { numItems: 30, cursor: null },
    });
  });

  it("shows labelled placeholders while loading", () => {
    renderWithOrg(<WhatsAppConversationView conversationId="conv1" />);
    expect(screen.getByRole("status", { name: "Loading conversation" })).toBeInTheDocument();
    queryResults.set(GET, conversation());
    renderWithOrg(<WhatsAppConversationView conversationId="conv1" />);
    expect(screen.getByRole("status", { name: "Loading messages" })).toBeInTheDocument();
  });

  it("names the contact and the number, links back to its list and shows the open window", () => {
    queryResults.set(GET, conversation());
    queryResults.set(MESSAGES, page([message({})]));
    renderWithOrg(<WhatsAppConversationView conversationId="conv1" />);
    expect(screen.getByRole("heading", { level: 1, name: "Ana" })).toBeInTheDocument();
    expect(screen.getByText("WhatsApp conversation on +1 555-000-0001")).toBeInTheDocument();
    // Outside the workspace's unified list, back goes to the channel's own list.
    expect(screen.getByRole("link", { name: "Back to WhatsApp" })).toHaveAttribute(
      "href",
      "/whatsapp",
    );
    // The chip counts down; the exact end is in its title and in the details.
    const until = formatInstant("2026-10-25T11:00:00.000Z", ORG.timezone);
    const chip = screen.getByText("Reply window open");
    expect(chip).toHaveTextContent(/^Reply window open\s*· 23h left$/);
    expect(chip).toHaveAttribute("title", `Free-form replies are possible until ${until}.`);
    expect(screen.getByRole("complementary", { name: "Conversation details" })).toHaveTextContent(
      `Free-form replies until${until}`,
    );
  });

  it("goes back to the list it was opened from in the inbox workspace (D-M12)", () => {
    queryResults.set(GET, conversation());
    queryResults.set(MESSAGES, page([message({})]));
    renderWithOrg(
      <InboxListContext value="inbox">
        <WhatsAppConversationView conversationId="conv1" />
      </InboxListContext>,
    );
    expect(screen.getByRole("link", { name: "Back to Inbox" })).toHaveAttribute("href", "/inbox");
  });

  it.each([
    [
      "the window has closed",
      { serviceWindowExpiresAt: "2026-10-24T11:59:59.000Z" },
      "The customer last wrote more than 24 hours ago: only approved templates can be sent.",
    ],
    [
      "the customer has not written",
      { serviceWindowExpiresAt: undefined, lastInboundAt: undefined },
      "The customer has not written yet: only approved templates can be sent.",
    ],
  ])("says templates only when %s", (_label, overrides, text) => {
    queryResults.set(GET, conversation(overrides));
    queryResults.set(MESSAGES, page([]));
    renderWithOrg(<WhatsAppConversationView conversationId="conv1" />);
    expect(screen.getByText("Templates only")).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("shows the thread oldest at the top, with who wrote, when, and each reply's status", () => {
    queryResults.set(GET, conversation());
    // The API lists newest first.
    queryResults.set(
      MESSAGES,
      page([
        message({
          id: "m4",
          direction: "outbound",
          type: "template",
          text: "Hi Ana, your order A-1 has shipped.",
          template: { name: "order_update", language: "en_US" },
          status: "read",
          at: "2026-10-24T11:20:00.000Z",
        }),
        message({
          id: "m3",
          direction: "outbound",
          text: "Checking now",
          status: "failed",
          errorCode: 131047,
          at: "2026-10-24T11:10:00.000Z",
        }),
        message({ id: "m2", type: "image", text: undefined, at: "2026-10-24T11:05:00.000Z" }),
        message({ id: "m1", text: "<b>Where</b> is\nmy order?" }),
      ]),
    );
    renderWithOrg(<WhatsAppConversationView conversationId="conv1" />);
    const items = within(screen.getByRole("list", { name: "Messages" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      `${meta("Ana", "2026-10-24T11:00:00.000Z")}<b>Where</b> is\nmy order?`,
      `${meta("Ana", "2026-10-24T11:05:00.000Z")}Photo (not shown in this inbox)`,
      `${meta("You", "2026-10-24T11:10:00.000Z")}Checking nowNot deliveredThe customer's 24-hour reply window had closed. Send an approved template instead.`,
      `${meta("You", "2026-10-24T11:20:00.000Z")}Template: order_updateHi Ana, your order A-1 has shipped.Read`,
    ]);
    // A message's text is shown as text, never interpreted as markup.
    expect(items[0]!.querySelector("b")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show older messages" })).toBeNull();
  });

  it("marks messages sent from the WhatsApp Business app and imported history (ADR 0019)", () => {
    queryResults.set(GET, conversation());
    queryResults.set(
      MESSAGES,
      page([
        message({
          id: "m3",
          direction: "outbound",
          text: "On my way",
          status: "delivered",
          origin: "business_app",
          at: "2026-10-24T11:20:00.000Z",
        }),
        message({
          id: "m2",
          direction: "outbound",
          text: "Yes, we do",
          status: "read",
          origin: "history",
          at: "2026-10-22T09:01:00.000Z",
        }),
        message({
          id: "m1",
          text: "Do you deliver?",
          origin: "history",
          at: "2026-10-22T09:00:00.000Z",
        }),
      ]),
    );
    renderWithOrg(<WhatsAppConversationView conversationId="conv1" />);
    const items = within(screen.getByRole("list", { name: "Messages" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      `${meta("Ana", "2026-10-22T09:00:00.000Z", "imported")}Do you deliver?`,
      `${meta("You", "2026-10-22T09:01:00.000Z", "imported")}Yes, we doRead`,
      `${meta("You", "2026-10-24T11:20:00.000Z", "sent from the WhatsApp Business app")}On my wayDelivered`,
    ]);
  });

  it("breaks the history by day and groups a sender's messages within five minutes", () => {
    queryResults.set(GET, conversation());
    queryResults.set(
      MESSAGES,
      page([
        message({
          id: "m4",
          direction: "outbound",
          text: "Yes",
          status: "read",
          at: "2026-10-24T11:20:00.000Z",
        }),
        message({ id: "m3", text: "Still there?", at: "2026-10-24T11:03:00.000Z" }),
        message({ id: "m2", text: "Hello again", at: "2026-10-24T11:00:00.000Z" }),
        message({ id: "m1", text: "Hi", at: "2026-10-22T09:00:00.000Z" }),
      ]),
    );
    renderWithOrg(<WhatsAppConversationView conversationId="conv1" />);
    const list = screen.getByRole("list", { name: "Messages" });
    // The day breaks are visual only: every message's time says its date to screen readers.
    expect(
      [...list.querySelectorAll('li[aria-hidden="true"]')].map((li) => li.textContent),
    ).toEqual(["Thursday", "Today"]);
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    const time = items[1]!.querySelector("time")!;
    expect(time).toHaveAttribute("dateTime", "2026-10-24T11:00:00.000Z");
    expect(time).toHaveAttribute("title", formatInstant("2026-10-24T11:00:00.000Z", ORG.timezone));
    // m3 continues m2 (three minutes later): the name is said only to screen readers.
    expect(within(items[1]!).getByText("Ana ·")).not.toHaveClass("sr-only");
    expect(within(items[2]!).getByText("Ana ·")).toHaveClass("sr-only");
    expect(within(items[3]!).getByText("You ·")).not.toHaveClass("sr-only");
  });

  it("loads older messages on request", () => {
    queryResults.set(GET, conversation());
    queryResults.set(MESSAGES, page([message({})], false));
    renderWithOrg(<WhatsAppConversationView conversationId="conv1" />);
    fireEvent.click(screen.getByRole("button", { name: "Show older messages" }));
    expect(loadMoreMock).toHaveBeenCalledWith(30);
  });

  it("lists the conversation's own facts and the channel's tools beside it", () => {
    queryResults.set(GET, conversation());
    queryResults.set(MESSAGES, page([message({})]));
    renderWithOrg(<WhatsAppConversationView conversationId="conv1" />);
    const details = screen.getByRole("complementary", { name: "Conversation details" });
    expect(details).toHaveTextContent("NameAna");
    expect(details).toHaveTextContent("WhatsApp number+15550001111");
    expect(details).toHaveTextContent("Your number+1 555-000-0001");
    expect(within(details).getByRole("link", { name: "WhatsApp templates" })).toHaveAttribute(
      "href",
      "/whatsapp/templates",
    );
    // The history scrolls on its own, and a keyboard can reach it.
    expect(screen.getByRole("region", { name: "Conversation" })).toHaveAttribute("tabindex", "0");
  });

  it("shows or hides the details column, and opens them in a sheet on smaller screens", () => {
    queryResults.set(GET, conversation());
    queryResults.set(MESSAGES, page([message({})]));
    renderWithOrg(<WhatsAppConversationView conversationId="conv1" />);
    // Two Details buttons: one per screen size, only one of them shown (CSS).
    const [column, sheet] = screen.getAllByRole("button", { name: "Details" });
    const details = screen.getByRole("complementary", { name: "Conversation details" });
    expect(column).toHaveAttribute("aria-controls", details.id);
    expect(column).toHaveAttribute("aria-expanded", "true");
    expect(details).toHaveClass("2xl:flex");
    fireEvent.click(column!);
    expect(column).toHaveAttribute("aria-expanded", "false");
    expect(details).not.toHaveClass("2xl:flex");
    fireEvent.click(sheet!);
    const dialog = screen.getByRole("dialog", { name: "Details" });
    expect(within(dialog).getByRole("link", { name: "WhatsApp templates" })).toHaveAttribute(
      "href",
      "/whatsapp/templates",
    );
  });

  it("never shows the previous conversation while another one loads", () => {
    queryResults.set(GET, (args: Record<string, unknown>) =>
      args.conversationId === "conv1" ? conversation() : undefined,
    );
    queryResults.set(MESSAGES, page([message({})]));
    const { rerender } = renderWithOrg(<WhatsAppConversationView conversationId="conv1" />);
    expect(screen.getByRole("heading", { level: 1, name: "Ana" })).toBeInTheDocument();
    rerender(<WhatsAppConversationView conversationId="conv2" />);
    expect(screen.queryByRole("heading", { level: 1, name: "Ana" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.getByRole("status", { name: "Loading conversation" })).toBeInTheDocument();
  });

  it("reads out a message that arrives while open, never the ones already there or your own", () => {
    queryResults.set(GET, conversation());
    queryResults.set(MESSAGES, page([message({ id: "m1", text: "Hello" })]));
    const { rerender } = renderWithOrg(<WhatsAppConversationView conversationId="conv1" />);
    const live = screen.getByTestId("new-message");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("");
    queryResults.set(
      MESSAGES,
      page([
        message({ id: "m2", text: "Is it in stock?", at: "2026-10-24T11:40:00.000Z" }),
        message({ id: "m1", text: "Hello" }),
      ]),
    );
    rerender(<WhatsAppConversationView conversationId="conv1" />);
    expect(screen.getByTestId("new-message")).toHaveTextContent(
      "New message from Ana: Is it in stock?",
    );
    queryResults.set(
      MESSAGES,
      page([
        message({ id: "m3", direction: "outbound", text: "Yes", status: "sent" }),
        message({ id: "m2", text: "Is it in stock?", at: "2026-10-24T11:40:00.000Z" }),
        message({ id: "m1", text: "Hello" }),
      ]),
    );
    rerender(<WhatsAppConversationView conversationId="conv1" />);
    expect(screen.getByTestId("new-message")).toHaveTextContent("");
  });

  it("says so when a conversation has no messages", () => {
    queryResults.set(GET, conversation());
    queryResults.set(MESSAGES, page([]));
    renderWithOrg(<WhatsAppConversationView conversationId="conv1" />);
    expect(screen.getByText("No messages in this conversation yet")).toBeInTheDocument();
  });

  it("renders the not-found page for an unknown or another org's conversation", () => {
    queryResults.set(GET, () => {
      throw apiError("NOT_FOUND", "No whatsappConversations record with this id.", {
        table: "whatsappConversations",
      });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderWithOrg(<WhatsAppConversationView conversationId="nope" />)).toThrow(
      /NEXT_NOT_FOUND/,
    );
    expect(notFoundMock).toHaveBeenCalled();
  });
});
