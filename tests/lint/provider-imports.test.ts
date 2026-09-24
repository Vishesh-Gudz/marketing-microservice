import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Proves convex/providers and convex/mapping stay database-free and tenant-free.

const eslint = new ESLint({ cwd: process.cwd() });

async function restricted(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter(
    (m) => m.ruleId === "@typescript-eslint/no-restricted-imports",
  );
}

describe("provider / mapping isolation", () => {
  it.each([
    ["convex/providers/__fixture__.ts", 'import { query } from "../_generated/server";'],
    ["convex/providers/mock/__fixture__.ts", 'import { internal } from "../../_generated/api";'],
    ["convex/mapping/__fixture__.ts", 'import { orgQuery } from "../lib/tenancy";'],
    ["convex/mapping/__fixture__.ts", 'import { requireClaims } from "../lib/auth";'],
    ["convex/providers/__fixture__.ts", 'import { defineTable } from "convex/server";'],
    ["convex/providers/__fixture__.ts", 'import { convexTest } from "convex-test";'],
  ])("%s rejects %s", async (filePath, source) => {
    expect((await restricted(`${source}\nexport const x = 1;\n`, filePath)).length).toBeGreaterThan(
      0,
    );
  });

  it("allows type-only imports of data-model and tenant types", async () => {
    const source = [
      'import type { Doc, Id } from "../_generated/dataModel";',
      'import type { DatabaseReader } from "../_generated/server";',
      'import type { Tenant } from "../lib/tenancy";',
      'import type { WithoutSystemFields } from "convex/server";',
      "export type X = [Doc<'campaigns'>, Id<'ads'>, DatabaseReader, Tenant, WithoutSystemFields<Doc<'ads'>>];",
    ].join("\n");
    expect(await restricted(source, "convex/mapping/__fixture__.ts")).toEqual([]);
  });

  it("does not restrict test files or other modules", async () => {
    const source = 'import { query } from "../_generated/server";\nexport const q = query;\n';
    expect(await restricted(source, "convex/providers/__fixture__.test.ts")).toEqual([]);
    expect(await restricted(source, "convex/sync/__fixture__.ts")).toEqual([]);
  });
});

describe("credential guards (Phase 4)", () => {
  async function violations(code: string, filePath: string) {
    const [result] = await eslint.lintText(code, { filePath });
    return (result?.messages ?? []).filter(
      (m) =>
        m.ruleId === "no-restricted-syntax" ||
        m.ruleId === "@typescript-eslint/no-restricted-imports" ||
        m.ruleId === "no-console",
    );
  }

  it.each([
    ["convex/v1/__fixture__.ts", 'export const t = "credentials";'],
    ["convex/connections/__fixture__.ts", 'export const t = "credentials";'],
    [
      "convex/connections/__fixture__.ts",
      'import { decryptJson } from "../lib/crypto";\nexport const d = decryptJson;',
    ],
    [
      "convex/providers/__fixture__.ts",
      'import { decryptJson } from "../lib/crypto";\nexport const d = decryptJson;',
    ],
    ["convex/connections/__fixture__.ts", 'export const f = () => console.log("x");'],
  ])("%s rejects %s", async (filePath, source) => {
    expect((await violations(`${source}\n`, filePath)).length).toBeGreaterThan(0);
  });

  it("allows the credential store and non-decrypt crypto helpers", async () => {
    expect(
      await violations(
        'import { decryptJson } from "../lib/crypto";\nexport const t = "credentials";\nexport const d = decryptJson;\n',
        "convex/connections/credentialStore.ts",
      ),
    ).toEqual([]);
    expect(
      await violations(
        'import { encryptJson, randomToken } from "../lib/crypto";\nexport const x = [encryptJson, randomToken];\n',
        "convex/connections/__fixture__.ts",
      ),
    ).toEqual([]);
  });
});
