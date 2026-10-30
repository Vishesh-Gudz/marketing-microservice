import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import type { Org } from "@/lib/analytics/types";
import type { InstagramConversation, InstagramMessage } from "@/lib/instagram/types";
import { ORG } from "@/tests/unit/analytics-fixtures";
import {
  lastArgs,
  loadMoreMock,
  mockMutation,
  notFoundMock,
  queryResults,
  renderWithOrg,
  resetHarness,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import InstagramConversationPage, {
  metadata,
} from "@/app/(dashboard)/instagram/messages/conversations/[conversationId]/page";
import { InstagramConversationView } from "./instagram-conversation-view";

// One Instagram conversation (ADR 0017, IM5) through the dashboard harness: the thread, each
// reply's status, the reply window, and replying. The server enforces every rule again
// (convex/instagram/messaging/outbound.ts); these tests check what the page offers and sends.

const GET = "v1/instagramMessaging:getConversation";
const MESSAGES = "v1/instagramMessaging:listMessages";
const SEND = "v1/instagramMessaging:sendText";
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const EDITOR: Org = { ...ORG, role: "editor" };
const VIEWER: Org = { ...ORG, role: "viewer" };

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

function message(overrides: Partial<InstagramMessage>): InstagramMessage {
  return {
    id: "m1",
    conversationId: "conv1",
    direction: "inbound",
    origin: "customer",
    type: "text",
    text: "Do you ship?",
    status: "received",
    at: "2026-10-30T11:00:00.000Z",
    ...overrides,
  };
}

function page(messages: InstagramMessage[], isDone = true) {
  return { page: messages, isDone, continueCursor: isDone ? "" : "c1" };
}

function show(overrides: Partial<InstagramConversation> = {}, org: Org = ORG) {
  queryResults.set(GET, conversation(overrides));
  queryResults.set(MESSAGES, page([message({})]));
  return renderWithOrg(<InstagramConversationView conversationId="conv1" />, org);
}

const messageBox = () => screen.getByRole("textbox", { name: "Message" });
const sendButton = () => screen.getByRole("button", { name: /^(Send|Sending…)$/ });

async function type(text: string) {
  await act(async () => {
    fireEvent.change(messageBox(), { target: { value: text } });
  });
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

describe("the thread", () => {
  it("is the conversation route, passing the id through", async () => {
    expect(metadata.title).toBe("Instagram conversation");
    queryResults.set(GET, (args: Record<string, unknown>) =>
      conversation({ id: String(args.conversationId) }),
    );
    queryResults.set(MESSAGES, page([]));
    renderWithOrg(
      await InstagramConversationPage({
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

  it("shows labelled placeholders while loading, and an empty thread", () => {
    renderWithOrg(<InstagramConversationView conversationId="conv1" />);
    expect(screen.getByRole("status", { name: "Loading conversation" })).toBeInTheDocument();
    queryResults.set(GET, conversation());
    renderWithOrg(<InstagramConversationView conversationId="conv1" />);
    expect(screen.getByRole("status", { name: "Loading messages" })).toBeInTheDocument();
    queryResults.set(MESSAGES, page([]));
    renderWithOrg(<InstagramConversationView conversationId="conv1" />);
    expect(screen.getByText("No messages in this conversation yet")).toBeInTheDocument();
  });

  it("renders the not-found page for an unknown or another org's conversation", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    queryResults.set(GET, () => {
      throw apiError("NOT_FOUND", "No instagramConversations record with this id.");
    });
    expect(() => renderWithOrg(<InstagramConversationView conversationId="x" />)).toThrow();
    expect(notFoundMock).toHaveBeenCalled();
  });

  it("names the contact and account, links back to the inbox, oldest message first", () => {
    queryResults.set(GET, conversation());
    queryResults.set(
      MESSAGES,
      page([
        message({ id: "m2", direction: "outbound", origin: "app", text: "Yes!", status: "read" }),
        message({ id: "m1" }),
      ]),
    );
    renderWithOrg(<InstagramConversationView conversationId="conv1" />);
    expect(screen.getByRole("heading", { level: 1, name: "@ana.shop" })).toBeInTheDocument();
    expect(screen.getByText("Instagram conversation on @shop")).toBeInTheDocument();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Instagram DMs" })).toHaveAttribute(
      "href",
      "/instagram/messages",
    );
    const items = within(screen.getByRole("list", { name: "Messages" })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("@ana.shop");
    expect(items[0]).toHaveTextContent("Do you ship?");
    expect(items[1]).toHaveTextContent("You");
    expect(items[1]).toHaveTextContent("Seen");
  });

  it("shows every reply status, and is honest about failed and unconfirmed ones", () => {
    queryResults.set(GET, conversation());
    queryResults.set(
      MESSAGES,
      page(
        [
          ["pending", undefined],
          ["submitted", undefined],
          ["sent", undefined],
          ["read", undefined],
          ["failed", "window_closed"],
          ["unknown", "timeout"],
        ]
          .map(([status, failureReason], i) =>
            message({
              id: `m${i}`,
              direction: "outbound",
              origin: "app",
              text: `reply ${i}`,
              status: status as InstagramMessage["status"],
              ...(failureReason !== undefined ? { failureReason, errorCode: 10 } : {}),
            }),
          )
          .reverse(),
      ),
    );
    renderWithOrg(<InstagramConversationView conversationId="conv1" />);
    const items = within(screen.getByRole("list", { name: "Messages" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Sending"),
      expect.stringContaining("Accepted by Instagram"),
      expect.stringContaining("Sent"),
      expect.stringContaining("Seen"),
      expect.stringContaining("24-hour reply window"),
      expect.stringContaining("may have been sent"),
    ]);
    // No Meta code reaches the page, and nothing offers to resend.
    expect(screen.getByRole("list", { name: "Messages" })).not.toHaveTextContent("10");
    expect(screen.queryByRole("button", { name: /resend|retry/i })).toBeNull();
  });

  it("marks echoes, attachments, edits and deletions", () => {
    queryResults.set(GET, conversation());
    queryResults.set(
      MESSAGES,
      page(
        [
          message({ id: "a", type: "image", text: undefined }),
          message({ id: "b", text: "Fixed typo", editedAt: "2026-10-30T11:05:00.000Z" }),
          message({ id: "c", text: undefined, deletedAt: "2026-10-30T11:06:00.000Z" }),
          message({
            id: "d",
            direction: "outbound",
            origin: "instagram",
            text: "From the app",
            status: "sent",
          }),
        ].reverse(),
      ),
    );
    renderWithOrg(<InstagramConversationView conversationId="conv1" />);
    const items = within(screen.getByRole("list", { name: "Messages" })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Photo (not shown in this inbox)");
    expect(items[1]).toHaveTextContent("Edited");
    expect(items[2]).toHaveTextContent("The customer deleted this message");
    expect(items[3]).toHaveTextContent("You, in the Instagram app");
  });

  it("loads older messages on request", async () => {
    queryResults.set(GET, conversation());
    queryResults.set(MESSAGES, page([message({})], false));
    renderWithOrg(<InstagramConversationView conversationId="conv1" />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Show older messages" })),
    );
    expect(loadMoreMock).toHaveBeenCalledWith(30);
  });
});

describe("who may reply, and when", () => {
  it("shows viewers no reply box", () => {
    show({}, VIEWER);
    expect(screen.getByText("Only editors and admins can reply.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  });

  it.each([
    ["editors", EDITOR],
    ["admins", ORG],
  ])("lets %s reply while the window is open", (_label, org) => {
    show({}, org);
    expect(screen.getByRole("heading", { level: 2, name: "Reply" })).toBeInTheDocument();
    expect(screen.getByText(/Reply window open/)).toBeInTheDocument();
    expect(messageBox()).toBeInTheDocument();
  });

  it.each([
    [
      "the window closed",
      { replyWindowExpiresAt: "2026-10-30T11:59:00.000Z" },
      "Instagram allows no reply until they write again.",
    ],
    [
      "the customer never wrote",
      { lastInboundAt: undefined, replyWindowExpiresAt: undefined },
      "Instagram allows a reply only after they do.",
    ],
  ])("offers no reply box when %s", (_case, overrides, text) => {
    show(overrides);
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.getAllByText(new RegExp(text.replace(".", "\\.")))[0]).toBeInTheDocument();
  });

  it.each([
    ["messaging_unavailable", /not on for this account/],
    ["setup_incomplete", /did not finish/],
    ["reconnect_required", /no longer accepts this connection/],
    ["scope_missing", /does not allow direct messages/],
  ] as const)(
    "offers no reply box when the server says %s, and points to the settings",
    (replyBlocker, text) => {
      show({ replyBlocker });
      expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
      // The window is open, but the header must not promise a reply the server would refuse.
      expect(screen.getByText("Replies unavailable")).toBeInTheDocument();
      expect(screen.queryByText("Reply window open")).toBeNull();
      expect(screen.queryByText(/Replies are possible/)).toBeNull();
      expect(screen.getAllByText(text)).toHaveLength(2);
      expect(screen.getByRole("link", { name: "Open the Instagram DM settings" })).toHaveAttribute(
        "href",
        "/instagram/messages/settings",
      );
    },
  );
});

describe("the reply box", () => {
  it("sends the text with the account, the conversation and a client id, then clears", async () => {
    const send = mockMutation(SEND).mockResolvedValue({});
    show();
    expect(sendButton()).toBeDisabled();
    await type("   ");
    expect(sendButton()).toBeDisabled();
    await type("Yes, to Lisbon.");
    await act(async () => fireEvent.click(sendButton()));
    expect(send).toHaveBeenCalledTimes(1);
    const first = send.mock.calls[0]![0]!;
    expect(first).toEqual({
      accountId: "acct1",
      conversationId: "conv1",
      text: "Yes, to Lisbon.",
      clientMessageId: expect.stringMatching(CLIENT_ID),
    });
    expect(messageBox()).toHaveValue("");
    await type("Second");
    await act(async () => fireEvent.click(sendButton()));
    expect(send.mock.calls[1]![0]!.clientMessageId).not.toBe(first.clientMessageId);
  });

  it("sends once while a send is in flight", async () => {
    let resolve: (value: unknown) => void = () => {};
    const send = mockMutation(SEND).mockImplementation(() => new Promise((r) => (resolve = r)));
    show();
    await type("Hello");
    await act(async () => {
      fireEvent.click(sendButton());
      fireEvent.submit(messageBox().closest("form")!);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(messageBox()).toBeDisabled();
    await act(async () => resolve({}));
    expect(messageBox()).toHaveValue("");
  });

  it("shows a refusal in fixed words and retries the same draft with the same client id", async () => {
    const send = mockMutation(SEND)
      .mockRejectedValueOnce(apiError("CONFLICT", "server words", { reason: "window_closed" }))
      .mockResolvedValueOnce({});
    show();
    await type("Hello");
    await act(async () => fireEvent.click(sendButton()));
    const notice = screen.getByLabelText("Reply window closed");
    expect(notice).toHaveTextContent("until they write again");
    expect(notice).not.toHaveTextContent("server words");
    expect(messageBox()).toHaveValue("Hello");
    await act(async () => fireEvent.click(sendButton()));
    expect(send.mock.calls[1]![0]!.clientMessageId).toBe(send.mock.calls[0]![0]!.clientMessageId);
  });

  it.each([
    ["1000 ASCII characters", "a".repeat(1000), "1,000 / 1,000 bytes", false],
    ["1001 ASCII characters", "a".repeat(1001), "1,001 / 1,000 bytes", true],
    ["250 emoji (1000 bytes)", "😀".repeat(250), "1,000 / 1,000 bytes", false],
    ["251 emoji (1004 bytes)", "😀".repeat(251), "1,004 / 1,000 bytes", true],
    ["334 three-byte characters", "€".repeat(334), "1,002 / 1,000 bytes", true],
  ])("counts bytes like Instagram: %s", async (_case, text, counter, refused) => {
    mockMutation(SEND);
    show();
    await type(text);
    expect(screen.getByText(new RegExp(counter))).toBeInTheDocument();
    expect(messageBox()).toHaveAccessibleDescription(new RegExp(counter));
    if (refused) {
      expect(messageBox()).toHaveAttribute("aria-invalid", "true");
      expect(sendButton()).toBeDisabled();
    } else {
      expect(messageBox()).not.toHaveAttribute("aria-invalid");
      expect(sendButton()).toBeEnabled();
    }
  });
});
