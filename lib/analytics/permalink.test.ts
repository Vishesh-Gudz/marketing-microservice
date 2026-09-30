import { describe, expect, it } from "vitest";
import { safeInstagramPermalink } from "./permalink";

describe("safeInstagramPermalink (N7)", () => {
  it.each(["https://www.instagram.com/p/Cabc/", "https://instagram.com/reel/Cabc/"])(
    "accepts %s",
    (url) => {
      expect(safeInstagramPermalink(url)).toBe(url);
    },
  );

  it.each([
    undefined,
    "",
    "javascript:alert(1)",
    "http://www.instagram.com/p/Cabc/",
    "https://evil.example/p/Cabc/",
    "https://www.instagram.com.evil.example/p/x/",
    "https://user:pass@www.instagram.com/p/x/",
    "https://www.instagram.com:8443/p/x/",
    "not a url",
    `https://www.instagram.com/p/${"a".repeat(2_100)}/`,
  ])("rejects %s", (url) => {
    expect(safeInstagramPermalink(url)).toBeUndefined();
  });
});
