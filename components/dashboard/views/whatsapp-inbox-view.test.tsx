import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Org } from "@/lib/analytics/types";
import type { WhatsAppConversation } from "@/lib/whatsapp/types";
import { ORG } from "@/tests/unit/analytics-fixtures";
import {
  lastArgs,
  loadMoreMock,
  queryResults,
  renderWithOrg,
  resetHarness,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import WhatsAppPage, { metadata } from "@/app/(dashboard)/whatsapp/page";
import { formatInstant } from "../freshness-note";
import { WhatsAppInboxView } from "./whatsapp-inbox-view";

// The WhatsApp inbox (ADR 0013): the org's conversations, newest activity first, each opening
// its thread. Read through the dashboard harness (v1/whatsapp:listConversations).

const LIST = "v1/whatsapp:listConversations";
const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const VIEWER: Org = { ...ORG, role: "viewer" };

function conversation(overrides: Partial<WhatsAppConversation> = {}): WhatsAppConversation {
  return {
    id: "conv1",
    phoneNumberId: "200000000000001",
    displayPhoneNumber: "+1 555-000-0001",
    contactWaId: "15550001111",
    contactName: "Ana",
    lastMessageAt: "2026-10-24T11:30:00.000Z",
    lastInboundAt: "2026-10-24T11:30:00.000Z",
    serviceWindowExpiresAt: "2026-10-25T11:30:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  resetHarness();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WhatsApp inbox", () => {
  it("is the /whatsapp route, titled WhatsApp, with a link to the settings", () => {
    expect(metadata.title).toBe("WhatsApp");
    queryResults.set(LIST, { page: [], isDone: true, continueCursor: "" });
    renderWithOrg(<WhatsAppPage />);
    expect(screen.getByRole("heading", { level: 1, name: "WhatsApp" })).toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: "WhatsApp settings" })) {
      expect(link).toHaveAttribute("href", "/whatsapp/settings");
    }
  });

  it("shows a labelled placeholder while the conversations load", () => {
    renderWithOrg(<WhatsAppInboxView />);
    expect(screen.getByRole("status", { name: "Loading conversations" })).toBeInTheDocument();
  });

  it("explains an empty inbox and points to the settings", () => {
    queryResults.set(LIST, { page: [], isDone: true, continueCursor: "" });
    renderWithOrg(<WhatsAppInboxView />);
    expect(screen.getByText("No conversations yet")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "WhatsApp settings" }).length).toBeGreaterThan(1);
  });

  it("lists every conversation as a link to its thread, with its number, time and window", () => {
    queryResults.set(LIST, {
      page: [
        conversation(),
        conversation({
          id: "conv2",
          contactName: undefined,
          contactWaId: "15550002222",
          displayPhoneNumber: undefined,
          lastMessageAt: "2026-10-22T09:00:00.000Z",
          serviceWindowExpiresAt: "2026-10-23T09:00:00.000Z",
        }),
      ],
      isDone: true,
      continueCursor: "",
    });
    renderWithOrg(<WhatsAppInboxView />);
    const items = within(screen.getByRole("list", { name: "Conversations" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(2);

    const first = within(items[0]!).getByRole("link");
    expect(first).toHaveAttribute("href", "/whatsapp/conversations/conv1");
    expect(first).toHaveTextContent("Ana");
    expect(first).toHaveTextContent("To +1 555-000-0001");
    expect(first).toHaveTextContent("Reply window open");
    expect(first).toHaveTextContent(formatInstant("2026-10-24T11:30:00.000Z", ORG.timezone));

    const second = within(items[1]!).getByRole("link");
    expect(second).toHaveAttribute("href", "/whatsapp/conversations/conv2");
    expect(second).toHaveTextContent("+15550002222");
    expect(second).toHaveTextContent("To 200000000000001");
    expect(second).toHaveTextContent("Templates only");
    expect(screen.queryByRole("button", { name: "Show more conversations" })).toBeNull();
  });

  it("reads the newest page first and loads more on request", () => {
    queryResults.set(LIST, { page: [conversation()], isDone: false, continueCursor: "c1" });
    renderWithOrg(<WhatsAppInboxView />);
    expect(lastArgs(LIST)).toEqual({ paginationOpts: { numItems: 25, cursor: null } });
    fireEvent.click(screen.getByRole("button", { name: "Show more conversations" }));
    expect(loadMoreMock).toHaveBeenCalledWith(25);
  });

  it("shows viewers the same inbox (reading needs no role)", () => {
    queryResults.set(LIST, { page: [conversation()], isDone: true, continueCursor: "" });
    renderWithOrg(<WhatsAppInboxView />, VIEWER);
    expect(screen.getByRole("link", { name: /Ana/ })).toBeInTheDocument();
  });

  it("shows a failed read as an alert, without any message from the server", () => {
    queryResults.set(LIST, () => {
      throw new Error("internal details that must not be shown");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithOrg(<WhatsAppInboxView />);
    const alert = screen.getByRole("alert");
    expect(alert).not.toHaveTextContent("internal details");
  });
});
