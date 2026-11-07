import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import type { Org } from "@/lib/analytics/types";
import type {
  WhatsAppAccount,
  WhatsAppConversation,
  WhatsAppNumber,
  WhatsAppTemplate,
  WhatsAppTemplateList,
} from "@/lib/whatsapp/types";
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

import { WhatsAppConversationView } from "./whatsapp-conversation-view";

// Replying in a WhatsApp thread (ADR 0013 stage 5): the text reply box and the template picker,
// against the dashboard harness. The server enforces every rule again (convex/whatsapp/
// outbound.ts); these tests check the wiring, the one-send-at-a-time guard and the fixed texts.

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const SEND_TEXT = "v1/whatsapp:sendText";
const LIST_TEMPLATES = "v1/whatsapp:listTemplates";
const SEND_TEMPLATE = "v1/whatsapp:sendTemplate";
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const EDITOR: Org = { ...ORG, role: "editor" };
const VIEWER: Org = { ...ORG, role: "viewer" };

function conversation(overrides: Partial<WhatsAppConversation> = {}): WhatsAppConversation {
  return {
    id: "conv1",
    phoneNumberId: "200000000000001",
    contactWaId: "15550001111",
    contactName: "Ana",
    lastMessageAt: "2026-10-24T11:30:00.000Z",
    lastInboundAt: "2026-10-24T11:00:00.000Z",
    serviceWindowExpiresAt: "2026-10-25T11:00:00.000Z",
    ...overrides,
  };
}

const ORDER: WhatsAppTemplate = {
  name: "order_update",
  language: "en_US",
  category: "UTILITY",
  parameterFormat: "POSITIONAL",
  body: "Hi {{1}}, your order {{2}} has shipped.",
  buttons: [{ type: "URL", text: "Track" }],
  variables: [
    { component: "body", name: "1", example: "Ana" },
    { component: "body", name: "2" },
    { component: "button", name: "0" },
  ],
  supported: true,
};

const PROMO: WhatsAppTemplate = {
  name: "promo_image",
  language: "en_US",
  category: "MARKETING",
  parameterFormat: "POSITIONAL",
  body: "New arrivals",
  buttons: [],
  variables: [],
  supported: false,
  unsupportedReason: "media_header",
};

function show(overrides: Partial<WhatsAppConversation> = {}, org: Org = EDITOR) {
  queryResults.set("v1/whatsapp:getConversation", conversation(overrides));
  queryResults.set("v1/whatsapp:listMessages", { page: [], isDone: true, continueCursor: "" });
  return renderWithOrg(<WhatsAppConversationView conversationId="conv1" />, org);
}

const messageBox = () => screen.getByRole("textbox", { name: "Message" });
const sendButton = () => screen.getByRole("button", { name: "Send" });

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

describe("who may reply", () => {
  it("shows viewers no reply box and no template picker", () => {
    show({}, VIEWER);
    expect(screen.getByText("Only editors and admins can reply.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose a template" })).toBeNull();
  });

  it.each([
    ["editors", EDITOR],
    ["admins", ORG],
  ])("lets %s reply", (_label, org) => {
    show({}, org);
    expect(screen.getByRole("heading", { level: 2, name: "Reply" })).toBeInTheDocument();
    expect(messageBox()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a template" })).toBeInTheDocument();
  });

  it("offers only templates once the reply window has closed", () => {
    show({ serviceWindowExpiresAt: "2026-10-24T11:59:00.000Z" });
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.getByText("The 24-hour reply window is closed")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The customer last wrote more than 24 hours ago: only approved templates can be sent.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a template" })).toBeInTheDocument();
  });
});

