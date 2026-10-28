import { fireEvent, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ORG } from "@/tests/unit/analytics-fixtures";
import {
  lastArgs,
  lastReplacedQuery,
  queryResults,
  renderWithOrg,
  resetHarness,
  setUrl,
} from "@/tests/unit/dashboard-harness";
import { socialAccount } from "@/tests/unit/organic-fixtures";
import {
  CHANNEL_ID,
  CHANNEL_ID_2,
  channelDays,
  videoStatistics,
  youtubeChannel,
  youtubeDay,
  youtubeVideo,
} from "@/tests/unit/youtube-fixtures";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import { SocialView } from "./social-view";

// /social?platform=youtube (ADR 0016, Checkpoint 5): one channel, YouTube's Pacific Time days,
// values exactly as reported (no totals, rates or comparisons), lifetime video statistics.

const NEW_YORK = { ...ORG, timezone: "America/New_York" };
const page = <T,>(items: T[], isDone = true) => ({ page: items, isDone, continueCursor: "c1" });

describe("YouTube view", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 05:00 UTC on Oct 21 = Oct 20 in Los Angeles (and Oct 21 in UTC).
    vi.setSystemTime(new Date("2026-10-21T05:00:00Z"));
  });
  afterAll(() => vi.useRealTimers());

  beforeEach(() => {
    resetHarness();
    setUrl("/social", "platform=youtube");
    queryResults.set(
      "v1/socialAccounts:list",
      page([
        socialAccount(),
        youtubeChannel(),
        youtubeChannel({ id: CHANNEL_ID_2, name: "Second", username: "second" }),
      ]),
    );
    queryResults.set("v1/youtubeAnalytics:channelDays", channelDays());
    queryResults.set("v1/youtubeAnalytics:videos", page([youtubeVideo()]));
  });

  it("selects the first channel and resolves presets against today in Pacific Time", () => {
    renderWithOrg(<SocialView />, NEW_YORK);
    expect(screen.getByRole("heading", { level: 1, name: "YouTube (organic)" })).toBeVisible();
    expect(lastArgs("v1/youtubeAnalytics:channelDays")).toEqual({
      socialAccountId: CHANNEL_ID,
      // last_30_days against Oct 20 (Pacific), not Oct 21 (UTC) or the org's day.
      range: { from: "2026-09-20", to: "2026-10-19" },
    });
    expect(lastArgs("v1/youtubeAnalytics:videos")).toEqual({
      socialAccountId: CHANNEL_ID,
      publishedFrom: "2026-09-20",
      publishedTo: "2026-10-19",
      sort: { by: "publishedAt", dir: "desc" },
      paginationOpts: { numItems: 25, cursor: null },
    });
    expect(screen.getByTestId("day-basis")).toHaveTextContent(
      "Channel metrics use YouTube's Pacific Time days and presets use Pacific Time; video publish dates use America/New_York.",
    );
    // No comparison control: YouTube values are never compared across periods.
    expect(screen.queryByText("Compare")).toBeNull();
    // Only YouTube channels are offered; the Instagram account is not.
    const picker = screen.getByRole("combobox", { name: "YouTube channel" });
    expect(picker).toHaveTextContent("@fakebrand · Channel");
    const summary = screen.getByTestId("youtube-channel-summary");
    expect(summary).toHaveTextContent("Source: YouTube");
    expect(screen.getByTestId("youtube-freshness")).toHaveTextContent(
      "Channel days synced through Oct 17, 2026 (Pacific Time)",
    );
  });

  it("switches channels through the URL and keeps the selected one", () => {
    setUrl("/social", `platform=youtube&account=${CHANNEL_ID_2}&pdir=asc`);
    renderWithOrg(<SocialView />);
    expect(lastArgs("v1/youtubeAnalytics:channelDays")).toMatchObject({
      socialAccountId: CHANNEL_ID_2,
    });
    expect(lastArgs("v1/youtubeAnalytics:videos")).toMatchObject({
      socialAccountId: CHANNEL_ID_2,
      sort: { by: "publishedAt", dir: "asc" },
    });
    expect(screen.getByRole("combobox", { name: "YouTube channel" })).toHaveTextContent("@second");
  });

  it("shows every day with its status, values as reported and no total, rate or comparison", () => {
    queryResults.set(
      "v1/youtubeAnalytics:channelDays",
      channelDays({
        dataState: "partial",
        range: { from: "2026-10-15", to: "2026-10-18" },
        coverage: { syncedDays: 3, unsyncedDays: 1 },
        days: [
          youtubeDay("2026-10-15"),
          youtubeDay("2026-10-16", {
            metrics: { views: 7 },
            unavailableMetrics: [{ metric: "shares", reason: "not_reported" }],
          }),
          youtubeDay("2026-10-17", { status: "not_reported", metrics: {} }),
          youtubeDay("2026-10-18", { status: "unknown", metrics: {} }),
        ],
      }),
    );
    renderWithOrg(<SocialView />);
    const section = screen.getByTestId("youtube-channel-days");
    expect(
      within(section).getByRole("heading", { name: "Daily channel metrics (Pacific Time)" }),
    ).toBeVisible();
    const table = within(section).getByRole("table", { name: /Pacific Time/ });
    const rows = within(table).getAllByRole("row").slice(1);
    // Newest first, one row per day.
    expect(rows.map((row) => row.getAttribute("data-day"))).toEqual([
      "2026-10-18",
      "2026-10-17",
      "2026-10-16",
      "2026-10-15",
    ]);
    expect(rows[0]).toHaveTextContent("Unknown");
    expect(rows[1]).toHaveTextContent("Not reported");
    // Unknown and not-reported days have no value at all: "—", never a number (or 0).
    for (const row of rows.slice(0, 2)) {
      for (const cell of within(row).getAllByRole("cell").slice(2)) {
        expect(cell.textContent).not.toMatch(/\d/);
        expect(cell).toHaveTextContent("—");
      }
    }
    // A metric the reported day lacks is "—" with its reason, never 0.
    // (2026-10-16 reported views only: the 7 other metrics each say why they are missing.)
    expect(
      within(rows[2]!).getAllByText("Not available: Not reported by YouTube for this day", {
        exact: false,
      }),
    ).toHaveLength(7);
    expect(within(rows[2]!).getAllByRole("cell")[2]).toHaveTextContent(/^7$/); // views
    expect(rows[3]).toHaveTextContent("1,200");
    expect(rows[3]).toHaveTextContent("1:23"); // average view duration, as reported
    expect(within(rows[3]!).getAllByRole("cell")[3]).toHaveTextContent(/^0$/); // likes: a reported 0 stays 0
    // Coverage is stated; there is no total, average, rate or comparison anywhere.
    expect(screen.getByRole("status", { name: "Partial data" })).toHaveTextContent(
      "Partial: 1 Pacific Time day of this range not synced yet (3 synced)",
    );
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Total|Engagement rate|compared with|Average daily|%/);
  });

  it("explains a range with no synced day", () => {
    queryResults.set(
      "v1/youtubeAnalytics:channelDays",
      channelDays({
        dataState: "unknown",
        coverage: { syncedDays: 0, unsyncedDays: 3 },
        days: ["2026-10-18", "2026-10-19", "2026-10-20"].map((date) =>
          youtubeDay(date, { status: "unknown", metrics: {} }),
        ),
      }),
    );
    renderWithOrg(<SocialView />);
    expect(screen.getByRole("status", { name: "Data not synced" })).toHaveTextContent(
      "missing values are never shown as zero",
    );
  });

  it.each([
    ["scope_missing", "YouTube Analytics access is missing", true],
    ["reauth_required", "Reconnect required", true],
    ["not_linked", "Not linked", false],
  ] as const)("states the %s access accurately", (access, title, linksToConnections) => {
    queryResults.set("v1/youtubeAnalytics:channelDays", channelDays({ analyticsAccess: access }));
    renderWithOrg(<SocialView />);
    const notice = screen.getByLabelText(title);
    expect(notice).toBeInTheDocument();
    expect(within(notice).queryByRole("link", { name: "Go to Connections" }) !== null).toBe(
      linksToConnections,
    );
    if (access === "scope_missing") {
      expect(notice).toHaveTextContent("Its videos and their statistics keep syncing.");
    }
  });

  it("lists videos with lifetime statistics, safe YouTube links and cursor pagination", () => {
    queryResults.set("v1/youtubeAnalytics:videos", (args: Record<string, unknown>) => {
      const cursor = (args.paginationOpts as { cursor: string | null }).cursor;
      return cursor === null
        ? page(
            [
              youtubeVideo(),
              youtubeVideo({
                id: "post_yt_2",
                videoId: "vid00000001",
                title: undefined,
                permalink: "javascript:alert(1)",
                dataState: "partial",
                latest: videoStatistics({
                  dataState: "partial",
                  metrics: { views: 50, comments: 0 },
                  unavailableMetrics: [{ metric: "likes", reason: "not_reported" }],
                }),
              }),
              youtubeVideo({
                id: "post_yt_3",
                dataState: "unknown",
                latest: undefined,
                removedAt: "2026-10-20T00:00:00.000Z",
              }),
            ],
            false,
          )
        : page([youtubeVideo({ id: "post_yt_4", title: "Older" })]);
    });
    renderWithOrg(<SocialView />);
    const rows = screen.getAllByRole("row").filter((row) => row.hasAttribute("data-video-id"));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Launch video");
    expect(rows[0]).toHaveTextContent("9,876");
    const link = within(rows[0]!).getByRole("link", { name: /Watch on YouTube/ });
    expect(link).toHaveAttribute("href", "https://www.youtube.com/watch?v=vid00000000");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAccessibleName(/Launch video \(opens in a new tab\)/);
    // An unsafe URL never becomes a link; a hidden count is "—" (never 0).
    expect(within(rows[1]!).queryByRole("link")).toBeNull();
    expect(rows[1]).toHaveTextContent("Untitled video");
    expect(
      within(rows[1]!).getByText(/hidden or disabled by the channel owner/, { exact: false }),
    ).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent("Removed");
    expect(rows[2]).toHaveTextContent("Not synced"); // never captured: no value, never 0

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(lastArgs("v1/youtubeAnalytics:videos")).toMatchObject({
      paginationOpts: { numItems: 25, cursor: "c1" },
    });
    expect(screen.getByText("Page 2")).toBeInTheDocument();
    expect(screen.getByText("Older")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(lastArgs("v1/youtubeAnalytics:videos")).toMatchObject({
      paginationOpts: { cursor: null },
    });
  });

  it("orders videos by publish time through the URL", () => {
    renderWithOrg(<SocialView />);
    fireEvent.click(screen.getByRole("button", { name: /Video \(published\)/ }));
    expect(lastReplacedQuery().get("pdir")).toBe("asc");
  });

  it("without channels: an empty state that points to Connections, and no data queries", () => {
    queryResults.set("v1/socialAccounts:list", page([socialAccount()]));
    renderWithOrg(<SocialView />);
    expect(screen.getByText("No YouTube channel connected")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Connect YouTube on the Connections page" }),
    ).toHaveAttribute("href", "/connections");
    expect(lastArgs("v1/youtubeAnalytics:channelDays")).toBeUndefined();
  });

  it("a channel being deleted shows the deletion, not stale data", () => {
    queryResults.set(
      "v1/socialAccounts:list",
      page([youtubeChannel({ status: "disconnected", linked: false, connectionId: undefined })]),
    );
    renderWithOrg(<SocialView />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "This channel's stored YouTube data is being deleted",
    );
    expect(lastArgs("v1/youtubeAnalytics:channelDays")).toBeUndefined();
  });

  it("an Instagram or unknown id in the URL is not shown as a YouTube channel", () => {
    setUrl("/social", "platform=youtube&account=acct_ig_1");
    renderWithOrg(<SocialView />);
    expect(screen.getByText("This YouTube channel is not available")).toBeInTheDocument();
    expect(lastArgs("v1/youtubeAnalytics:channelDays")).toBeUndefined();
  });

  it("the platform switch links Instagram and YouTube without carrying the account", () => {
    setUrl("/social", `platform=youtube&account=${CHANNEL_ID}&preset=last_7_days`);
    renderWithOrg(<SocialView />);
    const nav = screen.getByRole("navigation", { name: "Organic platform" });
    expect(within(nav).getByRole("link", { name: "YouTube" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Instagram" })).toHaveAttribute(
      "href",
      "/social?preset=last_7_days",
    );
    expect(within(nav).getByRole("link", { name: "YouTube" })).toHaveAttribute(
      "href",
      "/social?preset=last_7_days&platform=youtube",
    );
  });

  it("points to the deletion option on the Connections page", () => {
    renderWithOrg(<SocialView />);
    expect(screen.getByText(/To delete this channel's stored YouTube data/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connections" })).toHaveAttribute(
      "href",
      "/connections",
    );
  });
});

describe("Instagram view on /social (regression)", () => {
  beforeEach(() => {
    resetHarness();
    setUrl("/social");
    queryResults.set("v1/socialAccounts:list", page([youtubeChannel(), socialAccount()]));
  });

  it("is the default and lists Instagram accounts only", () => {
    renderWithOrg(<SocialView />);
    expect(screen.getByRole("heading", { level: 1, name: "Instagram (organic)" })).toBeVisible();
    const nav = screen.getByRole("navigation", { name: "Organic platform" });
    expect(within(nav).getByRole("link", { name: "Instagram" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // The YouTube channel listed first is skipped: the Instagram account is selected.
    expect(screen.getByRole("combobox", { name: "Instagram account" })).toHaveTextContent(
      "@mock_1 · Business",
    );
    expect(lastArgs("v1/organicAnalytics:overview")).toMatchObject({
      socialAccountIds: ["acct_ig_1"],
    });
    expect(lastArgs("v1/youtubeAnalytics:channelDays")).toBeUndefined();
  });

  it("an org with YouTube only shows the Instagram empty state, with the switch", () => {
    queryResults.set("v1/socialAccounts:list", page([youtubeChannel()]));
    renderWithOrg(<SocialView />);
    expect(screen.getByText("No Instagram account connected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "YouTube" })).toBeInTheDocument();
  });
});
