import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import type { Org } from "@/lib/analytics/types";
import { ORG } from "@/tests/unit/analytics-fixtures";
import {
  mockMutation,
  queryResults,
  renderWithOrg,
  resetHarness,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import InstagramTemplatesPage, {
  metadata,
} from "@/app/(dashboard)/instagram/messages/templates/page";
import { InstagramTemplatesView } from "./instagram-templates-view";

// ADR 0022: the Instagram templates page against the dashboard harness. The server checks every
// rule again (convex/instagram/messaging/templates.test.ts).

const VIEWER: Org = { ...ORG, role: "viewer" };
const LIST = "v1/instagramTemplates:list";
const CREATE = "v1/instagramTemplates:create";
const UPDATE = "v1/instagramTemplates:update";
const REMOVE = "v1/instagramTemplates:remove";

const MENU = {
  id: "t1",
  name: "Welcome",
  content: {
    kind: "buttons" as const,
    text: "Hi {{customer_name}}, what can we do for you?",
    buttons: [
      { type: "reply" as const, title: "Prices" },
      { type: "url" as const, title: "Shop", url: "https://shop.example.com" },
    ],
  },
  updatedAt: "2026-11-04T10:00:00.000Z",
};

beforeEach(() => {
  resetHarness();
  queryResults.set(LIST, [MENU]);
});

describe("Instagram templates page", () => {
  it("is the /instagram/messages/templates route, linked back to Instagram DMs", () => {
    expect(metadata.title).toBe("Instagram templates");
    renderWithOrg(<InstagramTemplatesPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Instagram templates" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Instagram DMs" })).toHaveAttribute(
      "href",
      "/instagram/messages",
    );
  });

  it("lists the templates with their preview; viewers can only read", () => {
    renderWithOrg(<InstagramTemplatesView />, VIEWER);
    const card = screen.getByRole("listitem", { name: "Welcome" });
    expect(card).toHaveTextContent("Button message");
    const preview = within(card).getByRole("figure", { name: "Welcome preview" });
    expect(preview).toHaveTextContent("Hi {{customer_name}}, what can we do for you?");
    expect(within(preview).getByRole("list", { name: "Buttons" })).toHaveTextContent("PricesShop");
    expect(screen.queryByRole("button", { name: "New template" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("starts from a ready-made template and asks for the business's own words and links first", async () => {
    const create = mockMutation(CREATE).mockResolvedValue({ ...MENU, id: "t2", name: "Prices" });
    renderWithOrg(<InstagramTemplatesView />);
    fireEvent.click(screen.getByRole("button", { name: "Ready-made templates" }));
    const starter = screen.getByRole("listitem", { name: "Prices" });
    fireEvent.click(within(starter).getByRole("button", { name: "Use this template" }));
    const form = screen.getByRole("form", { name: "New Instagram template" });
    expect(within(form).getByLabelText("Name")).toHaveValue("Prices");
    const todo = within(form).getByRole("note", { name: "Still to do" });
    expect(todo).toHaveTextContent("Replace the text in [brackets] with your own.");
    expect(todo).toHaveTextContent("Replace the example link with your own website.");
    const save = within(form).getByRole("button", { name: "Save template" });
    expect(save).toBeDisabled();

    fireEvent.change(within(form).getByLabelText("Message"), {
      target: { value: "Our prices start at €20. See every option on our pricing page." },
    });
    const link = within(form).getAllByLabelText("Link")[0]!;
    fireEvent.change(link, { target: { value: "https://shop.example.com/pricing" } });
    expect(within(form).queryByRole("note", { name: "Still to do" })).toBeNull();
    await act(async () => {
      fireEvent.click(save);
    });
    expect(create).toHaveBeenCalledWith({
      name: "Prices",
      content: {
        kind: "buttons",
        text: "Our prices start at €20. See every option on our pricing page.",
        buttons: [
          { type: "url", title: "See prices", url: "https://shop.example.com/pricing" },
          { type: "reply", title: "Ask a question" },
        ],
      },
    });
    expect(screen.getByLabelText("Template added")).toBeInTheDocument();
  });

  it("builds cards from scratch, leaving out empty optional parts", async () => {
    const create = mockMutation(CREATE).mockResolvedValue({ ...MENU, id: "t3", name: "Picks" });
    renderWithOrg(<InstagramTemplatesView />);
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    const form = screen.getByRole("form", { name: "New Instagram template" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Picks" } });
    fireEvent.click(within(form).getByLabelText("Cards"));
    const card = within(form).getByRole("group", { name: "Card 1" });
    fireEvent.change(within(card).getByLabelText("Title"), { target: { value: "Linen shirt" } });
    fireEvent.change(within(card).getByLabelText("Text (optional)"), {
      target: { value: "€49" },
    });
    fireEvent.change(within(card).getByLabelText("Picture link (optional)"), {
      target: { value: "https://cdn.example.com/shirt.jpg" },
    });
    const preview = within(form).getByRole("figure", { name: "Message preview" });
    expect(preview).toHaveTextContent("Picture from cdn.example.com");
    expect(within(preview).queryByRole("img")).toBeNull();
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save template" }));
    });
    expect(create).toHaveBeenCalledWith({
      name: "Picks",
      content: {
        kind: "cards",
        cards: [
          {
            title: "Linen shirt",
            subtitle: "€49",
            imageUrl: "https://cdn.example.com/shirt.jpg",
            buttons: [],
          },
        ],
      },
    });
  });

  it("edits, explains a refusal in fixed words, and deletes after a confirmation", async () => {
    const update = mockMutation(UPDATE).mockRejectedValueOnce(
      apiError("CONFLICT", "server text", { reason: "name_in_use" }),
    );
    const remove = mockMutation(REMOVE).mockResolvedValue(null);
    renderWithOrg(<InstagramTemplatesView />);
    const card = screen.getByRole("listitem", { name: "Welcome" });
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form", { name: "Edit Instagram template" });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save template" }));
    });
    expect(update).toHaveBeenCalledWith({
      templateId: "t1",
      name: "Welcome",
      content: MENU.content,
    });
    expect(form).toHaveTextContent("Another template has this name. Choose another one.");
    expect(form).not.toHaveTextContent("server text");
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));

    fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
    const confirm = within(card).getByRole("group", { name: "Delete Welcome?" });
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    });
    expect(remove).toHaveBeenCalledWith({ templateId: "t1" });
    expect(screen.getByLabelText("Template deleted")).toBeInTheDocument();
  });

  it("offers every ready-made template, each with its preview", () => {
    renderWithOrg(<InstagramTemplatesView />);
    fireEvent.click(screen.getByRole("button", { name: "Ready-made templates" }));
    const gallery = screen.getByRole("region", { name: "Ready-made templates" });
    expect(within(gallery).getAllByRole("button", { name: "Use this template" })).toHaveLength(15);
    expect(within(gallery).getAllByRole("figure")).toHaveLength(15);
  });
});
