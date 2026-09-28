import { ESLint } from "eslint";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Phase 10: @opencoredev/social-sdk stays inside convex/providers/instagram/node/**, the
// node adapter is reachable only through the node registry, the node registry only from
// the "use node" social worker, and exactly those files run in Node.

const eslint = new ESLint({ cwd: process.cwd() });

async function restricted(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter(
    (m) =>
      m.ruleId === "no-restricted-imports" ||
      m.ruleId === "@typescript-eslint/no-restricted-imports",
  );
}

const SDK =
  'import { createSocial } from "@opencoredev/social-sdk";\nexport const x = createSocial;\n';
const SDK_IG =
  'import { instagram } from "@opencoredev/social-sdk/instagram";\nexport const x = instagram;\n';

describe("social-sdk import isolation (ESLint)", () => {
  it.each([
    "convex/connections/__fixture__.ts",
    "convex/sync/__fixture__.ts",
    "convex/sync/socialWorker.ts",
    "convex/v1/__fixture__.ts",
    "convex/analytics/__fixture__.ts",
    "convex/providers/__fixture__.ts",
    "convex/providers/social/__fixture__.ts",
    "convex/providers/social/nodeRegistry.ts",
    "convex/providers/instagram/__fixture__.ts",
    "convex/mapping/__fixture__.ts",
    "components/__fixture__.tsx",
    "lib/__fixture__.ts",
    "app/__fixture__.tsx",
    "convex/sync/__fixture__.test.ts",
  ])("%s may not import the SDK", async (filePath) => {
    expect((await restricted(SDK, filePath)).length).toBeGreaterThan(0);
    expect((await restricted(SDK_IG, filePath)).length).toBeGreaterThan(0);
  });

  it("the Instagram node adapter (and its tests) may", async () => {
    expect(await restricted(SDK, "convex/providers/instagram/node/__fixture__.ts")).toEqual([]);
    expect(await restricted(SDK_IG, "convex/providers/instagram/node/__fixture__.test.ts")).toEqual(
      [],
    );
  });

  it.each([
    [
      "convex/sync/__fixture__.ts",
      'import { createInstagramSocialProvider } from "../providers/instagram/node/provider";',
    ],
    [
      "convex/providers/instagram/__fixture__.ts",
      'import { createInstagramSdkSession } from "./node/sdk";',
    ],
    [
      "convex/providers/social/__fixture__.ts",
      'import { createInstagramSocialProvider } from "../instagram/node/provider";',
    ],
    [
      "convex/sync/socialWorker.ts",
      'import { createInstagramSocialProvider } from "../providers/instagram/node/provider";',
    ],
    [
      "convex/connections/__fixture__.ts",
      'import { socialProviderFor } from "../providers/social/nodeRegistry";',
    ],
    [
      "convex/providers/social/__fixture__.ts",
      'import { socialProviderFor } from "./nodeRegistry";',
    ],
    [
      "convex/sync/worker.ts",
      'import { socialProviderFor } from "../providers/social/nodeRegistry";',
    ],
    [
      "convex/v1/__fixture__.ts",
      'import { socialProviderFor } from "../providers/social/nodeRegistry";',
    ],
    [
      "convex/providers/instagram/node/__fixture__.ts",
      'import { socialProviderFor } from "../../social/nodeRegistry";',
    ],
  ])("%s rejects %s", async (filePath, source) => {
    expect((await restricted(`${source}\nexport {};\n`, filePath)).length).toBeGreaterThan(0);
  });

  it("allows exactly the approved chain: worker -> node registry -> node adapter", async () => {
    expect(
      await restricted(
        'import { socialProviderFor } from "../providers/social/nodeRegistry";\nexport {};\n',
        "convex/sync/socialWorker.ts",
      ),
    ).toEqual([]);
    expect(
      await restricted(
        'import { createInstagramSocialProvider } from "../instagram/node/provider";\nexport {};\n',
        "convex/providers/social/nodeRegistry.ts",
      ),
    ).toEqual([]);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "_generated" || name === "node_modules" ? [] : walk(path);
    }
    return /\.(ts|tsx|mts|js|mjs)$/.test(name) ? [path] : [];
  });
}

const posix = (path: string) => relative(process.cwd(), path).split(sep).join("/");

describe("Node runtime boundary (source scan)", () => {
  const convexFiles = walk(join(process.cwd(), "convex")).map((p) => ({
    path: posix(p),
    source: readFileSync(p, "utf8"),
  }));
  // Convex deploys only files with a single dot (like convex/test.setup.ts's module glob).
  const deployed = convexFiles.filter((f) => f.path.split("/").pop()!.split(".").length === 2);
  const NODE_FILES = new Set([
    "convex/providers/instagram/node/provider.ts",
    "convex/providers/instagram/node/sdk.ts",
    "convex/providers/social/nodeRegistry.ts",
    "convex/sync/socialWorker.ts",
  ]);

  it('exactly the social Node files are "use node" (first statement)', () => {
    const useNode = deployed
      .filter((f) => /^\s*(["'])use node\1;/.test(f.source))
      .map((f) => f.path)
      .sort();
    expect(useNode).toEqual([...NODE_FILES].sort());
  });

  it("only the Instagram node adapter imports the SDK", () => {
    const importers = convexFiles
      .filter((f) => /from\s+["']@opencoredev\/social-sdk/.test(f.source))
      .map((f) => f.path);
    expect(importers.length).toBeGreaterThan(0);
    for (const path of importers)
      expect(path.startsWith("convex/providers/instagram/node/")).toBe(true);
    for (const dir of ["app", "components", "lib"]) {
      for (const file of walk(join(process.cwd(), dir))) {
        expect(readFileSync(file, "utf8"), posix(file)).not.toMatch(/@opencoredev\/social-sdk/);
      }
    }
  });

  it("no default-runtime module imports a Node module", () => {
    for (const file of deployed) {
      if (NODE_FILES.has(file.path) || file.path.endsWith(".test.ts")) continue;
      expect(file.source, file.path).not.toMatch(
        /from\s+["'][^"']*(instagram\/node|nodeRegistry|socialWorker)["']/,
      );
    }
  });

  it("the SDK is pinned exactly to 0.5.0", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@opencoredev/social-sdk"]).toBe("0.5.0");
    const convexJson = JSON.parse(readFileSync(join(process.cwd(), "convex.json"), "utf8")) as {
      node: { nodeVersion: string };
    };
    expect(convexJson.node.nodeVersion).toBe("22");
  });
});
