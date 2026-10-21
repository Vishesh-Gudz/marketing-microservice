import { describe, expect, it } from "vitest";
import {
  accountStatusLabel,
  assetLinkability,
  linkBlockMessage,
  managerStatusLabel,
  testAccountLabel,
  type LinkBlock,
} from "./linkability";
import type { ConnectionStatus, ManagerStatus, TestAccountStatus } from "./types";

const client = { linked: false, isManager: false, managerStatus: "client" as ManagerStatus };

describe("assetLinkability (UI only; the server re-checks)", () => {
  it("offers a confirmed, unlinked client account on an active connection", () => {
    expect(assetLinkability(client, "active")).toEqual({ selectable: true });
  });

  it.each([
    ["a manager", { ...client, isManager: true, managerStatus: "manager" }, "manager"],
    ["a manager flagged only by status", { ...client, managerStatus: "manager" }, "manager"],
    ["a manager flagged only by isManager", { ...client, isManager: true }, "manager"],
    ["an unknown account type", { ...client, managerStatus: "unknown" }, "manager_status_unknown"],
    ["an already linked client", { ...client, linked: true }, "already_linked"],
  ] as const)("blocks %s", (_label, asset, blockedBy) => {
    expect(assetLinkability(asset, "active")).toEqual({ selectable: false, blockedBy });
  });

  it.each(["needs_reauth", "revoked"] as const)(
    "blocks every account of a %s connection",
    (status: ConnectionStatus) => {
      expect(assetLinkability(client, status)).toEqual({
        selectable: false,
        blockedBy: "connection_inactive",
      });
    },
  );

  it("never lets the test-account status decide (informational only)", () => {
    // The DTO carries testAccountStatus, but linkability does not even read it.
    for (const testAccountStatus of ["test", "not_test", "unknown"] as const) {
      expect(assetLinkability({ ...client, testAccountStatus } as typeof client, "active")).toEqual(
        {
          selectable: true,
        },
      );
    }
  });

  it("has a message for every block", () => {
    const blocks: LinkBlock[] = [
      "connection_inactive",
      "already_linked",
      "manager",
      "manager_status_unknown",
    ];
    for (const provider of ["google_ads", "meta"] as const) {
      const messages = blocks.map((block) => linkBlockMessage(block, provider));
      expect(messages.every((message) => message.length > 0)).toBe(true);
      expect(new Set(messages).size).toBe(blocks.length);
    }
  });

  it("names the provider: Google wording for Google Ads, Meta wording for Meta Ads", () => {
    expect(linkBlockMessage("connection_inactive", "google_ads")).toBe(
      "Reconnect Google Ads before linking accounts.",
    );
    expect(linkBlockMessage("connection_inactive", "meta")).toBe(
      "Reconnect Meta Ads before linking accounts.",
    );
    expect(linkBlockMessage("manager_status_unknown", "meta")).not.toContain("Google");
  });
});

describe("labels", () => {
  it.each([
    ["manager", "Manager account"],
    ["client", "Client account"],
    ["unknown", "Account type not reported"],
  ] as const)("manager status %s", (status, label) => {
    expect(managerStatusLabel(status)).toBe(label);
  });

  it.each([
    ["test", "Test account"],
    ["not_test", "Not a test account"],
    ["unknown", "Test status not reported"],
  ] as const)("test-account status %s", (status: TestAccountStatus, label) => {
    const { label: shown, hint } = testAccountLabel(status);
    expect(shown).toBe(label);
    expect(hint.length).toBeGreaterThan(0);
  });

  it("an unknown test status is never presented as test or not-test", () => {
    const { label, hint } = testAccountLabel("unknown");
    expect(label).not.toMatch(/^(Test account|Not a test account)$/);
    expect(hint).toMatch(/did not report/);
  });

  it.each([
    ["active", "Active"],
    ["disabled", "Disabled"],
    ["closed", "Closed"],
    ["pending", "Pending"],
    ["unknown", "Status not reported"],
  ] as const)("account status %s", (status, label) => {
    expect(accountStatusLabel(status)).toBe(label);
  });
});
