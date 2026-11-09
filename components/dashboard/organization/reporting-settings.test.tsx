import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import { ORG } from "@/tests/unit/analytics-fixtures";
import {
  mockMutation,
  queryResults,
  renderWithOrg,
  resetHarness,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);

import { ReportingSettings } from "./reporting-settings";

// The Organization page's Reporting card (C1): admins change the reporting currency and time
// zone through v1/orgs:updateSettings (which checks the role and the values again).

const UPDATE = "v1/orgs:updateSettings";

const currency = () => screen.getByRole("combobox", { name: "Reporting currency" });
const timezone = () => screen.getByRole("combobox", { name: "Time zone" });
const save = () => screen.getByRole("button", { name: "Save" });

function inrAccounts() {
  queryResults.set("v1/adAccounts:list", [
    { id: "a1", currency: "INR", linked: true, isManager: false },
    { id: "a2", currency: "INR", linked: true, isManager: false },
  ]);
}

beforeEach(() => resetHarness());

describe("Reporting settings", () => {
  it("shows admins the stored values, with nothing to save yet", () => {
    renderWithOrg(<ReportingSettings />);
    expect(screen.getByRole("region", { name: "Reporting" })).toHaveAttribute("id", "reporting");
    expect(currency()).toHaveValue("USD");
    expect(timezone()).toHaveValue("UTC");
    expect(save()).toBeDisabled();
  });

  it("saves only what changed and confirms it", async () => {
    const update = mockMutation(UPDATE).mockResolvedValue(ORG);
    renderWithOrg(<ReportingSettings />);
    fireEvent.change(timezone(), { target: { value: "Asia/Kolkata" } });
    expect(screen.getByText("Not saved yet")).toBeInTheDocument();
    await act(async () => fireEvent.click(save()));
    expect(update).toHaveBeenCalledWith({ timezone: "Asia/Kolkata" });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("Every page now uses USD and Asia/Kolkata.")).toBeInTheDocument();
  });

  it("suggests the currency the ad accounts report in", async () => {
    inrAccounts();
    const update = mockMutation(UPDATE).mockResolvedValue(ORG);
    renderWithOrg(<ReportingSettings />);
    expect(screen.getByText("Your ad accounts report in INR.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use INR" }));
    expect(currency()).toHaveValue("INR");
    expect(screen.queryByRole("button", { name: "Use INR" })).toBeNull();
    await act(async () => fireEvent.click(save()));
    expect(update).toHaveBeenCalledWith({ reportingCurrency: "INR" });
  });

  it("offers no switch when the accounts already match", () => {
    inrAccounts();
    renderWithOrg(<ReportingSettings />, { ...ORG, reportingCurrency: "INR" });
    expect(screen.getByText("Your ad accounts report in INR.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use INR" })).toBeNull();
  });

  it("explains a refusal in fixed words", async () => {
    mockMutation(UPDATE).mockRejectedValue(apiError("INVALID_ARGUMENT", "raw server text"));
    renderWithOrg(<ReportingSettings />);
    fireEvent.change(currency(), { target: { value: "EUR" } });
    await act(async () => fireEvent.click(save()));
    expect(screen.getByText("Setting not valid")).toBeInTheDocument();
    expect(screen.queryByText(/raw server text/)).toBeNull();
    expect(save()).toBeEnabled();
  });

  it.each(["editor", "viewer"] as const)("shows %ss the values without a form", (role) => {
    renderWithOrg(<ReportingSettings />, { ...ORG, role });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText("USD · US Dollar")).toBeInTheDocument();
    expect(screen.getByText("UTC")).toBeInTheDocument();
    expect(screen.getByText("Only admins can change these.")).toBeInTheDocument();
  });
});
