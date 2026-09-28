import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Phase 9 guards for the Google Ads provider:
// - analytics may not import it (it is an implementation, like mock and Meta);
// - it is database-free, tenant-free, never decrypts and never logs;
// - its production code is read-only (no mutate / searchStream / revoke), requests no
//   email or profile, and only names the allowlisted Google hosts.

const eslint = new ESLint({ cwd: process.cwd() });
const ROOT = join(process.cwd(), "convex", "providers", "google");

async function violations(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter(
    (m) =>
      m.ruleId === "@typescript-eslint/no-restricted-imports" ||
      m.ruleId === "no-console" ||
      m.ruleId === "no-restricted-syntax",
  );
}

/** Production modules: no tests, no fixtures. */
function productionFiles(): string[] {
  return readdirSync(ROOT)
    .filter((file) => file.endsWith(".ts") && !/\.test\.ts$|\.fixtures\.ts$/.test(file))
    .map((file) => join(ROOT, file));
}

/** Source without comments (URLs inside strings keep their "//"). */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

describe("analytics cannot import the Google provider", () => {
  it.each([
    'import { createGoogleAdsProvider } from "../providers/google";',
    'import { GOOGLE_CAPABILITIES } from "../providers/google/capabilities";',
    'import { classifyGoogleFailure } from "../providers/google/errors";',
    'import { createGoogleOAuthSpec } from "../providers/google/oauth";',
  ])("rejects %s", async (source) => {
    for (const file of ["convex/analytics/__fixture__.ts", "convex/v1/analytics.ts"]) {
      expect(
        (await violations(`${source}\nexport const x = 1;\n`, file)).length,
        file,
      ).toBeGreaterThan(0);
    }
  });
});

describe("providers/google is pure and silent", () => {
  it.each([
    'import { query } from "../../_generated/server";',
    'import { internal } from "../../_generated/api";',
    'import { orgQuery } from "../../lib/tenancy";',
    'import { decryptJson } from "../../lib/crypto";',
    'export const f = () => console.log("token");',
    'export const f = () => console.error("x");',
  ])("rejects %s", async (source) => {
    expect(
      (
        await violations(
          `${source}\nexport const x = 1;\n`,
          "convex/providers/google/__fixture__.ts",
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it("the real Google modules lint clean under these rules", async () => {
    for (const file of productionFiles()) {
      expect(await violations(readFileSync(file, "utf8"), file), file).toEqual([]);
    }
  });
});

describe("production Google code (source scan)", () => {
  it("covers the provider modules", () => {
    const names = productionFiles().map((f) => f.replace(ROOT, "").replace(/\\/g, "/"));
    expect(names).toEqual(
      expect.arrayContaining([
        "/client.ts",
        "/index.ts",
        "/oauth.ts",
        "/route.ts",
        "/carry.ts",
        "/mapping.ts",
        "/normalize.ts",
        "/semantics.ts",
      ]),
    );
  });

  it.each(productionFiles().map((f) => [f.replace(ROOT, "").replace(/\\/g, "/"), f]))(
    "%s has no mutate/searchStream/revoke, no email/profile, no console",
    (_label, file) => {
      const source = code(file);
      for (const forbidden of [
        /mutate/i,
        /searchStream/,
        /revoke/i,
        /email/i,
        /\bprofile\b/,
        /console\./,
        /userinfo\.email/,
      ]) {
        expect(source, String(forbidden)).not.toMatch(forbidden);
      }
    },
  );

  it("names only the allowlisted Google hosts", () => {
    const hosts = new Set<string>();
    for (const file of productionFiles()) {
      for (const match of code(file).matchAll(/https:\/\/([a-z0-9.-]+)/g)) hosts.add(match[1]!);
    }
    expect([...hosts].sort()).toEqual([
      "accounts.google.com",
      "googleads.googleapis.com",
      "oauth2.googleapis.com",
      "openidconnect.googleapis.com",
      "www.googleapis.com",
    ]);
  });

  it("the Meta provider does not depend on the Google provider (and vice versa)", () => {
    for (const file of productionFiles()) {
      expect(code(file), file).not.toMatch(/from "\.\.\/meta/);
    }
    const metaRoot = join(process.cwd(), "convex", "providers", "meta");
    for (const file of readdirSync(metaRoot).filter((f) => f.endsWith(".ts"))) {
      expect(readFileSync(join(metaRoot, file), "utf8"), file).not.toMatch(
        /providers\/google|\.\.\/google/,
      );
    }
  });
});
