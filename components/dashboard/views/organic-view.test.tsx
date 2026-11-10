import { screen, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import { ORG } from "@/tests/unit/analytics-fixtures";
import {
  lastArgs,
  queryResults,
  renderWithOrg,
  resetHarness,
  setUrl,
} from "@/tests/unit/dashboard-harness";
import {
  organicAggregate,
  organicOverview,
  organicSeries,
  seriesPoint,
  SOCIAL_ACCOUNT_ID,
  SOCIAL_ACCOUNT_ID_2,
  socialAccount,
  socialPost,
} from "@/tests/unit/organic-fixtures";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import { OrganicView } from "./organic-view";

// /social: one Instagram account, UTC account metrics, org-timezone post publish days,
// lifetime post totals; every value from the public v1 organic API.

const NEW_YORK = { ...ORG, timezone: "America/New_York" };
const accounts = (
  page = [socialAccount(), socialAccount({ id: SOCIAL_ACCOUNT_ID_2, username: "mock_small" })],
) => ({
  page,
  isDone: true,
  continueCursor: "",
});

describe("OrganicView", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 02:00 UTC on Sep 26 = Sep 25 in New York: UTC and org "today" differ.
    vi.setSystemTime(new Date("2026-09-26T02:00:00Z"));
  });
  afterAll(() => vi.useRealTimers());

  beforeEach(() => {
    resetHarness();
    setUrl("/social");
    queryResults.set("v1/socialAccounts:list", accounts());
    queryResults.set("v1/socialAccounts:get", (args: Record<string, unknown>) =>
      socialAccount({ id: args.socialAccountId as string }),
    );
    queryResults.set("v1/organicAnalytics:overview", organicOverview());
    queryResults.set(
      "v1/organicAnalytics:accountSeries",
      organicSeries([seriesPoint("2026-09-24"), seriesPoint("2026-09-25")]),
    );
    queryResults.set("v1/socialPosts:list", {
      page: [socialPost()],
      isDone: true,
      continueCursor: "",
    });
    queryResults.set("v1/connections:list", []);
  });

  it("uses the first account, UTC presets for account metrics and org-timezone post days", () => {
    renderWithOrg(<OrganicView />, NEW_YORK);
    expect(
      screen.getByRole("heading", { level: 1, name: "Instagram (organic)" }),
    ).toBeInTheDocument();
    // last_30_days against today in UTC (Sep 26), not New York's Sep 25.
    const range = { from: "2026-08-27", to: "2026-09-25" };
    expect(lastArgs("v1/organicAnalytics:overview")).toEqual({
      range,
      compare: "previous_period",
      socialAccountIds: [SOCIAL_ACCOUNT_ID],
    });
    expect(lastArgs("v1/organicAnalytics:accountSeries")).toEqual({
      socialAccountId: SOCIAL_ACCOUNT_ID,
      range,
      granularity: "day",
    });
    expect(lastArgs("v1/socialPosts:list")).toEqual({
      socialAccountId: SOCIAL_ACCOUNT_ID,
      publishedFrom: range.from,
      publishedTo: range.to,
      sort: { by: "publishedAt", dir: "desc" },
      paginationOpts: { numItems: 25, cursor: null },
    });
    expect(lastArgs("v1/socialAccounts:get")).toEqual({ socialAccountId: SOCIAL_ACCOUNT_ID });
    expect(screen.getByTestId("day-basis")).toHaveTextContent(
      "Account metrics use UTC days and presets use UTC; post publish dates use America/New_York.",
    );
    expect(screen.getByText(/Published .* in America\/New_York/)).toBeInTheDocument();
  });

  it("selects the account from the URL and keeps the post order", () => {
    setUrl("/social", `account=${SOCIAL_ACCOUNT_ID_2}&pdir=asc`);
    renderWithOrg(<OrganicView />);
    expect(lastArgs("v1/organicAnalytics:overview")).toMatchObject({
      socialAccountIds: [SOCIAL_ACCOUNT_ID_2],
    });
    expect(lastArgs("v1/socialPosts:list")).toMatchObject({
      socialAccountId: SOCIAL_ACCOUNT_ID_2,
      sort: { by: "publishedAt", dir: "asc" },
    });
    expect(
      within(screen.getByTestId("social-account-picker")).getByRole("combobox", {
        name: "Instagram account",
      }),
    ).toHaveTextContent("@mock_small · Business");
  });

  it("without accounts: a clear empty state and no data queries", () => {
    queryResults.set("v1/socialAccounts:list", accounts([]));
    renderWithOrg(<OrganicView />);
    expect(screen.getByText("No Instagram account connected")).toBeInTheDocument();
    expect(screen.getByText(/Connections are managed outside this dashboard/)).toBeInTheDocument();
    expect(lastArgs("v1/organicAnalytics:overview")).toBeUndefined();
    expect(screen.queryByRole("link", { name: /connect/i })).toBeNull();
  });

  it("an unknown account in the URL is unavailable (no silent switch)", () => {
    setUrl("/social", "account=acct_unknown");
    renderWithOrg(<OrganicView />);
    expect(screen.getByText("This Instagram account is not available")).toBeInTheDocument();
    expect(lastArgs("v1/organicAnalytics:overview")).toBeUndefined();
    expect(screen.getByRole("combobox", { name: "Instagram account" })).toBeInTheDocument();
  });

  it("renders KPIs, coverage, the chart and posts; missing values are never zero", () => {
    renderWithOrg(<OrganicView />);
    const totals = screen.getByTestId("organic-totals");
    // A named region with a visible heading, like the paid pages' key metrics.
    expect(screen.getByRole("region", { name: "Key metrics" })).toBe(totals);
    const reach = within(totals).getByRole("heading", { name: "Reach" }).closest("[data-kpi]")!;
    expect(reach).toHaveTextContent("—");
    expect(reach).not.toHaveTextContent("0");
    const views = within(totals).getByRole("heading", { name: "Views" }).closest("[data-kpi]")!;
    expect(views).toHaveTextContent("5,400");
    expect(within(totals).getByText("Engagement details")).toBeInTheDocument();
    expect(screen.getByTestId("organic-freshness")).toHaveTextContent(
      "Account metrics synced through Sep 28, 2026 (UTC)",
    );
    expect(screen.getByRole("img", { name: "Views by day (UTC)" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View on Instagram/ })).toBeInTheDocument();
  });

  it("partial and unknown ranges are explained, not zero-filled", () => {
    queryResults.set(
      "v1/organicAnalytics:overview",
      organicOverview({
        totals: organicAggregate({ dataState: "partial" }),
        coverage: {
          dataState: "partial",
          accounts: [{ accountId: SOCIAL_ACCOUNT_ID, syncedDays: 20, unsyncedDays: 10 }],
        },
      }),
    );
    const { unmount } = renderWithOrg(<OrganicView />);
    expect(screen.getByRole("status", { name: "Partial data" })).toHaveTextContent(
      "Partial: 10 UTC days of this range not synced yet (20 synced)",
    );
    unmount();
    queryResults.set(
      "v1/organicAnalytics:overview",
      organicOverview({
        totals: organicAggregate({
          dataState: "unknown",
          metrics: { unavailableMetrics: [], partialMetrics: [] },
        }),
        coverage: { dataState: "unknown", accounts: [] },
      }),
    );
    renderWithOrg(<OrganicView />);
    expect(screen.getByRole("status", { name: "Data not synced" })).toBeInTheDocument();
    const views = screen.getByRole("heading", { name: "Views" }).closest("[data-kpi]")!;
    expect(views).toHaveTextContent("—");
  });

  it("an account that never synced shows the history-loading notice", () => {
    queryResults.set("v1/socialAccounts:get", () =>
      socialAccount({ lastSyncedAt: undefined, coverage: undefined }),
    );
    renderWithOrg(<OrganicView />);
    expect(screen.getByRole("generic", { name: "History loading" })).toBeInTheDocument();
  });

  describe("an account that cannot sync (O2: insights permission missing)", () => {
    const blocked = (overrides = {}) =>
      socialAccount({
        lastSyncedAt: undefined,
        coverage: undefined,
        organicSync: "insights_permission_missing",
        ...overrides,
      });

    beforeEach(() => {
      queryResults.set("v1/socialAccounts:list", accounts([blocked()]));
      queryResults.set("v1/socialAccounts:get", () => blocked());
    });

    it("says why and how instead of history loading and empty metrics (admin)", () => {
      renderWithOrg(<OrganicView />);
      const notice = screen.getByRole("status", {
        name: "Instagram analytics need one more permission",
      });
      expect(
        within(notice).getByRole("heading", {
          level: 2,
          name: "Instagram analytics need one more permission",
        }),
      ).toBeInTheDocument();
      expect(notice).toHaveTextContent(
        "Add instagram_manage_insights to the Meta login configuration, then reconnect Instagram on Connections. Direct messages keep working meanwhile.",
      );
      expect(within(notice).getByRole("link", { name: "Open Connections" })).toHaveAttribute(
        "href",
        "/connections",
      );
      expect(notice).not.toHaveTextContent("Ask an admin");
      // The account stays identified; nothing that could only show "—" is rendered or queried.
      expect(screen.getByTestId("social-account-summary")).toHaveTextContent("@mock_1");
      expect(screen.queryByRole("generic", { name: "History loading" })).toBeNull();
      expect(screen.queryByText(/History loading/)).toBeNull();
      expect(screen.queryByTestId("organic-totals")).toBeNull();
      expect(screen.queryByTestId("filter-bar")).toBeNull();
      expect(screen.queryByRole("img", { name: "Views by day (UTC)" })).toBeNull();
      expect(screen.queryByText(/Data not synced/)).toBeNull();
      expect(lastArgs("v1/organicAnalytics:overview")).toBeUndefined();
      expect(lastArgs("v1/organicAnalytics:accountSeries")).toBeUndefined();
      expect(lastArgs("v1/socialPosts:list")).toBeUndefined();
    });

    it.each(["editor", "viewer"] as const)("asks a %s to get an admin to reconnect", (role) => {
      renderWithOrg(<OrganicView />, { ...ORG, role });
      const notice = screen.getByRole("status", {
        name: "Instagram analytics need one more permission",
      });
      expect(notice).toHaveTextContent("Ask an admin to reconnect Instagram.");
      expect(within(notice).queryByRole("link")).toBeNull();
      expect(screen.queryByRole("link", { name: "Open Connections" })).toBeNull();
    });

    it("only the affected account: another account in the picker renders its data", () => {
      queryResults.set(
        "v1/socialAccounts:list",
        accounts([blocked(), socialAccount({ id: SOCIAL_ACCOUNT_ID_2, username: "mock_small" })]),
      );
      queryResults.set("v1/socialAccounts:get", (args: Record<string, unknown>) =>
        args.socialAccountId === SOCIAL_ACCOUNT_ID_2
          ? socialAccount({ id: SOCIAL_ACCOUNT_ID_2, organicSync: "active" })
          : blocked(),
      );
      setUrl("/social", `account=${SOCIAL_ACCOUNT_ID_2}`);
      renderWithOrg(<OrganicView />);
      expect(screen.queryByTestId("insights-permission-notice")).toBeNull();
      expect(screen.getByTestId("organic-totals")).toBeInTheDocument();
      expect(lastArgs("v1/organicAnalytics:overview")).toMatchObject({
        socialAccountIds: [SOCIAL_ACCOUNT_ID_2],
      });
    });
  });

  it("a failed section shows the mapped error without breaking the page", () => {
    queryResults.set("v1/organicAnalytics:overview", () => {
      throw apiError("INVALID_ARGUMENT", "Too many rows", { reason: "too_many_rows" });
    });
    renderWithOrg(<OrganicView />);
    expect(screen.getByRole("alert")).toHaveTextContent(/Key metrics/);
    expect(screen.getByRole("button", { name: "Show last 7 days" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Views by day (UTC)" })).toBeInTheDocument();
  });
});
