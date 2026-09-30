import { fireEvent, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aggregate, metrics, REPORTED, usd } from "@/tests/unit/analytics-fixtures";
import {
  lastArgs,
  lastReplacedQuery,
  queryResults,
  renderWithOrg,
  resetHarness,
  setUrl,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import { AccountsView } from "./accounts-view";
import { BreakdownsView } from "./breakdowns-view";
import { ConversionsView } from "./conversions-view";

const coverage = { dataState: "reported" as const, accounts: [] };
const fx = { reportingCurrency: "USD", status: "not_needed" as const };

const accounts = [
  {
    id: "a1",
    platform: "meta",
    externalId: "act_1001",
    name: "Meta EU",
    currency: "EUR",
    timezone: "Europe/Berlin",
    status: "active",
    isManager: false,
    linked: true,
    connectionId: "c1",
  },
  {
    id: "a2",
    platform: "google_ads",
    externalId: "111-222-3333",
    name: "Google US",
    currency: "USD",
    timezone: "America/New_York",
    status: "active",
    isManager: false,
    linked: false,
  },
];

function group(window: string, actionType: string, count: number, extra: object = {}) {
  return {
    actionType,
    rawActionType: `offsite_conversion.fb_pixel_${actionType}`,
    attributionWindow: window,
    attributionBasis: "impression_or_click_date",
    count,
    partialValue: false,
    unavailableKpis: [],
    ...extra,
  };
}

describe("data views", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
  });
  afterAll(() => vi.useRealTimers());

  beforeEach(() => {
    resetHarness();
    queryResults.set("v1/adAccounts:list", accounts);
    queryResults.set("v1/connections:list", [
      { id: "c1", provider: "meta", status: "needs_reauth" },
    ]);
  });

  it("breakdowns: tabs and placement level live in the URL", () => {
    setUrl("/breakdowns", "tab=placement&level=campaign");
    queryResults.set("v1/analytics:breakdown", {
      by: "placement",
      level: "campaign",
      range: { from: "2026-08-26", to: "2026-09-24" },
      groups: [
        { key: "instagram", placement: "instagram", ...REPORTED },
        {
          key: "audience_network",
          placement: "audience_network",
          ...aggregate({ dataState: "unsupported" }),
        },
      ],
      coverage,
      fx,
    });
    renderWithOrg(<BreakdownsView />);
    expect(lastArgs("v1/analytics:breakdown")).toEqual({
      by: "placement",
      range: { from: "2026-08-26", to: "2026-09-24" },
      level: "campaign",
    });
    const table = screen.getByTestId("breakdown-placement");
    expect(within(table).getByText("Instagram")).toBeInTheDocument();
    expect(within(table).getByText("Not supported")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "By placement" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("breakdowns: account groups use account names and never send a level", () => {
    setUrl("/breakdowns", "tab=account&level=ad");
    queryResults.set("v1/analytics:breakdown", {
      by: "account",
      level: "account",
      range: { from: "2026-08-26", to: "2026-09-24" },
      groups: [
        { key: "a1", accountId: "a1", ...aggregate({ metrics: metrics({ spend: usd(3) }) }) },
      ],
      coverage,
      fx,
    });
    renderWithOrg(<BreakdownsView />);
    expect(lastArgs("v1/analytics:breakdown")).not.toHaveProperty("level");
    expect(screen.getByTestId("breakdown-account")).toHaveTextContent("Meta EU");
  });

  it("conversions: attribution windows are separate tables, never summed", () => {
    setUrl("/conversions", "primaryOnly=1");
    queryResults.set("v1/analytics:actions", {
      range: { from: "2026-08-26", to: "2026-09-24" },
      level: "account",
      dataState: "reported",
      groups: [
        group("7d_click", "purchase", 12, {
          isPrimary: true,
          value: usd(600),
          costPerAction: usd(25),
          valuePerSpend: 2,
        }),
        group("1d_view", "purchase", 3, {
          unavailableKpis: [{ kpi: "costPerAction", reason: "mixed_currency" }],
        }),
      ],
      coverage,
      fx,
    });
    renderWithOrg(<ConversionsView />);
    expect(lastArgs("v1/analytics:actions")).toEqual({
      range: { from: "2026-08-26", to: "2026-09-24" },
      level: "account",
      filters: { primaryOnly: true },
    });
    const sevenDay = document.querySelector('[data-window="7d_click"]') as HTMLElement;
    const oneDay = document.querySelector('[data-window="1d_view"]') as HTMLElement;
    expect(within(sevenDay).getByText("12")).toBeInTheDocument();
    expect(within(sevenDay).getByText("$600.00")).toBeInTheDocument();
    expect(within(sevenDay).getByText("2.00×")).toBeInTheDocument();
    expect(within(sevenDay).getByText("Primary")).toBeInTheDocument();
    expect(within(oneDay).getByText("3")).toBeInTheDocument();
    expect(oneDay).toHaveTextContent("Not available: Accounts use different currencies");
    expect(document.body).not.toHaveTextContent("15");

    expect(screen.getByRole("rowheader", { name: "Purchase" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Primary conversions only"));
    expect(lastReplacedQuery().has("primaryOnly")).toBe(false);
  });

  it("conversions: the window selection only chooses which groups are shown", () => {
    setUrl("/conversions", "window=1d_view&level=campaign");
    queryResults.set("v1/analytics:actions", {
      range: { from: "2026-08-26", to: "2026-09-24" },
      level: "campaign",
      dataState: "reported",
      groups: [group("7d_click", "purchase", 12), group("1d_view", "lead", 3)],
      coverage,
      fx,
    });
    renderWithOrg(<ConversionsView />);
    expect(lastArgs("v1/analytics:actions")).toEqual({
      range: { from: "2026-08-26", to: "2026-09-24" },
      level: "campaign",
    });
    expect(document.querySelector('[data-window="7d_click"]')).toBeNull();
    expect(document.querySelector('[data-window="1d_view"]')).not.toBeNull();
  });

  it("accounts: coverage, connection health and unlinked accounts", () => {
    setUrl("/accounts");
    queryResults.set("v1/analytics:breakdown", {
      by: "account",
      level: "account",
      range: { from: "2026-08-26", to: "2026-09-24" },
      groups: [{ key: "a1", accountId: "a1", ...REPORTED }],
      coverage: {
        dataState: "partial",
        accounts: [
          {
            accountId: "a1",
            coveredFrom: "2026-01-01",
            coveredThrough: "2026-09-20",
            daysUncovered: 4,
            lastSyncedAt: "2026-09-21T08:30:00.000Z",
            supported: true,
          },
        ],
      },
      fx,
    });
    renderWithOrg(<AccountsView />);
    expect(lastArgs("v1/analytics:breakdown")).toEqual({
      by: "account",
      range: { from: "2026-08-26", to: "2026-09-24" },
    });
    expect(screen.getByLabelText("Reconnect required")).toBeInTheDocument();
    const meta = document.querySelector('[data-account-id="a1"]') as HTMLElement;
    expect(meta).toHaveTextContent("Reconnect required");
    expect(meta).toHaveTextContent("Sep 20, 2026");
    expect(meta).toHaveTextContent("Sep 21, 2026, 8:30 AM");
    expect(meta).toHaveTextContent("4");
    expect(meta).toHaveTextContent("$1,234.56");
    const google = document.querySelector('[data-account-id="a2"]') as HTMLElement;
    expect(google).toHaveTextContent("Unlinked");
    expect(google).toHaveTextContent("Never");
  });
});
