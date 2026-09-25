import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Proves the Phase 6 guard: analytics reads canonical rows only. It may not import
// connections/credentials, the sync write/worker path, or provider implementations.

const eslint = new ESLint({ cwd: process.cwd() });

async function violations(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter(
    (m) =>
      m.ruleId === "@typescript-eslint/no-restricted-imports" ||
      m.ruleId === "no-console" ||
      m.ruleId === "no-restricted-syntax",
  );
}

describe("analytics isolation", () => {
  it.each([
    'import { withConnectionCredential } from "../connections/credentialStore";',
    'import { providerRegistry } from "../connections/config";',
    'import { runTask } from "../sync/worker";',
    'import { commitPage } from "../sync/runs";',
    'import { writeMetricPage } from "../sync/upsert";',
    'import { createMockAdsProvider } from "../providers/mock";',
    'import { decryptJson } from "../lib/crypto";',
  ])("rejects %s", async (source) => {
    for (const file of ["convex/analytics/__fixture__.ts", "convex/v1/analytics.ts"]) {
      expect(
        (await violations(`${source}\nexport const x = 1;\n`, file)).length,
        file,
      ).toBeGreaterThan(0);
    }
  });

  it("allows canonical helpers, pure sync planning and static provider capabilities", async () => {
    const source = [
      'import { todayIn } from "../lib/dates";',
      'import { syncableLevels } from "../sync/plan";',
      'import { createDefaultRegistry } from "../providers";',
      "export const x = [todayIn, syncableLevels, createDefaultRegistry];",
    ].join("\n");
    expect(await violations(`${source}\n`, "convex/analytics/__fixture__.ts")).toEqual([]);
  });

  it("forbids logging and inserting canonical rows", async () => {
    expect(
      (
        await violations(
          'export const f = () => console.log("x");\n',
          "convex/analytics/__fixture__.ts",
        )
      ).length,
    ).toBeGreaterThan(0);
    const insert =
      'export async function f(db: { insert: (t: string, v: object) => Promise<unknown> }) {\n  await db.insert("metricsDaily", {});\n}\n';
    expect((await violations(insert, "convex/analytics/__fixture__.ts")).length).toBeGreaterThan(0);
  });
});
