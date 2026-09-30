import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Phase 10 Stage B (B3): boundary of the organic Instagram dashboard. A SOURCE SCAN (a test,
// not an ESLint rule; the D23 ESLint allowlist already limits every frontend file to the
// generated api, convex/react and a few pure helpers). On top of D23 it proves:
// - the organic UI calls only the approved B2 v1 endpoints (plus connections for the shared
//   read-only reauth banner), never ad analytics, and the paid views never call organic ones;
// - no metric arithmetic on API values (values, rates and deltas come from the API);
// - no media, thumbnail or profile-picture URL and no image of a post is ever rendered.

const ROOT = process.cwd();

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    return statSync(join(ROOT, path)).isDirectory() ? walk(path) : [path];
  });
}

const isSource = (path: string) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path);

const ORGANIC_FILES = [
  ...walk("components/dashboard/organic"),
  ...walk("app/(dashboard)/social"),
  "components/dashboard/views/organic-view.tsx",
  "components/dashboard/views/social-post-detail-view.tsx",
  ...walk("lib/analytics").filter((path) => /\/(organic-[^/]+|permalink)\.ts$/.test(path)),
].filter(isSource);

const PAID_VIEWS = walk("components/dashboard/views")
  .filter(isSource)
  .filter((path) => !ORGANIC_FILES.includes(path));

const ORGANIC_ENDPOINT_MODULES = new Set([
  "socialAccounts",
  "socialPosts",
  "organicAnalytics",
  "connections",
]);
const ORGANIC_ONLY_MODULES = ["socialAccounts", "socialPosts", "organicAnalytics"];

const METRIC = String.raw`(?:reach|views|likes|comments|shares|saves|replies|totalInteractions|accountsEngaged|followers|followerDelta|profileLinksTaps|engagementRate)`;
/** A metric member access used as an arithmetic operand (either side). */
const ARITHMETIC = new RegExp(
  String.raw`\.${METRIC}\b\s*[-+*/%](?![/*=])|[-+*/%]\s*[\w.?]*\.${METRIC}\b`,
);

const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
/** Source without comments (so documentation may mention anything). */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("organic dashboard boundary", () => {
  it("scans the organic UI files", () => {
    expect(ORGANIC_FILES).toEqual(
      expect.arrayContaining([
        "app/(dashboard)/social/page.tsx",
        "app/(dashboard)/social/posts/[postId]/page.tsx",
        "components/dashboard/views/organic-view.tsx",
        "components/dashboard/organic/social-posts-table.tsx",
        "lib/analytics/organic-values.ts",
        "lib/analytics/permalink.ts",
      ]),
    );
    expect(PAID_VIEWS.length).toBeGreaterThan(3);
  });

  it.each(ORGANIC_FILES)("%s calls only the approved v1 endpoints", (path) => {
    const modules = [...code(path).matchAll(/\bapi\.v1\.(\w+)/g)].map((match) => match[1]);
    for (const name of modules) expect(ORGANIC_ENDPOINT_MODULES, name).toContain(name);
    expect(code(path)).not.toMatch(/\bapi\.(?!v1\.)\w+/);
    expect(code(path)).not.toMatch(/\binternal\./);
  });

  it.each(ORGANIC_FILES)("%s imports no provider, sync or table module", (path) => {
    const imports = [...code(path).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const specifier of imports) {
      expect(specifier).not.toMatch(
        /convex\/(providers|sync|tables|schema|connections|analytics\/(?!periods$))|social-sdk/,
      );
    }
  });

  it.each(ORGANIC_FILES)("%s does no metric arithmetic", (path) => {
    const lines = code(path).split("\n");
    const offending = lines.filter((line) => ARITHMETIC.test(line));
    expect(offending).toEqual([]);
  });

  it.each(ORGANIC_FILES)("%s renders no media URL and no post image", (path) => {
    const source = code(path);
    expect(source).not.toMatch(/mediaUrl|media_url|thumbnailUrl|thumbnail_url|profilePicture/i);
    expect(source).not.toMatch(/<img\b|next\/image/);
  });

  it.each(PAID_VIEWS)("paid view %s calls no organic endpoint", (path) => {
    for (const name of ORGANIC_ONLY_MODULES) {
      expect(code(path)).not.toContain(`api.v1.${name}`);
    }
  });

  it("the arithmetic probe detects metric arithmetic", () => {
    for (const sample of [
      "const rate = kpis.totalInteractions / metrics.reach;",
      "const total = a.views + b.views;",
      "const delta = now.followers - before.followers;",
      "const pct = value * row.engagementRate;",
    ]) {
      expect(ARITHMETIC.test(sample), sample).toBe(true);
    }
    for (const sample of [
      "const view = metrics.views;",
      'organicValueView("reach", aggregate, locale)',
      '{ metric: "views", reason: "not_reported" }',
    ]) {
      expect(ARITHMETIC.test(sample), sample).toBe(false);
    }
  });
});
