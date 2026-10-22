import { describe, expect, it } from "vitest";
import {
  isClerkPublishableKey,
  isPublicAuthPath,
  isSessionTaskPath,
  resolveAuthMode,
} from "./mode";

describe("resolveAuthMode (D4)", () => {
  it("uses the dev token only in a non-production build that has one", () => {
    expect(resolveAuthMode("development", "eyJ.dev.token")).toBe("dev");
    expect(resolveAuthMode("test", "eyJ.dev.token")).toBe("dev");
  });

  it("every production build signs in with Clerk, even with a dev token present", () => {
    expect(resolveAuthMode("production", "eyJ.dev.token")).toBe("clerk");
    expect(resolveAuthMode("production", undefined)).toBe("clerk");
  });

  it("a development build without a dev token signs in with Clerk", () => {
    expect(resolveAuthMode("development", undefined)).toBe("clerk");
    expect(resolveAuthMode("development", "")).toBe("clerk");
  });
});

describe("isClerkPublishableKey", () => {
  it.each(["pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk", "pk_live_Y2xlcmsuZXhhbXBsZS5jb20k"])(
    "accepts %s",
    (key) => {
      expect(isClerkPublishableKey(key)).toBe(true);
    },
  );

  it.each([undefined, "", "pk_", "pk_test_", "sk_test_abc", "pk_prod_abc", "pk_test_abc def"])(
    "refuses %j",
    (key) => {
      expect(isClerkPublishableKey(key)).toBe(false);
    },
  );
});

describe("auth paths", () => {
  it("only Clerk's sign-in and sign-up flows are public", () => {
    for (const path of ["/sign-in", "/sign-in/factor-one", "/sign-up", "/sign-up/verify"]) {
      expect(isPublicAuthPath(path), path).toBe(true);
    }
    for (const path of ["/", "/connections", "/sign-inx", "/organization", "/session-tasks"]) {
      expect(isPublicAuthPath(path), path).toBe(false);
    }
  });

  it("recognizes session-task pages", () => {
    expect(isSessionTaskPath("/session-tasks/choose-organization")).toBe(true);
    expect(isSessionTaskPath("/session-tasksx")).toBe(false);
    expect(isSessionTaskPath("/")).toBe(false);
  });
});
