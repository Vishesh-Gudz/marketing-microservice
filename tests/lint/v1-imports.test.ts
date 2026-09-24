import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Proves the ESLint guard in eslint.config.mjs actually blocks raw Convex
// builders inside convex/v1 (the public contract).

const eslint = new ESLint({ cwd: process.cwd() });

async function lint(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports");
}

describe("convex/v1 import guard", () => {
  it.each([
    'import { query } from "../_generated/server";',
    'import { mutation } from "../../_generated/server";',
    'import { internalMutation } from "../_generated/server";',
    'import { queryGeneric } from "convex/server";',
  ])("rejects %s", async (source) => {
    const messages = await lint(`${source}\nexport {};\n`, "convex/v1/__fixture__.ts");
    expect(messages.length).toBeGreaterThan(0);
  });

  it("allows types from _generated/server and the tenancy wrappers", async () => {
    const source = [
      'import type { DatabaseReader } from "../_generated/server";',
      'import { orgQuery } from "../lib/tenancy";',
      "export type R = DatabaseReader;",
      "export const q = orgQuery;",
    ].join("\n");
    expect(await lint(source, "convex/v1/__fixture__.ts")).toEqual([]);
  });

  it("does not restrict modules outside convex/v1", async () => {
    const source = 'import { query } from "./_generated/server";\nexport const q = query;\n';
    expect(await lint(source, "convex/health.ts")).toEqual([]);
  });
});
