import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LEGAL } from "@/lib/legal/company";
import DataDeletionPage from "./data-deletion/page";
import PrivacyPage from "./privacy/page";

// The public Privacy Policy and Data Deletion pages: their required content, the links Meta's
// reviewers follow, and that neither renders any part of the dashboard.

describe("Privacy Policy page", () => {
  it("is labelled as the privacy policy and names the operator, effective date and contact", () => {
    render(<PrivacyPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeInTheDocument();
    expect(document.body).toHaveTextContent(LEGAL.companyName);
    expect(document.body).toHaveTextContent("Effective 3 November 2026");
    const mail = screen.getAllByRole("link", { name: LEGAL.contactEmail });
    expect(mail[0]).toHaveAttribute("href", `mailto:${LEGAL.contactEmail}`);
  });

  it("covers what is collected, how it is used, kept, shared and deleted", () => {
    render(<PrivacyPage />);
    for (const name of [
      "Data we collect",
      "How we use it",
      "Who we share it with",
      "How long we keep it",
      "How we protect it",
      "Google user data",
      "Your choices and rights",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    expect(document.body).toHaveTextContent("We do not sell your data");
    expect(document.body).toHaveTextContent("deleted 30 days after messaging stops");
    expect(
      screen.getByRole("link", { name: "Google API Services User Data Policy" }),
    ).toHaveAttribute("href", "https://developers.google.com/terms/api-services-user-data-policy");
  });

  it("links to the Data Deletion page", () => {
    render(<PrivacyPage />);
    const links = screen.getAllByRole("link", { name: /Data Deletion/ });
    expect(links.every((link) => link.getAttribute("href") === "/data-deletion")).toBe(true);
  });
});

describe("Data Deletion page", () => {
  it("explains disconnecting, removing the app and requesting full deletion", () => {
    render(<DataDeletionPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Data Deletion" })).toBeInTheDocument();
    for (const name of [
      "Disconnect a platform",
      "Remove the app on the platform",
      "Request full deletion",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    const section = screen.getByRole("region", { name: "Request full deletion" });
    expect(within(section).getByRole("link", { name: LEGAL.contactEmail })).toHaveAttribute(
      "href",
      `mailto:${LEGAL.contactEmail}`,
    );
    expect(section).toHaveTextContent("within 30 days");
  });

  it("links back to the Privacy Policy", () => {
    render(<DataDeletionPage />);
    const links = screen.getAllByRole("link", { name: "Privacy Policy" });
    expect(links.every((link) => link.getAttribute("href") === "/privacy")).toBe(true);
  });
});

describe("both pages", () => {
  it.each([
    ["Privacy Policy", PrivacyPage],
    ["Data Deletion", DataDeletionPage],
  ])("%s renders no part of the dashboard", (_name, Page) => {
    render(<Page />);
    expect(screen.queryByRole("navigation")).toBeNull();
    for (const name of ["Overview", "Campaigns", "Connections", "Inbox"]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
  });
});
