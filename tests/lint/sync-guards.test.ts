import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Proves the Phase 5 guards: only convex/sync/upsert.ts inserts canonical rows,
// the sync engine never logs, and the Phase 4 credential guards still apply.

const eslint = new ESLint({ cwd: process.cwd() });

async function violations(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter(
    (m) =>
      m.ruleId === "no-restricted-syntax" ||
      m.ruleId === "no-console" ||
      m.ruleId === "@typescript-eslint/no-restricted-imports",
  );
}

const TABLES = [
  "adAccounts",
  "campaigns",
  "adGroups",
  "ads",
  "creatives",
  "metricsDaily",
  "actionMetricsDaily",
];

describe("single canonical write path", () => {
  it.each(TABLES)("rejects inserting into %s outside convex/sync/upsert.ts", async (table) => {
    const source = `export async function f(db: { insert: (t: string, v: object) => Promise<unknown> }) {\n  await db.insert("${table}", {});\n}\n`;
    for (const file of [
      "convex/sync/__fixture__.ts",
      "convex/connections/__fixture__.ts",
      "convex/v1/__fixture__.ts",
      "convex/lib/__fixture__.ts",
      "convex/connections/credentialStore.ts",
    ]) {
      expect((await violations(source, file)).length, `${file} ${table}`).toBeGreaterThan(0);
    }
  });

  it("allows the write path, tests and non-canonical tables", async () => {
    const source =
      'export async function f(db: { insert: (t: string, v: object) => Promise<unknown> }) {\n  await db.insert("campaigns", {});\n}\n';
    expect(await violations(source, "convex/sync/upsert.ts")).toEqual([]);
    expect(await violations(source, "convex/sync/__fixture__.test.ts")).toEqual([]);
    const other =
      'export async function f(db: { insert: (t: string, v: object) => Promise<unknown> }) {\n  await db.insert("syncRuns", {});\n}\n';
    expect(await violations(other, "convex/sync/__fixture__.ts")).toEqual([]);
  });
});

describe("sync engine hygiene", () => {
  it("forbids logging in convex/sync", async () => {
    expect(
      (await violations('export const f = () => console.log("x");\n', "convex/sync/__fixture__.ts"))
        .length,
    ).toBeGreaterThan(0);
  });

  it("keeps the credential guards on sync files, including the write path", async () => {
    for (const file of ["convex/sync/__fixture__.ts", "convex/sync/upsert.ts"]) {
      expect(
        (await violations('export const t = "credentials";\n', file)).length,
        file,
      ).toBeGreaterThan(0);
      expect(
        (
          await violations(
            'import { decryptJson } from "../lib/crypto";\nexport const d = decryptJson;\n',
            file,
          )
        ).length,
        file,
      ).toBeGreaterThan(0);
    }
  });

  it("S2: only the credential store may name the oauthGrants table (encrypted grants)", async () => {
    const source = 'export const t = "oauthGrants";\n';
    for (const file of [
      "convex/connections/maintenance.ts",
      "convex/connections/oauthFlow.ts",
      "convex/v1/__fixture__.ts",
      "convex/sync/__fixture__.ts",
    ]) {
      expect((await violations(source, file)).length, file).toBeGreaterThan(0);
    }
    expect(await violations(source, "convex/connections/credentialStore.ts")).toEqual([]);
    // Similar names are not caught by the exact-name rule.
    expect(
      await violations('export const t = "oauthGrantsLegacy";\n', "convex/v1/__fixture__.ts"),
    ).toEqual([]);
  });
});
