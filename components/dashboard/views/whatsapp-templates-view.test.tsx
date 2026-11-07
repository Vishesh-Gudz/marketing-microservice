import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import type { Org } from "@/lib/analytics/types";
import type { WhatsAppAccount } from "@/lib/whatsapp/types";
import { ORG } from "@/tests/unit/analytics-fixtures";
import {
  mockAction,
  queryResults,
  renderWithOrg,
  resetHarness,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import WhatsAppTemplatesPage, { metadata } from "@/app/(dashboard)/whatsapp/templates/page";
import { WhatsAppTemplatesView } from "./whatsapp-templates-view";

// ADR 0020: the WhatsApp templates page against the dashboard harness: the list read from Meta
// (through v1), the starter gallery, the builder and deleting. Rules and texts come from
// lib/whatsapp; these tests check the wiring.

const VIEWER: Org = { ...ORG, role: "viewer" };
const LIST = "v1/whatsapp:listAccountTemplates";
const CREATE = "v1/whatsapp:createTemplate";
const DELETE = "v1/whatsapp:deleteTemplate";

function account(overrides: Partial<WhatsAppAccount> = {}): WhatsAppAccount {
  return {
    id: "acc1",
    connectionId: "conn1",
    wabaId: "100000000000001",
    onboardingType: "cloud_api",
    status: "active",
    setupStatus: "connected",
    connectedAt: "2026-10-24T10:00:00.000Z",
    numbers: [],
    ...overrides,
  };
}

const TEMPLATES = {
  complete: true,
  templates: [
    {
      id: "800000000000001",
      name: "order_update",
      language: "en_US",
      category: "UTILITY",
      status: "APPROVED",
      parameterFormat: "NAMED" as const,
      header: "Order update",
      body: "Hi {{customer_name}}, your order shipped.",
      buttons: [{ type: "URL", text: "Track", url: "https://shop.in/{{1}}" }],
      sendable: true,
    },
    {
      id: "800000000000002",
      name: "big_sale",
      language: "en",
      category: "MARKETING",
      status: "REJECTED",
      rejectedReason: "INVALID_FORMAT",
      parameterFormat: "POSITIONAL" as const,
      body: "{{1}} sale",
      buttons: [],
      sendable: true,
    },
    {
      id: "800000000000003",
      name: "welcome_message",
      language: "hi",
      category: "MARKETING",
      status: "PENDING",
      parameterFormat: "NAMED" as const,
      body: "Namaste!",
      buttons: [],
      sendable: true,
    },
  ],
};

beforeEach(() => {
  resetHarness();
  queryResults.set("v1/whatsapp:listAccounts", [account()]);
  queryResults.set("v1/connections:list", [
    { id: "conn1", provider: "whatsapp", displayName: "Gudz Business" },
  ]);
});

async function render(org: Org = ORG) {
  const list = mockAction(LIST).mockResolvedValue(TEMPLATES);
  renderWithOrg(<WhatsAppTemplatesView />, org);
  await screen.findByRole("heading", { name: "order_update" });
  return list;
}

describe("WhatsApp templates page", () => {
  it("is the /whatsapp/templates route, titled and linked back to WhatsApp", () => {
    mockAction(LIST).mockResolvedValue(TEMPLATES);
    expect(metadata.title).toBe("WhatsApp templates");
    renderWithOrg(<WhatsAppTemplatesPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "WhatsApp templates" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "WhatsApp" })).toHaveAttribute("href", "/whatsapp");
    expect(screen.getByRole("link", { name: /WhatsApp settings/ })).toHaveAttribute(
      "href",
      "/whatsapp/settings",
    );
  });

  it("lists the account's templates from Meta with status, category, language and preview", async () => {
    const list = await render();
    expect(list).toHaveBeenCalledWith({ accountId: "acc1" });
    expect(screen.getByText("Gudz Business")).toBeInTheDocument();
    const approved = screen.getByRole("listitem", { name: "order_update" });
    expect(approved).toHaveTextContent("Approved");
    expect(approved).toHaveTextContent("Utility");
    expect(approved).toHaveTextContent("English (US)");
    expect(
      within(approved).getByRole("figure", { name: "order_update preview" }),
    ).toHaveTextContent("Hi {{customer_name}}, your order shipped.");
    const rejected = screen.getByRole("listitem", { name: "big_sale" });
    expect(rejected).toHaveTextContent("Rejected");
    expect(rejected).toHaveTextContent("formatting problem");
    expect(screen.getByRole("listitem", { name: "welcome_message" })).toHaveTextContent(
      "In review",
    );
  });

  it("filters by status and refreshes from Meta", async () => {
    const list = await render();
    fireEvent.click(screen.getByRole("button", { name: /^In review/ }));
    expect(screen.queryByRole("listitem", { name: "order_update" })).toBeNull();
    expect(screen.getByRole("listitem", { name: "welcome_message" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("listitem", { name: "welcome_message" });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("shows viewers the list only: no New template, no Delete", async () => {
    await render(VIEWER);
    expect(screen.queryByRole("button", { name: "New template" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("says so when no WhatsApp account is connected", () => {
    queryResults.set("v1/whatsapp:listAccounts", [account({ status: "disconnected" })]);
    renderWithOrg(<WhatsAppTemplatesView />);
    expect(screen.getByText("No WhatsApp account connected")).toBeInTheDocument();
  });

  it("explains a listing Meta refused", async () => {
    mockAction(LIST).mockRejectedValue(
      apiError("CONFLICT", "server detail", { reason: "reconnect_required" }),
    );
    renderWithOrg(<WhatsAppTemplatesView />);
    expect(await screen.findByLabelText("Connect WhatsApp again")).toBeInTheDocument();
  });
});

describe("creating a template", () => {
  it("starts from a ready-made template, asks for the business's own link, then submits it", async () => {
    const list = await render();
    const create = mockAction(CREATE).mockResolvedValue({
      id: "900000000000001",
      name: "order_shipped",
      language: "en",
      status: "PENDING",
      category: "UTILITY",
    });
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    const gallery = screen.getByRole("list", { name: "Ready-made templates" });
    const cards = () => Array.from(gallery.children);
    expect(cards().length).toBeGreaterThanOrEqual(20);
    fireEvent.click(screen.getByRole("button", { name: "Payments and invoices" }));
    expect(cards().map((li) => li.getAttribute("aria-labelledby"))).toEqual([
      "starter-payment_reminder",
      "starter-payment_received",
      "starter-payment_failed",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Orders and delivery" }));
    const shipping = within(gallery).getByRole("listitem", { name: /Shipping update/ });
    expect(shipping).toHaveTextContent("Hi Priya, good news!");
    fireEvent.click(within(shipping).getByRole("button", { name: "Use this template" }));

    const form = screen.getByRole("form", { name: "New template" });
    expect(within(form).getByLabelText("Template name")).toHaveValue("order_shipped");
    expect(within(form).getByLabelText("{{carrier}} in the body")).toHaveValue("Delhivery");
    const submit = within(form).getByRole("button", { name: "Submit for review" });
    expect(submit).toBeDisabled();
    expect(screen.getByLabelText("Still to do")).toHaveTextContent(
      "Replace the example link with your own website.",
    );
    fireEvent.change(within(form).getByLabelText("Website link"), {
      target: { value: "https://gudz.in/track/{{1}}" },
    });
    expect(screen.queryByLabelText("Still to do")).toBeNull();
    // The preview shows the samples in place of the variables.
    expect(within(form).getByRole("figure", { name: "Message preview" })).toHaveTextContent(
      "Hi Priya, good news! Your order #10234 has shipped with Delhivery",
    );
    fireEvent.click(submit);
    await screen.findByLabelText("Template submitted for review");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({
      accountId: "acc1",
      draft: {
        name: "order_shipped",
        category: "UTILITY",
        buttons: [
          {
            type: "URL",
            text: "Track order",
            url: "https://gudz.in/track/{{1}}",
            example: "AWB123456789",
          },
        ],
      },
    });
    expect(screen.queryByRole("form", { name: "New template" })).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("inserts a variable on Enter, never submitting the template to Meta (D-M1)", async () => {
    await render();
    const create = mockAction(CREATE);
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    fireEvent.click(screen.getByRole("button", { name: "Start from scratch" }));
    const form = screen.getByRole("form", { name: "New template" });
    const field = within(form).getByLabelText("Add a variable");
    fireEvent.change(field, { target: { value: "Order Number" } });
    // The browser's implicit submit only happens when Enter's keydown is not cancelled.
    expect(fireEvent.keyDown(field, { key: "Enter" })).toBe(false);
    expect(within(form).getByLabelText("Message body")).toHaveValue("{{order_number}}");
    expect(field).toHaveValue("");
    expect(create).not.toHaveBeenCalled();
  });

  it("builds one from scratch: variables, samples, buttons and their order", async () => {
    await render();
    const create = mockAction(CREATE).mockResolvedValue({
      id: "900000000000002",
      name: "visit_reminder",
      language: "hi",
    });
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    fireEvent.click(screen.getByRole("button", { name: "Start from scratch" }));
    const form = screen.getByRole("form", { name: "New template" });
    fireEvent.change(within(form).getByLabelText("Template name"), {
      target: { value: "Visit Reminder" },
    });
    expect(within(form).getByLabelText("Template name")).toHaveValue("visit_reminder");
    fireEvent.change(within(form).getByLabelText("Language"), { target: { value: "hi" } });
    fireEvent.change(within(form).getByLabelText("Message body"), {
      target: { value: "Hi, your visit is on" },
    });
    fireEvent.change(within(form).getByLabelText("Add a variable"), {
      target: { value: "Visit Date" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Insert into body" }));
    expect(within(form).getByLabelText("Message body")).toHaveValue(
      "Hi, your visit is on {{visit_date}}",
    );
    fireEvent.change(within(form).getByLabelText("{{visit_date}} in the body"), {
      target: { value: "Monday" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add phone number" }));
    fireEvent.click(within(form).getByRole("button", { name: "Add quick reply" }));
    const buttons = within(form).getAllByRole("listitem", { name: /^Button / });
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Button 1: Quick reply",
      "Button 2: Phone number",
    ]);
    expect(within(form).getByRole("button", { name: "Add phone number" })).toBeDisabled();
    fireEvent.change(within(buttons[0]!).getByLabelText("Button label"), {
      target: { value: "OK" },
    });
    fireEvent.change(within(buttons[1]!).getByLabelText("Button label"), {
      target: { value: "Call" },
    });
    fireEvent.change(within(buttons[1]!).getByLabelText("Phone number"), {
      target: { value: "+91 98765 43210" },
    });
    fireEvent.click(within(form).getByLabelText(/^Marketing/));
    fireEvent.click(within(form).getByRole("button", { name: "Submit for review" }));
    await screen.findByLabelText("Template submitted for review");
    expect(create.mock.calls[0]![0]).toEqual({
      accountId: "acc1",
      draft: {
        name: "visit_reminder",
        language: "hi",
        category: "MARKETING",
        body: "Hi, your visit is on {{visit_date}}",
        buttons: [
          { type: "QUICK_REPLY", text: "OK" },
          { type: "PHONE_NUMBER", text: "Call", phoneNumber: "+91 98765 43210" },
        ],
        examples: [{ component: "body", name: "visit_date", value: "Monday" }],
      },
    });
  });

  it("shows a refused submission in fixed words and keeps the form", async () => {
    await render();
    mockAction(CREATE).mockRejectedValue(
      apiError("CONFLICT", "server detail never shown", { reason: "meta_100_2388024" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    const welcome = screen.getByRole("listitem", { name: /Welcome message/ });
    fireEvent.click(within(welcome).getByRole("button", { name: "Use this template" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    const notice = await screen.findByLabelText("Meta refused the template");
    expect(notice).toHaveTextContent("already exists in this language");
    expect(notice).not.toHaveTextContent("server detail");
    expect(screen.getByRole("form", { name: "New template" })).toBeInTheDocument();
  });
});

describe("deleting a template", () => {
  it("asks for confirmation, warns about the 30-day name hold, then deletes once", async () => {
    const list = await render();
    let resolve: (value: unknown) => void = () => {};
    const remove = mockAction(DELETE).mockImplementation(() => new Promise((r) => (resolve = r)));
    const card = screen.getByRole("listitem", { name: "order_update" });
    fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
    const confirm = within(card).getByRole("group", { name: /Delete “order_update”/ });
    expect(confirm).toHaveTextContent("30 days");
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
    const yes = within(confirm).getByRole("button", { name: "Delete" });
    fireEvent.click(yes);
    fireEvent.click(yes);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({
      accountId: "acc1",
      templateId: "800000000000001",
      name: "order_update",
      language: "en_US",
    });
    await act(async () => resolve(null));
    expect(screen.getByLabelText("Template deleted")).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