describe("a draft when the reply window closes (D-M5)", () => {
  const closedNow = { serviceWindowExpiresAt: "2026-10-24T11:59:00.000Z" };

  it("keeps the typed draft, read-only and unsendable, until it is discarded", async () => {
    const send = mockMutation(SEND_TEXT).mockResolvedValue({});
    const { rerender } = show();
    await type("Your order ships today");
    // The window closes while the draft is open (the 30-second tick or a new read).
    queryResults.set("v1/whatsapp:getConversation", conversation(closedNow));
    rerender(<WhatsAppConversationView conversationId="conv1" />);
    expect(messageBox()).toHaveValue("Your order ships today");
    expect(messageBox()).toHaveAttribute("readonly");
    expect(screen.getByText(/Your unsent draft is kept here/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    await act(async () => {
      fireEvent.submit(messageBox().closest("form")!);
    });
    expect(send).not.toHaveBeenCalled();
    // A template can still be sent meanwhile.
    expect(screen.getByRole("button", { name: "Choose a template" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  });

  it("offers the kept draft for sending again when the customer writes", async () => {
    const send = mockMutation(SEND_TEXT).mockResolvedValue({});
    const { rerender } = show();
    await type("Still interested?");
    queryResults.set("v1/whatsapp:getConversation", conversation(closedNow));
    rerender(<WhatsAppConversationView conversationId="conv1" />);
    queryResults.set("v1/whatsapp:getConversation", conversation());
    rerender(<WhatsAppConversationView conversationId="conv1" />);
    expect(messageBox()).toHaveValue("Still interested?");
    await act(async () => fireEvent.click(sendButton()));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv1", text: "Still interested?" }),
    );
  });
});

describe("a number that cannot send (D-M3)", () => {
  const ACCOUNTS = "v1/whatsapp:listAccounts";

  function accounts(
    number: Partial<WhatsAppNumber> = {},
    account: Partial<WhatsAppAccount> = {},
  ): WhatsAppAccount[] {
    return [
      {
        id: "a1",
        connectionId: "c1",
        wabaId: "100000000000001",
        onboardingType: "cloud_api",
        status: "active",
        setupStatus: "connected",
        connectedAt: "2026-10-01T10:00:00.000Z",
        numbers: [
          {
            id: "n1",
            phoneNumberId: "200000000000001",
            status: "active",
            registered: true,
            businessApp: false,
            ...number,
          },
        ],
        ...account,
      },
    ];
  }

  it.each([
    ["is disconnected", accounts({ status: "disconnected" }), "Number no longer connected"],
    [
      "needs a new connection",
      accounts({}, { setupStatus: "reauthorization_required" }),
      "Connect WhatsApp again",
    ],
    ["is not registered yet", accounts({ registered: false }), "Number not ready"],
  ])("offers no reply and no template when the number %s", (_case, list, title) => {
    queryResults.set(ACCOUNTS, list);
    show();
    expect(screen.getByText("Replies unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Reply window open")).toBeNull();
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose a template" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open the WhatsApp settings" })).toHaveAttribute(
      "href",
      "/whatsapp/settings",
    );
  });

  it.each([
    ["the accounts load", undefined],
    ["the number can send", accounts()],
    ["the accounts do not list the number", accounts({ phoneNumberId: "other" })],
  ])("keeps the reply box while %s (the server decides)", (_case, list) => {
    if (list !== undefined) queryResults.set(ACCOUNTS, list);
    show();
    expect(screen.queryByText("Replies unavailable")).toBeNull();
    expect(messageBox()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a template" })).toBeInTheDocument();
  });
});

describe("text reply", () => {
  it("sends the typed text with a client id, then clears the box for the next one", async () => {
    const send = mockMutation(SEND_TEXT).mockResolvedValue({});
    show();
    expect(sendButton()).toBeDisabled();
    await type("   ");
    expect(sendButton()).toBeDisabled();
    await type("On its way!\nTracking soon.");
    await act(async () => fireEvent.click(sendButton()));
    expect(send).toHaveBeenCalledTimes(1);
    const first = send.mock.calls[0]![0]!;
    expect(first).toEqual({
      conversationId: "conv1",
      text: "On its way!\nTracking soon.",
      clientMessageId: expect.stringMatching(CLIENT_ID),
    });
    expect(messageBox()).toHaveValue("");

    await type("Second one");
    await act(async () => fireEvent.click(sendButton()));
    expect(send.mock.calls[1]![0]!.clientMessageId).not.toBe(first.clientMessageId);
  });

  it("sends once while a send is in flight", async () => {
    let resolve: (value: unknown) => void = () => {};
    const send = mockMutation(SEND_TEXT).mockImplementation(
      () => new Promise((r) => (resolve = r)),
    );
    show();
    await type("Hello");
    await act(async () => {
      fireEvent.click(sendButton());
      fireEvent.submit(messageBox().closest("form")!);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    await act(async () => resolve({}));
    expect(messageBox()).toHaveValue("");
  });

  it("shows a refusal in fixed words and retries the same draft with the same client id", async () => {
    const send = mockMutation(SEND_TEXT)
      .mockRejectedValueOnce(
        apiError("CONFLICT", "server text", { reason: "service_window_closed" }),
      )
      .mockResolvedValueOnce({});
    show();
    await type("Hello");
    await act(async () => fireEvent.click(sendButton()));
    const notice = screen.getByLabelText("Reply window closed");
    expect(notice).toHaveTextContent("Send an approved template instead.");
    expect(notice).not.toHaveTextContent("server text");
    expect(messageBox()).toHaveValue("Hello"); // the draft is kept

    await act(async () => fireEvent.click(sendButton()));
    expect(send.mock.calls[1]![0]!.clientMessageId).toBe(send.mock.calls[0]![0]!.clientMessageId);
  });

  it("gives an edited draft a new client id", async () => {
    const send = mockMutation(SEND_TEXT).mockRejectedValue(apiError("PROVIDER_ERROR", "x"));
    show();
    await type("Hello");
    await act(async () => fireEvent.click(sendButton()));
    await type("Hello again");
    await act(async () => fireEvent.click(sendButton()));
    expect(send.mock.calls[1]![0]!.clientMessageId).not.toBe(
      send.mock.calls[0]![0]!.clientMessageId,
    );
  });

  it("refuses a reply longer than WhatsApp allows", async () => {
    mockMutation(SEND_TEXT);
    show();
    await type("x".repeat(4097));
    expect(messageBox()).toHaveAttribute("aria-invalid", "true");
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText("4097 / 4096 characters")).toBeInTheDocument();
  });
});

describe("template picker", () => {
  const LIST: WhatsAppTemplateList = { templates: [ORDER, PROMO], complete: true };

  async function openPicker() {
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Choose a template" })),
    );
  }

  async function fill(label: string, value: string) {
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });
    });
  }

  it("lists the approved templates, with the ones this app cannot send yet explained", async () => {
    const list = mockAction(LIST_TEMPLATES).mockResolvedValue(LIST);
    show();
    await openPicker();
    expect(list).toHaveBeenCalledWith({ conversationId: "conv1" });
    const items = within(screen.getByRole("list", { name: "Approved templates" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(2);
    expect(
      within(items[0]!).getByRole("button", { name: "Use order_update (en_US)" }),
    ).toBeInTheDocument();
    expect(within(items[1]!).queryByRole("button")).toBeNull();
    expect(items[1]).toHaveTextContent("Not supported yet: Has a photo, video or document header");
  });

  it("sends a template once while its send is in flight", async () => {
    mockAction(LIST_TEMPLATES).mockResolvedValue({ templates: [ORDER], complete: true });
    let resolve: (value: unknown) => void = () => {};
    const send = mockAction(SEND_TEMPLATE).mockImplementation(
      () => new Promise((r) => (resolve = r)),
    );
    show();
    await openPicker();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Use order_update (en_US)" })),
    );
    await fill("{{1}} in the body", "Ana");
    await fill("{{2}} in the body", "A-1");
    await fill("End of the link of the “Track” button", "A-1");
    const button = screen.getByRole("button", { name: "Send template" });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.submit(button.closest("form")!);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    await act(async () => resolve({}));
    expect(screen.getByLabelText("Template sent")).toBeInTheDocument();
  });

  it("fills in a template with a live preview and sends exactly its values", async () => {
    mockAction(LIST_TEMPLATES).mockResolvedValue(LIST);
    const send = mockAction(SEND_TEMPLATE).mockResolvedValue({});
    show({ serviceWindowExpiresAt: "2026-10-24T11:59:00.000Z" }); // works with the window closed
    await openPicker();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Use order_update (en_US)" })),
    );
    const preview = screen.getByLabelText("Template preview");
    expect(preview).toHaveTextContent("Hi {{1}}, your order {{2}} has shipped.");
    expect(screen.getByRole("textbox", { name: "{{1}} in the body" })).toHaveAttribute(
      "placeholder",
      "Ana",
    );
    const sendTemplate = screen.getByRole("button", { name: "Send template" });
    expect(sendTemplate).toBeDisabled();

    await fill("{{1}} in the body", "Ana");
    await fill("{{2}} in the body", "A-1042");
    expect(sendTemplate).toBeDisabled(); // the button value is still missing
    await fill("End of the link of the “Track” button", "A-1042");
    expect(preview).toHaveTextContent("Hi Ana, your order A-1042 has shipped.");
    await act(async () => fireEvent.click(sendTemplate));

    expect(send).toHaveBeenCalledWith({
      conversationId: "conv1",
      templateName: "order_update",
      language: "en_US",
      variables: [
        { component: "body", name: "1", value: "Ana" },
        { component: "body", name: "2", value: "A-1042" },
        { component: "button", name: "0", value: "A-1042" },
      ],
      clientMessageId: expect.stringMatching(CLIENT_ID),
    });
    expect(screen.getByLabelText("Template sent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a template" })).toBeInTheDocument();
  });

  it("keeps the form after a refused send, and goes back to the list on request", async () => {
    mockAction(LIST_TEMPLATES).mockResolvedValue({ templates: [ORDER], complete: false });
    mockAction(SEND_TEMPLATE).mockRejectedValue(
      apiError("CONFLICT", "server text", { reason: "template_unavailable" }),
    );
    show();
    await openPicker();
    expect(
      screen.getByText("Only the first templates of this account are listed."),
    ).toBeInTheDocument();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Use order_update (en_US)" })),
    );
    await fill("{{1}} in the body", "Ana");
    await fill("{{2}} in the body", "A-1");
    await fill("End of the link of the “Track” button", "A-1");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send template" })));
    expect(screen.getByLabelText("Template not available")).not.toHaveTextContent("server text");
    expect(screen.getByRole("button", { name: "Send template" })).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Back" })));
    expect(screen.getByRole("list", { name: "Approved templates" })).toBeInTheDocument();
  });

  it("shows a failed listing in fixed words and lets the user try again", async () => {
    const list = mockAction(LIST_TEMPLATES)
      .mockRejectedValueOnce(
        apiError("PROVIDER_ERROR", "Meta said something", { reason: "http_503" }),
      )
      .mockResolvedValueOnce({ templates: [], complete: true });
    show();
    await openPicker();
    expect(screen.getByLabelText("Meta did not answer")).not.toHaveTextContent("Meta said");
    await openPicker();
    expect(list).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText(/This WhatsApp account has no approved templates yet/),
    ).toBeInTheDocument();
  });
});

describe("saved replies (ADR 0021)", () => {
  it("inserts a WhatsApp saved reply with the customer's first name, ready to edit", () => {
    queryResults.set("v1/savedReplies:list", [
      {
        id: "r1",
        title: "Thanks",
        text: "Thank you, {{customer_name}}!",
        channels: ["whatsapp"],
        updatedAt: "2026-10-24T10:00:00.000Z",
      },
    ]);
    show({ contactName: "Ana Souza" });
    fireEvent.click(screen.getByRole("button", { name: "Saved replies" }));
    fireEvent.click(screen.getByRole("button", { name: /Thanks/ }));
    expect(messageBox()).toHaveValue("Thank you, Ana!");
    expect(sendButton()).toBeEnabled();
  });

  it("never sends the reply when Enter is pressed in the search (D-M1)", () => {
    queryResults.set("v1/savedReplies:list", []);
    show();
    fireEvent.click(screen.getByRole("button", { name: "Saved replies" }));
    const search = screen.getByRole("textbox", { name: "Search saved replies" });
    // The browser's implicit submit only happens when Enter's keydown is not cancelled.
    expect(fireEvent.keyDown(search, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(search, { key: "a" })).toBe(true);
  });
});
