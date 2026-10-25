import { ESLint } from "eslint";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Phase 10 Stage B (B2): organic Instagram analytics and ad analytics never mix. Two parts:
//
// 1. ESLint (EXISTING rule, unchanged config): the Phase 6 analytics block of eslint.config.mjs
//    covers `convex/analytics/**/*.ts`, so the new organic module convex/analytics/organic/**
//    is already ESLint-enforced: no connections/credentials, no sync write/worker path, no
//    provider implementation (Instagram, social mock, Meta, Google), no logging, no canonical
//    inserts. The first describe proves that coverage with ESLint itself.
// 2. SOURCE SCAN (a test, NOT an ESLint rule; approved B2 deviation, since the ESLint config
//    was outside B2's scope): organic analytics names no ad table and imports no ad
//    aggregation; ad analytics names no organic table; the organic v1 files (covered by
//    ESLint only through the convex/v1 block) import no ad analytics and no provider.

const eslint = new ESLint({ cwd: process.cwd() });

async function violations(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter(
    (m) =>
      m.ruleId === "@typescript-eslint/no-restricted-imports" ||
      m.ruleId === "no-restricted-imports" ||
      m.ruleId === "no-console" ||
      m.ruleId === "no-restricted-syntax",
  );
}

const ORGANIC_FIXTURE = "convex/analytics/organic/__fixture__.ts";

// The first lint of a worker loads the TypeScript parser (slow when cold): warm it up once.
beforeAll(async () => {
  await eslint.lintText("export {};\n", { filePath: ORGANIC_FIXTURE });
}, 180_000);

describe("existing ESLint analytics guard covers convex/analytics/organic", () => {
  it.each([
    'import { withConnectionCredential } from "../../connections/credentialStore";',
    'import { writeSocialPostPage } from "../../sync/upsert";',
    'import { commitSocialPage } from "../../sync/runs";',
    'import { runTask } from "../../sync/socialWorker";',
    'import { createInstagramSocialProvider } from "../../providers/instagram/node/provider";',
    'import { INSTAGRAM_CAPABILITIES } from "../../providers/instagram/capabilities";',
    'import { createMockSocialProvider } from "../../providers/social/mock";',
    'import { createMockYouTubeSocialProvider } from "../../providers/social/mock/youtube";',
    'import { createYouTubeSocialProvider } from "../../providers/youtube/provider";',
    'import { YOUTUBE_CAPABILITIES } from "../../providers/youtube/capabilities";',
    'import { createMetaAdsProvider } from "../../providers/meta";',
    'import { createGoogleAdsProvider } from "../../providers/google";',
    'import { decryptJson } from "../../lib/crypto";',
  ])("rejects %s", async (source) => {
    expect(
      (await violations(`${source}\nexport const x = 1;\n`, ORGANIC_FIXTURE)).length,
    ).toBeGreaterThan(0);
  });

  it("rejects logging and canonical inserts", async () => {
    expect(
      (await violations('export const f = () => console.log("x");\n', ORGANIC_FIXTURE)).length,
    ).toBeGreaterThan(0);
    const insert =
      'export async function f(db: { insert: (t: string, v: object) => Promise<unknown> }) {\n  await db.insert("socialAccountMetricsDaily", {});\n}\n';
    expect((await violations(insert, ORGANIC_FIXTURE)).length).toBeGreaterThan(0);
  });

  it("allows canonical helpers and static provider capabilities", async () => {
    const source = [
      'import { todayIn } from "../../lib/dates";',
      'import { bucketsOf } from "../periods";',
      'import { createDefaultRegistry } from "../../providers";',
      "export const x = [todayIn, bucketsOf, createDefaultRegistry];",
    ].join("\n");
    expect(await violations(`${source}\n`, ORGANIC_FIXTURE)).toEqual([]);
  });
});

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const sources = (dir: string) =>
  readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => `${dir}/${name}`);

const AD_TABLES = [
  "adAccounts",
  "campaigns",
  "adGroups",
  "ads",
  "creatives",
  "metricsDaily",
  "actionMetricsDaily",
  "fxRates",
];
const SOCIAL_TABLES = [
  "socialAccounts",
  "socialPosts",
  "socialPostMetricSnapshots",
  "socialAccountMetricsDaily",
];
const tableLiterals = (source: string, tables: string[]) =>
  tables.filter((table) => source.includes(`"${table}"`));

const ORGANIC = sources("convex/analytics/organic");
const AD_ANALYTICS = [
  ...sources("convex/analytics"),
  "convex/v1/analytics.ts",
  "convex/v1/dto/analytics.ts",
];
const ORGANIC_V1 = [
  "convex/v1/socialAccounts.ts",
  "convex/v1/socialPosts.ts",
  "convex/v1/organicAnalytics.ts",
  "convex/v1/dto/socialPost.ts",
  "convex/v1/dto/organicAnalytics.ts",
];

describe("organic vs ad analytics separation", () => {
  it("finds the modules it guards", () => {
    expect(ORGANIC).toEqual(
      expect.arrayContaining([
        "convex/analytics/organic/aggregate.ts",
        "convex/analytics/organic/queries.ts",
      ]),
    );
    expect(AD_ANALYTICS).toContain("convex/analytics/queries.ts");
  });

  it.each(ORGANIC)("%s reads no ad table and no ad aggregation", (path) => {
    const source = read(path);
    expect(tableLiterals(source, AD_TABLES)).toEqual([]);
    expect(source).not.toMatch(/from "\.\.\/(queries|aggregate|coverage|actions|fx|reader)"/);
  });

  it.each(AD_ANALYTICS)("%s reads no organic table", (path) => {
    expect(tableLiterals(read(path), SOCIAL_TABLES)).toEqual([]);
  });

  it.each(ORGANIC_V1)("%s uses the organic layer only", (path) => {
    const source = read(path);
    expect(source).not.toMatch(/analytics\/queries"|dto\/analytics"/);
    expect(source).not.toMatch(/providers\/(instagram|social\/mock|meta|google)|nodeRegistry/);
    expect(tableLiterals(source, AD_TABLES)).toEqual([]);
  });
});
