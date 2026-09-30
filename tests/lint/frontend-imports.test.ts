import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// Proves the Phase 7 guard (D23): frontend code (app/, components/, lib/, tests included)
// consumes application data only through the generated public api with convex/react.
// Exact allowlist:
//   runtime:   @/convex/_generated/api, convex/react, convex/lib/{errors,money,dates},
//              convex/analytics/periods
//   type-only: convex/server, convex/values, @/convex/_generated/dataModel
// Anything else from convex/ or the convex package is forbidden, even as a type.

const eslint = new ESLint({ cwd: process.cwd() });
const FILES = [
  "app/__fixture__.tsx",
  "components/__fixture__.tsx",
  "lib/__fixture__.ts",
  "lib/__fixture__.test.ts",
];

async function violations(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter(
    (m) => m.ruleId === "@typescript-eslint/no-restricted-imports",
  );
}

async function expectRejected(source: string) {
  for (const file of FILES) {
    expect((await violations(`${source}\nexport const x = 1;\n`, file)).length, file).toBe(1);
  }
}

async function expectAllowed(source: string) {
  for (const file of FILES) {
    expect(await violations(`${source}\n`, file), file).toEqual([]);
  }
}

/** Modules outside the allowlist: [specifier, a named export]. */
const FORBIDDEN_MODULES: [string, string][] = [
  ["@/convex/_generated/server", "query"],
  ["@/convex/analytics/queries", "overview"],
  ["@/convex/analytics/config", "ANALYTICS_LIMITS"],
  ["@/convex/analytics/aggregate", "METRIC_NAMES"],
  ["@/convex/connections/credentialStore", "withConnectionCredential"],
  ["@/convex/connections/config", "providerRegistry"],
  ["@/convex/sync/worker", "runTask"],
  ["@/convex/sync/upsert", "writeMetricPage"],
  ["@/convex/providers/mock", "createMockAdsProvider"],
  ["@/convex/providers/types", "AdsProvider"],
  ["@/convex/admin/fxRates", "upsert"],
  ["@/convex/tables/analytics", "fxRatesTable"],
  ["@/convex/schema", "schemaTables"],
  ["@/convex/lib/crypto", "decryptJson"],
  ["@/convex/lib/tenancy", "orgQuery"],
  ["@/convex/v1/connections", "beginConnect"],
  ["@/convex/v1/dto/analytics", "overviewDto"],
  ["@/convex", "x"],
  ["../convex/sync/worker", "runTask"],
  ["../../convex/lib/crypto", "decryptJson"],
  ["./convex/connections/credentialStore", "withConnectionCredential"],
  ["convex/browser", "ConvexHttpClient"],
  ["convex/nextjs", "preloadQuery"],
  ["convex", "x"],
  ["convex-helpers/server/customFunctions", "customQuery"],
  ["convex-test", "convexTest"],
];

describe("frontend import guard (D23)", () => {
  // The first lint loads the whole config (Next, TypeScript plugins); keep it out of the cases.
  beforeAll(async () => {
    await violations("export const warm = 1;\n", FILES[0]!);
  }, 120_000);

  it.each(FORBIDDEN_MODULES)("rejects a runtime import from %s", async (from, name) => {
    await expectRejected(`import { ${name} } from "${from}";`);
  });

  it.each(FORBIDDEN_MODULES)("rejects a type-only import from %s", async (from, name) => {
    await expectRejected(`import type { ${name} } from "${from}";`);
    await expectRejected(`import { type ${name} } from "${from}";`);
  });

  it.each([
    'import { queryGeneric } from "convex/server";',
    'import { v } from "convex/values";',
    'import { ConvexError } from "convex/values";',
    'import { anyApi } from "@/convex/_generated/dataModel";',
    'import { anyApi } from "../convex/_generated/dataModel";',
  ])("rejects a runtime import of a type-only module: %s", async (source) => {
    await expectRejected(source);
  });

  it("allows the approved runtime modules", async () => {
    await expectAllowed(
      [
        'import { useQuery } from "convex/react";',
        'import { api } from "@/convex/_generated/api";',
        'import { isMarketingError } from "@/convex/lib/errors";',
        'import { microsToDecimalString } from "@/convex/lib/money";',
        'import { todayIn } from "@/convex/lib/dates";',
        'import { resolvePreset } from "@/convex/analytics/periods";',
        "export const x = [useQuery, api, isMarketingError, microsToDecimalString, todayIn, resolvePreset];",
      ].join("\n"),
    );
  });

  it("allows the approved type-only modules (and types from approved runtime modules)", async () => {
    await expectAllowed(
      [
        'import type { FunctionReturnType } from "convex/server";',
        'import type { Infer } from "convex/values";',
        'import type { Doc } from "@/convex/_generated/dataModel";',
        'import type { api } from "@/convex/_generated/api";',
        'import type { DateRange } from "@/convex/analytics/periods";',
        "export type X = [FunctionReturnType<never>, Infer<never>, Doc<never>, typeof api, DateRange];",
      ].join("\n"),
    );
  });

  it("does not match lookalike names of approved modules", async () => {
    await expectRejected('import { x } from "@/convex/lib/moneyInternals";');
    await expectRejected('import { x } from "@/convex/analytics/periods/internal";');
    await expectRejected('import { x } from "@/convex/_generated/apiInternals";');
    await expectRejected('import { x } from "convex/reactive";');
  });

  it("the current app/, components/ and lib/ sources pass the guard", async () => {
    const results = await eslint.lintFiles(["app", "components", "lib"]);
    const found = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === "@typescript-eslint/no-restricted-imports")
        .map((m) => `${r.filePath}:${m.line} ${m.message}`),
    );
    expect(found).toEqual([]);
  });
});
