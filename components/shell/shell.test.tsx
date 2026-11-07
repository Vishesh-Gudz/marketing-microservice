import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activeHref, navTrail } from "@/components/dashboard/nav";
import { auth, resetHarness, setUrl } from "@/tests/unit/dashboard-harness";

const push = vi.hoisted(() => vi.fn());

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => {
  const { navigation } = await import("@/tests/unit/dashboard-harness");
  return { ...navigation, useRouter: () => ({ ...navigation.useRouter(), push }) };
});

import { AppShell } from "@/components/dashboard/app-shell";
import { bestMatchIndex, searchPages } from "./command-palette";

describe("navigation helpers", () => {
  it("marks the longest matching page as current", () => {
    expect(activeHref("/")).toBe("/");
    expect(activeHref("/campaigns/abc")).toBe("/campaigns");
    expect(activeHref("/inbox")).toBe("/inbox");
    expect(activeHref("/inbox/saved-replies")).toBe("/inbox/saved-replies");
    expect(activeHref("/whatsapp/conversations/x")).toBe("/whatsapp");
    expect(activeHref("/instagram/messages/templates")).toBe("/instagram/messages/templates");
    expect(activeHref("/sign-in")).toBeUndefined();
  });

  it("names where a page sits", () => {
    expect(navTrail("/")).toEqual(["Overview"]);
    expect(navTrail("/campaigns/abc")).toEqual(["Analytics", "Campaigns"]);
    expect(navTrail("/whatsapp/templates")).toEqual(["Templates", "WhatsApp"]);
    expect(navTrail("/instagram/messages/settings")).toEqual(["Settings", "Instagram"]);
    expect(navTrail("/connections")).toEqual(["Connections"]);
    expect(navTrail("/sign-in")).toEqual([]);
  });

  it("finds pages by name, section and keywords", () => {
    const names = (text: string) => searchPages(text).map((link) => link.name);
    expect(names("")).toHaveLength(16);
    expect(names("temp")).toEqual(["WhatsApp templates", "Instagram templates"]);
    expect(names("members")).toEqual(["Organization"]);
    expect(names("insta settings")).toEqual(["Instagram DM settings"]);
    expect(names("ANALYTICS camp")).toEqual(["Campaigns"]);
    expect(names("nothing like this")).toEqual([]);
  });

  it("splits what is typed at spaces, not at the letter s", () => {
    // Overview matches "s" only by a keyword ("spend"); the highlight goes to a page whose own
    // name has an s. Splitting at "s" left no word, so Overview was highlighted.
    const results = searchPages("s");
    expect(results[0]!.name).toBe("Overview");
    expect(results[bestMatchIndex(results, "s")]!.name.toLowerCase()).toContain("s");
  });
});

describe("⌘K palette", () => {
  beforeEach(() => {
    resetHarness();
    push.mockReset();
    auth.isAuthenticated = false;
  });

  function openWithShortcut() {
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    return screen.getByRole("dialog", { name: "Go to a page" });
  }

  it("opens with ⌘K or Ctrl+K and goes to the chosen page with the global filters", () => {
    setUrl("/campaigns", "preset=last_7_days&sort=name");
    render(<AppShell>content</AppShell>);
    const dialog = openWithShortcut();
    const input = within(dialog).getByRole("combobox", { name: "Search pages" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "breakdown" } });
    const options = within(dialog).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Breakdowns"]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/breakdowns?preset=last_7_days");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "K", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Go to a page" })).toBeInTheDocument();
  });

  it("moves through the results with the arrow keys, wrapping around", () => {
    render(<AppShell>content</AppShell>);
    const dialog = openWithShortcut();
    const input = within(dialog).getByRole("combobox");
    fireEvent.change(input, { target: { value: "templates" } });
    const [first, second] = within(dialog).getAllByRole("option");
    expect(input).toHaveAttribute("aria-activedescendant", first!.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", second!.id);
    expect(second).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", first!.id);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", second!.id);
    fireEvent.click(first!);
    expect(push).toHaveBeenCalledWith("/whatsapp/templates");
  });

  it("highlights the page whose name matches before pages matched by keyword", () => {
    render(<AppShell>content</AppShell>);
    const dialog = openWithShortcut();
    const input = within(dialog).getByRole("combobox");
    // "conv" also matches Inbox ("conversations" is one of its keywords), listed first.
    fireEvent.change(input, { target: { value: "conv" } });
    const options = within(dialog).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Inbox", "Conversions"]);
    expect(input).toHaveAttribute("aria-activedescendant", options[1]!.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/conversions");
  });

  it("tags a grouped page with its group only when the name does not already say it", () => {
    render(<AppShell>content</AppShell>);
    const dialog = openWithShortcut();
    const input = within(dialog).getByRole("combobox");
    fireEvent.change(input, { target: { value: "whatsapp templates" } });
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["WhatsApp templates"]);
    fireEvent.change(input, { target: { value: "organization" } });
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["OrganizationSettings"]);
  });

  it("says when nothing matches", () => {
    render(<AppShell>content</AppShell>);
    const dialog = openWithShortcut();
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "zzz" } });
    expect(within(dialog).queryAllByRole("option")).toHaveLength(0);
    expect(within(dialog).getByRole("status")).toHaveTextContent("No pages match “zzz”.");
  });

  it("opens from the top bar's search button", () => {
    render(<AppShell>content</AppShell>);
    fireEvent.click(
      within(screen.getByRole("banner")).getByRole("button", { name: "Search pages" }),
    );
    expect(screen.getByRole("dialog", { name: "Go to a page" })).toBeInTheDocument();
  });
});

describe("sidebar", () => {
  beforeEach(() => {
    resetHarness();
    window.localStorage.clear();
    auth.isAuthenticated = false;
  });

  it("collapses to an icon rail, remembers it, and keeps every link named", () => {
    setUrl("/campaigns");
    const { unmount } = render(<AppShell>content</AppShell>);
    const sidebar = screen.getByTestId("sidebar");
    expect(sidebar).not.toHaveAttribute("data-collapsed");
    fireEvent.click(within(sidebar).getByRole("button", { name: "Collapse" }));
    expect(sidebar).toHaveAttribute("data-collapsed", "true");
    expect(window.localStorage.getItem("gudz-marketing.sidebar")).toBe("collapsed");
    const nav = within(sidebar).getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Campaigns" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Groups become menus on the rail.
    expect(within(nav).getByRole("button", { name: "Templates" })).toHaveAttribute(
      "aria-haspopup",
      "menu",
    );
    unmount();

    render(<AppShell>content</AppShell>);
    const again = screen.getByTestId("sidebar");
    expect(again).toHaveAttribute("data-collapsed", "true");
    fireEvent.click(within(again).getByRole("button", { name: "Expand sidebar" }));
    expect(again).not.toHaveAttribute("data-collapsed");
    expect(window.localStorage.getItem("gudz-marketing.sidebar")).toBe("expanded");
  });
});
