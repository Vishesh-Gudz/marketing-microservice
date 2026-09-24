import { describe, expect, it } from "vitest";
import { isAllowedReturnUrl, isValidReturnUrlEntry, withResultParams } from "./returnUrls";

const ALLOWED = ["https://app.example.com/settings/", "http://localhost:3000/"];

describe("return-URL allowlist", () => {
  it.each([
    "https://app.example.com/settings/",
    "https://app.example.com/settings/connections",
    "https://app.example.com/settings/connections?tab=ads#top",
    "http://localhost:3000/anything",
  ])("allows %s", (url) => {
    expect(isAllowedReturnUrl(url, ALLOWED)).toBe(true);
  });

  it.each([
    ["other path", "https://app.example.com/admin"],
    ["path prefix trick", "https://app.example.com/settingsevil"],
    ["look-alike host", "https://app.example.com.evil.test/settings/"],
    ["other port", "https://app.example.com:8443/settings/"],
    ["scheme downgrade", "http://app.example.com/settings/"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,hi"],
    ["protocol-relative", "//evil.test/settings/"],
    ["embedded credentials", "https://user:pass@app.example.com/settings/"],
    ["relative", "/settings/"],
    ["garbage", "not a url"],
  ])("rejects %s", (_label, url) => {
    expect(isAllowedReturnUrl(url, ALLOWED)).toBe(false);
  });

  it("rejects everything when no allowlist is configured", () => {
    expect(isAllowedReturnUrl("https://app.example.com/settings/", undefined)).toBe(false);
    expect(isAllowedReturnUrl("https://app.example.com/settings/", [])).toBe(false);
  });

  it("validates allowlist entries", () => {
    expect(isValidReturnUrlEntry("https://app.example.com/cb")).toBe(true);
    expect(isValidReturnUrlEntry("http://127.0.0.1:3000/")).toBe(true);
    expect(isValidReturnUrlEntry("http://app.example.com/")).toBe(false);
    expect(isValidReturnUrlEntry("https://app.example.com/?x=1")).toBe(false);
    expect(isValidReturnUrlEntry("https://app.example.com/#frag")).toBe(false);
    expect(isValidReturnUrlEntry("ftp://app.example.com/")).toBe(false);
  });

  it("appends only the given result parameters", () => {
    const url = withResultParams("https://app.example.com/settings/?tab=ads", {
      status: "connected",
      connection: "c1",
    });
    expect(new URL(url).searchParams.toString()).toBe("tab=ads&status=connected&connection=c1");
  });
});
