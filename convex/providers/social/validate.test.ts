import { describe, expect, it } from "vitest";
import { isProviderError } from "../errors";
import { assertValidSocialRecord, socialRecordIssues } from "./validate";

// Social provider records are validated against the REAL table validators: no tenant or
// Convex ids can be smuggled in, and failures never echo record values.

const discovered = {
  platform: "instagram",
  externalId: "17841400000000101",
  username: "fake_brand",
  accountType: "business",
};

describe("social record validation", () => {
  it("accepts a valid discovered account", () => {
    expect(socialRecordIssues("discoveredSocialAccount", discovered)).toEqual([]);
    expect(
      socialRecordIssues("discoveredSocialAccount", { ...discovered, username: undefined }),
    ).toEqual([]);
  });

  it.each([
    ["an orgId", { ...discovered, orgId: "k17abc" }],
    ["a connectionId", { ...discovered, connectionId: "k17abc" }],
    ["a discoveredAt", { ...discovered, discoveredAt: 1 }],
    ["an unknown field", { ...discovered, followers: 5 }],
    ["an unsupported account type", { ...discovered, accountType: "personal" }],
    ["an ad platform", { ...discovered, platform: "meta" }],
  ])("rejects %s", (_label, record) => {
    expect(socialRecordIssues("discoveredSocialAccount", record).length).toBeGreaterThan(0);
  });

  it.each([
    ["a non-numeric id", { ...discovered, externalId: "act_1" }],
    ["a username with spaces", { ...discovered, username: "fake brand" }],
    ["a too long username", { ...discovered, username: "a".repeat(31) }],
  ])("rejects %s (semantics)", (_label, record) => {
    expect(socialRecordIssues("discoveredSocialAccount", record).length).toBeGreaterThan(0);
  });

  it("socialAccount records cannot carry connection linkage or tenant fields", () => {
    const account = { ...discovered, name: "Fake Brand", status: "active" };
    expect(socialRecordIssues("socialAccount", account)).toEqual([]);
    expect(socialRecordIssues("socialAccount", { ...account, connectionId: "x" }).length).toBe(1);
    expect(socialRecordIssues("socialAccount", { ...account, name: " " })).toEqual([
      "name: must not be empty",
    ]);
  });

  it("raises a generic data error that never contains record values", () => {
    const secretish = { ...discovered, username: "IGAAfaketoken leaked" };
    let caught: unknown;
    try {
      assertValidSocialRecord(
        "discoveredSocialAccount",
        secretish,
        "instagram",
        "listSocialAccounts",
      );
    } catch (error) {
      caught = error;
    }
    expect(isProviderError(caught) && caught.kind === "data").toBe(true);
    expect(JSON.stringify({ m: (caught as Error).message, c: caught })).not.toContain(
      "IGAAfaketoken",
    );
  });
});
