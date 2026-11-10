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
  videoWindow,
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
    // Coverage is stated; the day table has no total row, and nothing is compared or rated.
    expect(screen.getByRole("status", { name: "Partial data" })).toHaveTextContent(
      "Partial: 1 Pacific Time day of this range not synced yet (3 synced)",
    );
    expect(within(table).queryByText(/Total/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Engagement rate|compared with|Average daily/);
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
      expect(notice).toHaveTextContent("Its videos and their public counts keep syncing.");
    }
  });

  it("shows the range's key metrics as the server totals them, with the current subscribers", () => {
    renderWithOrg(<SocialView />, NEW_YORK);
    const totals = screen.getByTestId("youtube-totals");
    expect(within(totals).getByRole("heading", { name: "Key metrics" })).toBeVisible();
    expect(totals).toHaveTextContent(
      "Totals over the 3 reported Pacific Time days of Oct 15, 2026 – Oct 17, 2026.",
    );
    const kpi = (key: string) => totals.querySelector(`[data-kpi="${key}"]`)!;
    expect(
      [...totals.querySelectorAll("[data-kpi] h3")].map((heading) => heading.textContent),
    ).toEqual([
      "Subscribers",
      "Views",
      "Watch time (hours)",
      "Avg. view duration",
      "Net subscribers",
      "Likes",
      "Comments",
      "Shares",
    ]);
    expect(kpi("subscribers")).toHaveTextContent("12,300as of Oct 20, 2026");
    expect(kpi("views")).toHaveTextContent(/^Views3,600$/);
    // Minutes are shown as hours (display only); the server's minutes stay visible.
    expect(kpi("estimatedMinutesWatched")).toHaveTextContent("172.810,368 est. minutes");
    expect(kpi("averageViewDuration")).toHaveTextContent("2:53");
    expect(kpi("subscribersNet")).toHaveTextContent("+1215 gained, 3 lost");
    expect(kpi("likes")).toHaveTextContent(/^Likes0$/); // a reported 0 stays 0
  });

  it("marks partial totals and explains every missing key metric, never 0", () => {
    queryResults.set(
      "v1/youtubeAnalytics:channelDays",
      channelDays({
        dataState: "partial",
        coverage: { syncedDays: 2, unsyncedDays: 1 },
        subscribers: undefined,
        totals: {
          reportedDays: 2,
          metrics: { views: 0, estimatedMinutesWatched: 0, likes: 0 },
          unavailableMetrics: [
            { metric: "comments", reason: "not_reported" },
            { metric: "averageViewDuration", reason: "zero_views" },
          ],
        },
      }),
    );
    renderWithOrg(<SocialView />);
    const totals = screen.getByTestId("youtube-totals");
    const kpi = (key: string) => totals.querySelector(`[data-kpi="${key}"]`)!;
    expect(kpi("views")).toHaveTextContent("0* (partial data)");
    expect(kpi("subscribers")).toHaveTextContent(
      "Not available: Hidden by the channel, or not captured yet",
    );
    expect(kpi("averageViewDuration")).toHaveTextContent(
      "Not available: Not defined: this range has no views",
    );
    expect(kpi("comments")).toHaveTextContent(
      "Not available: Not reported by YouTube for any day of this range",
    );
    for (const key of ["subscribers", "averageViewDuration", "comments", "subscribersNet"]) {
      expect(kpi(key).textContent).not.toMatch(/\d/);
    }
    // The coverage notice sits with the key metrics.
    expect(within(totals).getByRole("status", { name: "Partial data" })).toBeInTheDocument();
  });

  it("names a missing YouTube Analytics grant as the reason for empty key metrics", () => {
    queryResults.set(
      "v1/youtubeAnalytics:channelDays",
      channelDays({
        analyticsAccess: "scope_missing",
        dataState: "reported",
        totals: {
          reportedDays: 0,
          metrics: {},
          unavailableMetrics: [{ metric: "views", reason: "not_reported" }],
        },
        days: [youtubeDay("2026-10-15", { status: "not_reported", metrics: {} })],
      }),
    );
    renderWithOrg(<SocialView />);
    const totals = screen.getByTestId("youtube-totals");
    expect(totals.querySelector('[data-kpi="views"]')).toHaveTextContent(
      "Not available: YouTube Analytics access is missing for this channel",
    );
    expect(totals).toHaveTextContent(
      "No Pacific Time day of Oct 15, 2026 – Oct 17, 2026 is reported yet.",
    );
  });

  it("charts the server's per-day values with gaps, and offers them as a table", () => {
    queryResults.set(
      "v1/youtubeAnalytics:channelDays",
      channelDays({
        days: [
          youtubeDay("2026-10-15"),
          youtubeDay("2026-10-16", { status: "not_reported", metrics: {} }),
          youtubeDay("2026-10-17", { status: "unknown", metrics: {} }),
        ],
      }),
    );
    renderWithOrg(<SocialView />);
    const chart = screen.getByTestId("youtube-series");
    expect(within(chart).getByRole("heading", { name: "Channel metrics by day" })).toBeVisible();
    expect(within(chart).getByRole("combobox", { name: "Chart metric" })).toHaveTextContent(
      "Views",
    );
    expect(within(chart).getByRole("img", { name: "Views by day (Pacific Time)" })).toBeVisible();
    fireEvent.click(within(chart).getByRole("button", { name: "View as table" }));
    const rows = within(chart).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      "Oct 15, 20261,200Reported",
      "Oct 16, 2026—Not reported",
      "Oct 17, 2026—Unknown",
    ]);
  });

  it("lists videos with one period's analytics, safe YouTube links and cursor pagination", () => {
    queryResults.set("v1/youtubeAnalytics:videos", (args: Record<string, unknown>) => {
      const cursor = (args.paginationOpts as { cursor: string | null }).cursor;
      return cursor === null
        ? page(
            [
              youtubeVideo({ analytics: { last28: videoWindow() } }),
              youtubeVideo({
                id: "post_yt_2",
                videoId: "vid00000001",
                title: undefined,
                permalink: "javascript:alert(1)",
                analytics: {
                  last28: videoWindow({ status: "not_in_top", metrics: {} }),
                  lifetime: videoWindow({ from: "2024-03-12" }),
                },
              }),
              youtubeVideo({
                id: "post_yt_3",
                analytics: {},
                removedAt: "2026-10-20T00:00:00.000Z",
              }),
              youtubeVideo({
                id: "post_yt_4",
                analytics: {
                  last28: videoWindow({ metrics: { views: 5, estimatedMinutesWatched: 2 } }),
                },
              }),
            ],
            false,
          )
        : page([youtubeVideo({ id: "post_yt_5", title: "Older" })]);
    });
    renderWithOrg(<SocialView />);
    const section = screen.getByTestId("youtube-videos");
    expect(section).toHaveTextContent(
      "Last 28 days: Sep 20, 2026 – Oct 17, 2026 (Pacific Time), from YouTube Analytics",
    );
    const table = within(section).getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual([
      "Video (published), sorted newest first",
      "Views",
      "Watch time (hours)",
      "Avg. view duration",
      "Avg. % viewed",
      "Likes",
      "Comments",
      "Shares",
      "Subscribers gained",
      "YouTube link",
    ]);
    const rows = within(table)
      .getAllByRole("row")
      .filter((row) => row.hasAttribute("data-video-id"));
    expect(rows).toHaveLength(4);
    expect(
      within(rows[0]!)
        .getAllByRole("cell")
        .slice(1, -1)
        .map((cell) => cell.textContent),
    ).toEqual(["4,321", "164.6", "2:17", "45.3%", "210", "0", "17", "12"]);
    // The title opens the video's page with the list's state; YouTube opens in a new tab.
    expect(within(rows[0]!).getByRole("link", { name: "Launch video" })).toHaveAttribute(
      "href",
      `/social/youtube/videos/post_yt_1?account=${CHANNEL_ID}`,
    );
    const link = within(rows[0]!).getByRole("link", { name: /Watch on YouTube/ });
    expect(link).toHaveAttribute("href", "https://www.youtube.com/watch?v=vid00000000");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAccessibleName(/Launch video \(opens in a new tab\)/);
    // Outside the top 200 or not synced: one cell says so; never a number (or 0).
    expect(rows[1]).toHaveAttribute("data-window-state", "not_in_top");
    expect(within(rows[1]!).getAllByRole("cell")[1]).toHaveTextContent(
      /^Not in YouTube's top 200$/,
    );
    expect(within(rows[1]!).getByRole("link", { name: "Untitled video" })).toBeInTheDocument();
    expect(within(rows[1]!).queryByRole("link", { name: /Watch on YouTube/ })).toBeNull();
    expect(rows[2]).toHaveAttribute("data-window-state", "not_synced");
    expect(within(rows[2]!).getAllByRole("cell")[1]).toHaveTextContent(/^Not synced yet$/);
    expect(rows[2]).toHaveTextContent("Removed");
    for (const row of rows.slice(1, 3)) {
      for (const cell of within(row).getAllByRole("cell").slice(1)) {
        expect(cell.textContent?.replace("top 200", "")).not.toMatch(/\d/);
      }
    }
    // A value YouTube did not report for a listed video is "—" with the reason.
    expect(rows[3]).toHaveTextContent("< 0.1");
    expect(
      within(rows[3]!).getAllByText(
        "Not available: Not reported by YouTube for this video and period",
        { exact: false },
      ),
    ).toHaveLength(6);

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

  it("switches the videos between the last 28 days and the lifetime through the URL", () => {
    queryResults.set(
      "v1/youtubeAnalytics:videos",
      page([youtubeVideo({ analytics: { last28: videoWindow() } })]),
    );
    renderWithOrg(<SocialView />);
    const period = screen.getByRole("group", { name: "Video analytics period" });
    expect(within(period).getByRole("button", { name: "Last 28 days" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(within(period).getByRole("button", { name: "Lifetime" }));
    expect(lastReplacedQuery().get("vwin")).toBe("lifetime");
  });

  it("shows the lifetime values with vwin=lifetime and keeps it on the video link", () => {
    setUrl("/social", "platform=youtube&preset=last_7_days&pdir=asc&vwin=lifetime");
    queryResults.set(
      "v1/youtubeAnalytics:videos",
      page([
        youtubeVideo({
          analytics: {
            last28: videoWindow({ status: "not_in_top", metrics: {} }),
            lifetime: videoWindow({ from: "2024-03-12", metrics: { views: 48_210 } }),
          },
        }),
      ]),
    );
    renderWithOrg(<SocialView />);
    const section = screen.getByTestId("youtube-videos");
    expect(within(section).getByRole("button", { name: "Lifetime" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(section).toHaveTextContent("Lifetime: Mar 12, 2024 – Oct 17, 2026 (Pacific Time)");
    const row = section.querySelector("[data-video-id]")!;
    expect(row).toHaveAttribute("data-window-state", "reported");
    expect(row).toHaveTextContent("48,210");
    expect(within(section).getByRole("link", { name: "Launch video" })).toHaveAttribute(
      "href",
      `/social/youtube/videos/post_yt_1?preset=last_7_days&pdir=asc&vwin=lifetime&account=${CHANNEL_ID}`,
    );
    fireEvent.click(within(section).getByRole("button", { name: "Last 28 days" }));
    expect(lastReplacedQuery().has("vwin")).toBe(false);
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
