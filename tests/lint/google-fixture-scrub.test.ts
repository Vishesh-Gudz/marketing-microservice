import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Phase 9: Google fixtures are synthetic. Anything that looks like a real Google access
// token, refresh token, OAuth client secret, developer token in a header dump, a token in a
// URL/form, or a real request id / email fails the build. Covers every fixture file (and any
// JSON added later) under providers/google.

const ROOT = join(process.cwd(), "convex", "providers", "google");

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: "Google access token (ya29.)", pattern: /ya29\.[A-Za-z0-9_-]{20,}/ },
  { name: "Google refresh token (1//)", pattern: /1\/\/[A-Za-z0-9_-]{20,}/ },
  { name: "OAuth client secret (GOCSPX-)", pattern: /GOCSPX-/ },
  { name: "token in a URL or form body", pattern: /(access_token|refresh_token)=[A-Za-z0-9]/ },
  { name: "developer-token header value", pattern: /developer-token:\s*[A-Za-z0-9_-]{16,}/i },
  { name: "email address", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/ },
  { name: "real client id", pattern: /\d{6,}-[a-z0-9]{32}\.apps\.googleusercontent\.com/ },
];

function fixtureFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.fixtures\.ts$|\.json$/.test(file))
    .map((file) => join(dir, file));
}

function findings(text: string): string[] {
  return FORBIDDEN.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

describe("Google fixture scrub", () => {
  const files = fixtureFiles(ROOT);

  it("scans the Google fixtures", () => {
    expect(files.map((f) => f.replace(ROOT, "").replace(/\\/g, "/")).sort()).toEqual(
      expect.arrayContaining(["/fakeGoogleAds.fixtures.ts"]),
    );
  });

  it.each(files.map((f) => [f.replace(ROOT, "").replace(/\\/g, "/"), f]))(
    "%s contains no token, secret, token URL, email or real client id",
    (_label, file) => {
      expect(findings(readFileSync(file, "utf8"))).toEqual([]);
    },
  );

  it.each([
    ["ya29.a0AfH6SMBexampleexampleexampleexample", "Google access token (ya29.)"],
    ["1//0gexampleexampleexampleexampleEXAMPLE", "Google refresh token (1//)"],
    ['clientSecret: "GOCSPX-abc"', "OAuth client secret (GOCSPX-)"],
    ["https://x.test/?access_token=abc", "token in a URL or form body"],
    ["grant_type=refresh_token&refresh_token=1abc", "token in a URL or form body"],
    ["developer-token: ABCDEFGHIJKLMNOPQRST", "developer-token header value"],
    ['{ "email": "someone@example.com" }', "email address"],
    ["123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com", "real client id"],
  ])("the scrub detects %s", (sample, expected) => {
    expect(findings(sample)).toContain(expected);
  });
});

// ADR 0016: the YouTube fixtures model the same Google OAuth endpoints, so the same rules
// apply to every fixture file under providers/youtube.
const YOUTUBE_ROOT = join(process.cwd(), "convex", "providers", "youtube");

describe("YouTube fixture scrub", () => {
  const files = fixtureFiles(YOUTUBE_ROOT);

  it("scans the YouTube fixtures", () => {
    expect(files.map((f) => f.replace(YOUTUBE_ROOT, "").replace(/\\/g, "/")).sort()).toEqual(
      expect.arrayContaining(["/fakeYouTube.fixtures.ts"]),
    );
  });

  it.each(files.map((f) => [f.replace(YOUTUBE_ROOT, "").replace(/\\/g, "/"), f]))(
    "%s contains no token, secret, token URL, email or real client id",
    (_label, file) => {
      expect(findings(readFileSync(file, "utf8"))).toEqual([]);
    },
  );
});
