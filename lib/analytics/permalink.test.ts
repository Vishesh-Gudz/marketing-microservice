import { describe, expect, it } from "vitest";
import { safeInstagramPermalink, safeYouTubeWatchUrl } from "./permalink";

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

describe("safeYouTubeWatchUrl (ADR 0016)", () => {
  it("accepts the watch URL the API stores", () => {
    const url = "https://www.youtube.com/watch?v=vid00000000";
    expect(safeYouTubeWatchUrl(url)).toBe(url);
  });

  it.each([
    undefined,
    "",
    "javascript:alert(1)",
    "http://www.youtube.com/watch?v=vid00000000",
    "https://youtube.com/watch?v=vid00000000",
    "https://www.youtube.com.evil.example/watch?v=vid00000000",
    "https://user:pass@www.youtube.com/watch?v=vid00000000",
    "https://www.youtube.com:8443/watch?v=vid00000000",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=vid00000000&list=x",
    "https://www.youtube.com/watch?v=vid00000000&v=vid00000001",
    "https://www.youtube.com/embed/vid00000000",
    "https://www.youtube.com/watch?v=vid00000000#t=1",
    "not a url",
  ])("rejects %s", (url) => {
    expect(safeYouTubeWatchUrl(url)).toBeUndefined();
  });
});
