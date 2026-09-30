import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Phase 8 (D26): Meta fixtures are synthetic or scrubbed. Anything that looks like a real
// Graph access token, an app secret, a token in a URL or a Meta trace id fails the build.
// Covers every fixture file (and any recorded JSON added after G1) under providers/meta.

const ROOT = join(process.cwd(), "convex", "providers", "meta");

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: "Graph access token (EAA...)", pattern: /EAA[A-Za-z0-9]{20,}/ },
  { name: "token in a URL or form body", pattern: /access_token=/ },
  { name: "32-hex secret (app secret shape)", pattern: /\b[0-9a-f]{32}\b/i },
  { name: "Meta trace id", pattern: /fbtrace_id/ },
];

function fixtureFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.fixtures\.ts$|\.json$/.test(file))
    .map((file) => join(dir, file));
}

function findings(text: string): string[] {
  return FORBIDDEN.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

describe("Meta fixture scrub", () => {
  const files = fixtureFiles(ROOT);

  it("scans the Meta fixtures", () => {
    expect(files.map((f) => f.replace(ROOT, "").replace(/\\/g, "/")).sort()).toEqual(
      expect.arrayContaining(["/fakeGraph.fixtures.ts"]),
    );
  });

  it.each(fixtureFiles(ROOT).map((f) => [f.replace(ROOT, "").replace(/\\/g, "/"), f]))(
    "%s contains no token, secret, token URL or trace id",
    (_label, file) => {
      expect(findings(readFileSync(file, "utf8"))).toEqual([]);
    },
  );

  it.each([
    ["EAAGm0PX4ZCpsBAKZCZBqEXAMPLEEXAMPLEEXAMPLE", "Graph access token (EAA...)"],
    ["https://graph.facebook.com/v26.0/me?access_token=abc", "token in a URL or form body"],
    ['{ appSecret: "0123456789abcdef0123456789abcdef" }', "32-hex secret (app secret shape)"],
    ['{ "error": { "code": 190, "fbtrace_id": "A1b2" } }', "Meta trace id"],
  ])("the scrub detects %s", (sample, expected) => {
    expect(findings(sample)).toContain(expected);
  });
});
