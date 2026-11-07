import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import type { Org } from "@/lib/analytics/types";
import { fillSavedReply } from "@/lib/messaging/saved-replies";
import { ORG } from "@/tests/unit/analytics-fixtures";
import {
  mockMutation,
  queryResults,
  renderWithOrg,
  resetHarness,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import SavedRepliesPage, { metadata } from "@/app/(dashboard)/inbox/saved-replies/page";
import { SavedRepliesView } from "./saved-replies-view";

// ADR 0021: the Saved replies page against the dashboard harness. The server checks every rule
// again (convex/messaging/savedReplies.test.ts).

const VIEWER: Org = { ...ORG, role: "viewer" };
const LIST = "v1/savedReplies:list";
const CREATE = "v1/savedReplies:create";
const UPDATE = "v1/savedReplies:update";
const REMOVE = "v1/savedReplies:remove";

const HOURS = {
  id: "r1",
  title: "Opening hours",
  text: "We're open 10 to 8.",
  channels: ["whatsapp", "instagram"] as ("whatsapp" | "instagram")[],
  updatedAt: "2026-11-03T10:00:00.000Z",
};

beforeEach(() => {
  resetHarness();
  queryResults.set(LIST, [HOURS]);
});

describe("fillSavedReply", () => {
  it("puts in the first name, or leaves the placeholder out cleanly", () => {
    expect(fillSavedReply("Hi {{customer_name}}, thanks!", "Ana Souza")).toBe("Hi Ana, thanks!");
    expect(fillSavedReply("Hi {{customer_name}}, thanks!", undefined)).toBe("Hi, thanks!");
    expect(fillSavedReply("Thank you, {{customer_name}}!", "  ")).toBe("Thank you!");
  });
});

describe("Saved replies page", () => {
  it("is the /inbox/saved-replies route, linked back to the inbox", () => {
    expect(metadata.title).toBe("Saved replies");
    renderWithOrg(<SavedRepliesPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Saved replies" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Inbox" })).toHaveAttribute("href", "/inbox");
  });

  it("lists the replies with their channels; viewers can only read", () => {
    renderWithOrg(<SavedRepliesView />, VIEWER);
    const card = screen.getByRole("listitem", { name: "Opening hours" });
    expect(card).toHaveTextContent("WhatsApp");
    expect(card).toHaveTextContent("Instagram");
    expect(card).toHaveTextContent("We're open 10 to 8.");
    expect(screen.queryByRole("button", { name: "New saved reply" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("adds one from a ready-made reply, with its quick replies", async () => {
    const create = mockMutation(CREATE).mockResolvedValue({ ...HOURS, id: "r2", title: "Welcome" });
    renderWithOrg(<SavedRepliesView />);
    fireEvent.click(screen.getByRole("button", { name: "Ready-made replies" }));
    const welcome = screen.getByRole("listitem", { name: "Welcome" });
    fireEvent.click(within(welcome).getByRole("button", { name: "Use this reply" }));
    const form = screen.getByRole("form", { name: "New saved reply" });
    expect(within(form).getByLabelText("Title")).toHaveValue("Welcome");
    expect(within(form).getByRole("list", { name: "Quick-reply buttons" })).toHaveTextContent(
      "Prices",
    );
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    });
    expect(create).toHaveBeenCalledWith({
      title: "Welcome",
      text: "Hi {{customer_name}}, thanks for reaching out! How can we help you today?",
      channels: ["whatsapp", "instagram"],
      quickReplies: ["Prices", "Order status", "Talk to us"],
    });
    expect(screen.getByLabelText("Saved reply added")).toBeInTheDocument();
  });

  it("writes one from scratch: WhatsApp only sends no quick replies, and the counter follows the channel", async () => {
    const create = mockMutation(CREATE).mockResolvedValue({ ...HOURS, id: "r3", title: "Bulk" });
    renderWithOrg(<SavedRepliesView />);
    fireEvent.click(screen.getByRole("button", { name: "New saved reply" }));
    const form = screen.getByRole("form", { name: "New saved reply" });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Bulk" } });
    fireEvent.change(within(form).getByLabelText("Reply"), { target: { value: "Yes, we do" } });
    fireEvent.click(within(form).getByRole("button", { name: "Insert customer name" }));
    expect(within(form).getByLabelText("Reply")).toHaveValue("Yes, we do {{customer_name}}");
    expect(form).toHaveTextContent("bytes (Instagram's limit)");
    fireEvent.click(within(form).getByLabelText("Instagram"));
    expect(form).toHaveTextContent("characters");
    expect(within(form).queryByRole("group", { name: /Quick-reply buttons/ })).toBeNull();
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    });
    expect(create).toHaveBeenCalledWith({
      title: "Bulk",
      text: "Yes, we do {{customer_name}}",
      channels: ["whatsapp"],
    });
  });

  it("edits, explains a refusal, and deletes after a confirmation", async () => {
    const update = mockMutation(UPDATE).mockRejectedValueOnce(
      apiError("CONFLICT", "server text", { reason: "title_in_use" }),
    );
    const remove = mockMutation(REMOVE).mockResolvedValue(null);
    renderWithOrg(<SavedRepliesView />);
    const card = screen.getByRole("listitem", { name: "Opening hours" });
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form", { name: "Edit saved reply" });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ savedReplyId: "r1" }));
    expect(screen.getByLabelText("Saved reply not saved")).toHaveTextContent(
      "Another saved reply has this title",
    );
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));

    fireEvent.click(
      within(screen.getByRole("listitem", { name: "Opening hours" })).getByRole("button", {
        name: "Delete",
      }),
    );
    const confirm = screen.getByRole("group", { name: "Delete Opening hours?" });
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    });
    expect(remove).toHaveBeenCalledWith({ savedReplyId: "r1" });
    expect(screen.getByLabelText("Saved reply deleted")).toBeInTheDocument();
  });

  it("offers the channels as checkboxes, and Escape closes a delete confirmation", () => {
    const remove = mockMutation(REMOVE);
    renderWithOrg(<SavedRepliesView />);
    fireEvent.click(screen.getByRole("button", { name: "New saved reply" }));
    const form = screen.getByRole("form", { name: "New saved reply" });
    const instagram = within(form).getByRole("checkbox", { name: "Instagram" });
    expect(instagram).toBeChecked();
    fireEvent.click(instagram);
    expect(instagram).not.toBeChecked();
    expect(within(form).getByRole("checkbox", { name: "WhatsApp" })).toBeChecked();
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));

    const card = screen.getByRole("listitem", { name: "Opening hours" });
    fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
    fireEvent.keyDown(screen.getByRole("group", { name: "Delete Opening hours?" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("group", { name: "Delete Opening hours?" })).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });
});
